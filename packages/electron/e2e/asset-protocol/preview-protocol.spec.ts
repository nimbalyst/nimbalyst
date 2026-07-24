/**
 * Issue #612: the `nim-preview://` protocol handler was only registered on the
 * default session, but BrowserSessionService runs its WebContentsViews in
 * custom partitions (`browser-preview` / `preview`). The scheme was therefore
 * unhandled where it mattered: blank pane on macOS/Linux, and on Windows
 * Chromium escalated the unknown scheme to the OS (Store popup).
 *
 * This spec drives the real browser-session IPC surface end-to-end: build a
 * preview URL for a workspace HTML file, load it in a partitioned headless
 * session, and assert the document actually rendered.
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createTempWorkspace, launchElectronApp, waitForAppReady } from '../helpers';
import { dismissAPIKeyDialog } from '../utils/testHelpers';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspacePath: string;

const MARKER = 'PREVIEW-PROTOCOL-E2E-612';

interface IpcResult {
  success: boolean;
  error?: string;
  url?: string;
  state?: { isLoading: boolean; lastError?: { code: number; description: string } };
  result?: unknown;
}

async function invoke(channel: string, payload: unknown): Promise<IpcResult> {
  return page.evaluate(
    async ({ channel, payload }) => {
      const api = (window as unknown as {
        electronAPI: { invoke: (ch: string, p: unknown) => Promise<unknown> };
      }).electronAPI;
      return (await api.invoke(channel, payload)) as never;
    },
    { channel, payload },
  );
}

test.beforeAll(async () => {
  workspacePath = await createTempWorkspace();
  // The page loads one page-relative and one root-relative script. The
  // root-relative one (`/root-rel.js`) drops the encoded-root URL prefix and
  // is only served through the protocol handler's Referer fallback.
  await fs.mkdir(path.join(workspacePath, 'site'), { recursive: true });
  await fs.writeFile(
    path.join(workspacePath, 'site', 'index.html'),
    `<!doctype html><html><head><title>${MARKER}</title>` +
      `<script src="page-rel.js"></script>` +
      `<script src="/root-rel.js"></script>` +
      `</head><body><h1 id="probe">${MARKER}</h1></body></html>`,
    'utf8',
  );
  await fs.writeFile(
    path.join(workspacePath, 'site', 'page-rel.js'),
    'window.__pageRelLoaded = true;',
    'utf8',
  );
  await fs.writeFile(
    path.join(workspacePath, 'root-rel.js'),
    'window.__rootRelLoaded = true;',
    'utf8',
  );
  execSync('git init', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git config user.name "Test User"', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git add .', { cwd: workspacePath, stdio: 'pipe' });
  execSync('git commit -m "initial"', { cwd: workspacePath, stdio: 'pipe' });

  electronApp = await launchElectronApp({
    workspace: workspacePath,
    permissionMode: 'allow-all',
  });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
  await dismissAPIKeyDialog(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
});

test('renders workspace HTML through nim-preview:// in a partitioned browser session', async () => {
  test.setTimeout(45_000);
  const built = await invoke('browser-session:build-preview-url', {
    filePath: path.join(workspacePath, 'site', 'index.html'),
    workspacePath,
  });
  expect(built.success, built.error).toBe(true);
  expect(built.url).toMatch(/^nim-preview:\/\//);

  const sessionId = 'e2e-preview-protocol-612';
  const created = await invoke('browser-session:create', {
    sessionId,
    url: built.url,
    // The HTML editor extension uses the `browser-preview` partition; loading
    // must work there, not just in the default session.
    partition: 'browser-preview',
    headless: true,
    viewport: { width: 640, height: 480 },
  });
  expect(created.success, created.error).toBe(true);

  // The session title only updates after a committed, successful load — an
  // unhandled scheme aborts navigation (errorCode -3, no lastError) and the
  // title stays empty, so polling on the title is the reliable signal. Do NOT
  // call evaluate before the title appears: executeJavaScript hangs forever on
  // a never-committed page, burning the whole test timeout on the red path.
  await expect
    .poll(
      async () => {
        const res = await invoke('browser-session:get-state', { sessionId });
        if (!res.state || res.state.isLoading) return null;
        if (res.state.lastError) return res.state;
        if (res.state.title !== MARKER) {
          // Committed but wrong content (e.g. a "Forbidden" body from the
          // protocol handler) — safe to read, and it makes the failure
          // message say what actually rendered.
          const body = await invoke('browser-session:evaluate', {
            sessionId,
            script: 'document.body.innerText',
          });
          return { ...res.state, body: String(body.result) };
        }
        return res.state;
      },
      { timeout: 15_000 },
    )
    .toMatchObject({ isLoading: false, title: MARKER });

  const state = await invoke('browser-session:get-state', { sessionId });
  expect(state.state?.lastError, JSON.stringify(state.state?.lastError)).toBeUndefined();

  // True end-to-end: the document body rendered from disk content, and both
  // asset resolution styles loaded their scripts.
  const text = await invoke('browser-session:evaluate', {
    sessionId,
    script:
      'JSON.stringify({ body: document.body.innerText, pageRel: window.__pageRelLoaded === true, rootRel: window.__rootRelLoaded === true })',
  });
  expect(text.success, text.error).toBe(true);
  const page = JSON.parse(String(text.result)) as {
    body: string;
    pageRel: boolean;
    rootRel: boolean;
  };
  expect(page.body).toContain(MARKER);
  expect(page.pageRel, 'page-relative script should load').toBe(true);
  expect(page.rootRel, 'root-relative script should load via Referer fallback').toBe(true);

  await invoke('browser-session:destroy', { sessionId });
});
