/**
 * Renderer-headless re-upload regression test (NIM-1529 workstream).
 *
 * Exercises the `tryRendererHeadlessReupload` path in useCollabLocalOrigin --
 * the route external structured editors (mindmap) take when the main-process
 * adapter reports 'unsupported'. It must:
 *   - read the CURRENT shared content through the renderer codec BEFORE
 *     writing (read-before-write),
 *   - detect noop / missing-baseline / shared-ahead / diverged against the
 *     saved local-origin baselines,
 *   - only overwrite when clean or explicitly forced,
 *   - refresh the saved baselines after a confirmed write.
 *
 * All room I/O goes through a real local wrangler dev server, so the write is
 * verified as server-persisted (flush-with-ack), not just applied locally.
 *
 * Requires: RUN_COLLAB_TESTS=1 and a nimbalyst-collab sibling repo.
 * Run with:
 *   RUN_COLLAB_TESTS=1 npx playwright test e2e/sync/collab-reupload.spec.ts
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
} from '../helpers';
import { startWrangler, stopWrangler } from '../utils/wranglerHelpers';

test.describe.configure({ mode: 'serial' });

const WRANGLER_PORT = 8793;
const TEST_ORG_ID = 'e2e-reupload-org';
const TEST_USER_ID = 'e2e-reupload-user';
// Unique per run so stale local wrangler DO state (rows written under a
// previous dev boot's ephemeral DEK) can never poison the room.
const DOC_ID = `reupload-${Date.now()}.csv`;

const FILE_A = 'Name,Value\nAlice,100\nBob,200\n';
const FILE_B = 'Name,Value\nAlice,111\nBob,222\nZed,999\n';
const FILE_B2 = 'Name,Value\nAlice,111\nBob,222\nZed,999\nLocal,42\n';
const REMOTE_C = 'Name,Value\nRemote,777\n';

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;
let encryptionKeyBase64: string;
let sourceFilePath: string;

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
 * Saved-baseline state the test tracks itself. In production these live in the
 * local-origin DB row (team-keyed); the harness has no team, so the test
 * mirrors the hook's own baseline bookkeeping: after every confirmed upload
 * BOTH baselines equal the sha-256 of the uploaded file content (matching the
 * hook's saveLocalOrigin call).
 */
let baselines: { local: string | null; collab: string | null } = { local: null, collab: null };

function sha256Hex(value: string): Promise<string> {
  return webcrypto.subtle
    .digest('SHA-256', new TextEncoder().encode(value))
    .then((d) => Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join(''));
}

async function setBaselinesFromUpload(content: string): Promise<void> {
  const hash = await sha256Hex(content);
  baselines = { local: hash, collab: hash };
}

/** Drive the renderer-headless re-upload through the dev-only window helper. */
async function reupload(force = false): Promise<any> {
  return page.evaluate(
    async ({ documentId, documentType, sourceFilePath, force, lastLocalContentHash, lastCollabContentHash }) => {
      return await (window as any).__reuploadCollabDocTest({
        documentId,
        documentType,
        sourceFilePath,
        force,
        lastLocalContentHash,
        lastCollabContentHash,
      });
    },
    {
      documentId: DOC_ID,
      documentType: 'csv',
      sourceFilePath,
      force,
      lastLocalContentHash: baselines.local,
      lastCollabContentHash: baselines.collab,
    },
  );
}

/** Read the current shared-room content via the renderer codec (headless). */
async function exportRoom(): Promise<string> {
  const result = await page.evaluate(
    async ({ documentId, documentType }) => {
      return await (window as any).__exportCollabDocTest({ documentId, documentType });
    },
    { documentId: DOC_ID, documentType: 'csv' },
  );
  expect(result.ok, `export failed: ${result.error}`).toBe(true);
  return result.content as string;
}

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(90_000);

  workspaceDir = await createTempWorkspace();
  encryptionKeyBase64 = await generateKeyBase64();
  sourceFilePath = path.join(workspaceDir, DOC_ID);
  await fs.writeFile(sourceFilePath, FILE_A, 'utf8');

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

  // Register the room config (no tab) so the headless seed/export/re-upload
  // passes can resolve a connection, then seed the room with FILE_A.
  await page.evaluate(
    async ({ documentId, serverUrl, orgId, userId, keyBase64 }) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (typeof (window as any).__registerCollabConfigTest === 'function') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await (window as any).__registerCollabConfigTest({
        documentId,
        documentType: 'csv',
        serverUrl,
        orgId,
        userId,
        encryptionKeyBase64: keyBase64,
        urlExtraQuery: `test_user_id=${encodeURIComponent(userId)}&test_org_id=${encodeURIComponent(orgId)}`,
      });
    },
    {
      documentId: DOC_ID,
      serverUrl: `ws://localhost:${WRANGLER_PORT}`,
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      keyBase64: encryptionKeyBase64,
    },
  );
});

test.afterAll(async () => {
  await electronApp?.close();
  await stopWrangler();
  if (workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('re-upload: missing-baseline conflict, forced upload, baseline refresh', async () => {
  // Seed the room so it is non-empty before any re-upload runs.
  const seed = await page.evaluate(
    async ({ documentId, content }) => {
      return await (window as any).__writeCollabDocTest({
        documentId,
        documentType: 'csv',
        content,
      });
    },
    { documentId: DOC_ID, content: FILE_A },
  );
  expect(seed.ok, `seed failed: ${seed.error}`).toBe(true);

  // No saved local-origin baseline exists yet -> conflict, no write.
  const first = await reupload(false);
  expect(first.status).toBe('conflict');
  expect(first.conflictKind).toBe('missing-baseline');
  expect(await exportRoom()).toBe(FILE_A);

  // Forcing writes the local file and saves fresh baselines.
  const forced = await reupload(true);
  expect(forced.status, JSON.stringify(forced)).toBe('uploaded');
  expect(await exportRoom()).toBe(FILE_A);
  await setBaselinesFromUpload(FILE_A);
});

test('re-upload: noop when local and shared both match the baseline', async () => {
  const result = await reupload(false);
  expect(result.status, JSON.stringify(result)).toBe('noop');
  expect(await exportRoom()).toBe(FILE_A);
});

test('re-upload: clean local change uploads without a conflict prompt', async () => {
  await fs.writeFile(sourceFilePath, FILE_B, 'utf8');

  const result = await reupload(false);
  expect(result.status, JSON.stringify(result)).toBe('uploaded');
  expect(await exportRoom()).toBe(FILE_B);
  await setBaselinesFromUpload(FILE_B);

  // And it settles: an immediate re-run is a noop against the new baselines.
  const again = await reupload(false);
  expect(again.status, JSON.stringify(again)).toBe('noop');
});

test('re-upload: shared-ahead and diverged conflicts, then forced overwrite', async () => {
  // Simulate a teammate changing the shared doc (baselines still = FILE_B).
  const remote = await page.evaluate(
    async ({ documentId, content }) => {
      return await (window as any).__writeCollabDocTest({
        documentId,
        documentType: 'csv',
        content,
      });
    },
    { documentId: DOC_ID, content: REMOTE_C },
  );
  expect(remote.ok, `remote write failed: ${remote.error}`).toBe(true);

  // Local unchanged, shared moved -> shared-ahead; nothing written.
  const sharedAhead = await reupload(false);
  expect(sharedAhead.status).toBe('conflict');
  expect(sharedAhead.conflictKind).toBe('shared-ahead');
  expect(await exportRoom()).toBe(REMOTE_C);

  // Local ALSO changed -> diverged; still nothing written.
  await fs.writeFile(sourceFilePath, FILE_B2, 'utf8');
  const diverged = await reupload(false);
  expect(diverged.status).toBe('conflict');
  expect(diverged.conflictKind).toBe('diverged');
  expect(await exportRoom()).toBe(REMOTE_C);

  // Forced overwrite pushes the local file and re-baselines.
  const forced = await reupload(true);
  expect(forced.status, JSON.stringify(forced)).toBe('uploaded');
  expect(await exportRoom()).toBe(FILE_B2);
  await setBaselinesFromUpload(FILE_B2);

  const settled = await reupload(false);
  expect(settled.status, JSON.stringify(settled)).toBe('noop');
});

test('re-uploaded content renders in the editor (user-visible check)', async () => {
  await page.evaluate(
    async ({ documentId, serverUrl, orgId, userId, keyBase64 }) => {
      await (window as any).__openCollabDocTest({
        documentId,
        documentType: 'csv',
        serverUrl,
        orgId,
        userId,
        encryptionKeyBase64: keyBase64,
        urlExtraQuery: `test_user_id=${encodeURIComponent(userId)}&test_org_id=${encodeURIComponent(orgId)}`,
      });
    },
    {
      documentId: DOC_ID,
      serverUrl: `ws://localhost:${WRANGLER_PORT}`,
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      keyBase64: encryptionKeyBase64,
    },
  );

  await page.waitForSelector('revo-grid', { timeout: 15_000 });

  const deadline = Date.now() + 10_000;
  let cells: string[] = [];
  while (Date.now() < deadline) {
    cells = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll('revogr-data [role="gridcell"]').forEach((cell) => {
        const text = (cell as HTMLElement).textContent?.trim();
        if (text) out.push(text);
      });
      return out;
    });
    if (cells.includes('Local')) break;
    await page.waitForTimeout(200);
  }
  expect(cells).toContain('Local');
  expect(cells).toContain('42');
});
