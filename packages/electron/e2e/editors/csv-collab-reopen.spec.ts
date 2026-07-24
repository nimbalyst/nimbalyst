/**
 * CSV collab reopen regression test.
 *
 * Reproduces the bug where a CSV file shared to team via collab:
 *   1. shows data on first open (initialContent path), then
 *   2. comes back blank on close + reopen (Y.Doc sync path).
 *
 * The test:
 *   - starts wrangler dev so the collab doc actually round-trips through
 *     the server,
 *   - monkey-patches `documentSync.open` and `documentSync.getJwt` so the
 *     renderer talks to the local wrangler without Stytch auth,
 *   - uses the dev-only `window.__openCollabDoc` helper (extended to accept
 *     initialContent) to drive the share + reopen flow without going through
 *     the file-tree context menu (which would also need team-detection state).
 *
 * Requires: RUN_COLLAB_TESTS=1 and a nimbalyst-collab sibling repo.
 * Run with:
 *   RUN_COLLAB_TESTS=1 npx playwright test e2e/editors/csv-collab-reopen.spec.ts
 *
 * IMPORTANT: do NOT batch this spec with another file in the same
 * `npx playwright test` invocation -- each spec launches its own Electron
 * instance and they fight over the PGLite database lock.
 */

import { test, expect } from '@playwright/test';
test.skip(() => !process.env.RUN_COLLAB_TESTS, 'Requires RUN_COLLAB_TESTS=1 and wrangler dev');
import type { ElectronApplication, Page } from '@playwright/test';
import { webcrypto } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  dismissProjectTrustToast,
  TEST_TIMEOUTS,
} from '../helpers';
import { startWrangler, stopWrangler } from '../utils/wranglerHelpers';

test.describe.configure({ mode: 'serial' });

const WRANGLER_PORT = 8793;
const TEST_ORG_ID = 'e2e-csv-collab-org';
const TEST_USER_ID = 'e2e-csv-collab-user';
const CSV_DOC_ID = 'demo.csv';
const CSV_CONTENT = 'Name,Value\nAlice,100\nBob,200\nCarol,300\n';

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;
let encryptionKeyBase64: string;

async function generateKeyBase64(): Promise<string> {
  const key = await webcrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const raw = await webcrypto.subtle.exportKey('raw', key);
  return Buffer.from(raw).toString('base64');
}

/**
 * Read the visible grid's data-cell text content via the DOM. Returns the
 * first non-empty value found, or null. Use this instead of waiting for a
 * specific cell index — RevoGrid renders extra buffer rows/columns we don't
 * want to assert on.
 */
async function getVisibleCellTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const cells = document.querySelectorAll('revogr-data [role="gridcell"]');
    const out: string[] = [];
    cells.forEach((cell) => {
      const text = (cell as HTMLElement).textContent?.trim();
      if (text) out.push(text);
    });
    return out;
  });
}

async function waitForCsvGridText(page: Page, expected: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen: string[] = [];
  while (Date.now() < deadline) {
    lastSeen = await getVisibleCellTexts(page);
    if (lastSeen.includes(expected)) return;
    await page.waitForTimeout(200);
  }
  throw new Error(
    `Timed out waiting for CSV cell containing "${expected}". Visible cells: ${JSON.stringify(lastSeen)}`,
  );
}

async function openCollabCsv(page: Page, opts: { initialContent?: string }): Promise<void> {
  await page.evaluate(
    async ({ documentId, initialContent, serverUrl, orgId, userId, keyBase64 }) => {
      // Wait for the dev/test helper to register (EditorMode mounts it on
      // workspace ready). It can take a beat in StrictMode.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (typeof (window as any).__openCollabDocTest === 'function') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const fn = (window as any).__openCollabDocTest;
      if (typeof fn !== 'function') {
        throw new Error('__openCollabDocTest helper not registered');
      }
      await fn({
        documentId,
        title: documentId,
        initialContent,
        documentType: 'csv',
        serverUrl,
        orgId,
        userId,
        encryptionKeyBase64: keyBase64,
        urlExtraQuery: `test_user_id=${encodeURIComponent(userId)}&test_org_id=${encodeURIComponent(orgId)}`,
      });
    },
    {
      documentId: CSV_DOC_ID,
      initialContent: opts.initialContent,
      serverUrl: `ws://localhost:${WRANGLER_PORT}`,
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      keyBase64: encryptionKeyBase64,
    },
  );
}

async function closeCurrentTab(page: Page): Promise<void> {
  // Tabs in EditorMode use a close button next to the title.
  const closeBtn = page.locator('.tab.active .tab-close-button').first();
  await closeBtn.click({ timeout: 3000 });
  await page.waitForTimeout(300);
}

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(90_000);

  workspaceDir = await createTempWorkspace();
  encryptionKeyBase64 = await generateKeyBase64();

  await startWrangler(WRANGLER_PORT);

  electronApp = await launchElectronApp({
    workspace: workspaceDir,
    permissionMode: 'allow-all',
    env: { NIMBALYST_RELEASE_CHANNEL: 'alpha' },
  });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);
  await dismissProjectTrustToast(page);

  // We open the collab doc via the test-only `__openCollabDocTest` window
  // helper (registered by EditorMode in DEV mode). That helper goes through
  // the `document-sync:open-test` IPC + the standard `openCollabDocument` +
  // `createProxiedWebSocket` plumbing, but lets us inject the wrangler
  // `test_user_id` / `test_org_id` query params via `urlExtraQuery`.
  // contextBridge prevents monkey-patching `documentSync.open` directly with
  // contextIsolation enabled, which is why we go through this helper.
});

test.afterAll(async () => {
  await electronApp?.close();
  await stopWrangler();
  if (workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('CSV collab doc content survives close and reopen', async () => {
  // 1. First share: open the collab doc with initialContent. The recipient
  //    of this open is the first writer; the SDK hook will seed the Y.Doc
  //    from initialContent and flush to wrangler.
  await openCollabCsv(page, { initialContent: CSV_CONTENT });

  // 2. Grid mounts and shows the seeded data.
  await page.waitForSelector('revo-grid', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await waitForCsvGridText(page, 'Alice');

  // 3. Give Yjs a real beat to round-trip the update to wrangler and receive
  //    the ack. Without this, the close-tab path persists the still-in-flight
  //    update locally instead of trusting the server, and we don't actually
  //    test the snapshot-from-server reopen path.
  await page.waitForTimeout(2000);

  const cellsBeforeClose = await getVisibleCellTexts(page);
  console.log('[test] cells before close:', cellsBeforeClose);

  // 4. Close the tab.
  await closeCurrentTab(page);

  // 4a. Verify the tab is actually closed: revo-grid should be gone from DOM.
  const gridCountAfterClose = await page.locator('revo-grid').count();
  console.log('[test] revo-grid count after close:', gridCountAfterClose);
  expect(gridCountAfterClose).toBe(0);

  // Also dump visible cells to confirm no stale grid data.
  const cellsAfterClose = await getVisibleCellTexts(page);
  console.log('[test] cells after close:', cellsAfterClose);

  // 5. Reopen WITHOUT initialContent. This is the recipient/reopen path:
  //    the Y.Doc starts empty, sync response from wrangler populates it.
  await openCollabCsv(page, {});

  // 6. The grid should display the content from the server.
  await page.waitForSelector('revo-grid', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  // 6a. Immediate snapshot before any wait — what's visible right after mount?
  await page.waitForTimeout(100);
  const cellsImmediate = await getVisibleCellTexts(page);
  console.log('[test] cells immediately after reopen:', cellsImmediate);

  await waitForCsvGridText(page, 'Alice');
  await waitForCsvGridText(page, 'Bob');
  await waitForCsvGridText(page, 'Carol');

  const cells = await getVisibleCellTexts(page);
  console.log('[test] final cells:', cells);
  expect(cells).toContain('Alice');
  expect(cells).toContain('Bob');
  expect(cells).toContain('Carol');
});
