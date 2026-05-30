/**
 * Shared document revision history E2E test.
 *
 * Exercises the bootstrap -> manual save -> restore cycle end-to-end against
 * a real wrangler dev:
 *   1. Open a markdown collab doc with seed content `BOOTSTRAP_TEXT`.
 *   2. Wait for the auto-bootstrap revision to land server-side after
 *      sync reaches `connected`.
 *   3. Type new text into the editor, press Cmd/Ctrl+S to create a manual
 *      revision.
 *   4. Open the History dialog (Cmd/Ctrl+Y) -- it lists at least the
 *      bootstrap + manual revisions.
 *   5. Select the bootstrap revision and click Restore.
 *   6. Verify the editor reverts to `BOOTSTRAP_TEXT`.
 *
 * Requires: RUN_COLLAB_TESTS=1 and a nimbalyst-collab sibling repo.
 * Run with:
 *   RUN_COLLAB_TESTS=1 npx playwright test e2e/sync/shared-doc-history.spec.ts
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
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  dismissProjectTrustToast,
  TEST_TIMEOUTS,
} from '../helpers';
import { startWrangler, stopWrangler } from '../utils/wranglerHelpers';

test.describe.configure({ mode: 'serial' });

const WRANGLER_PORT = 8794;
const TEST_ORG_ID = 'e2e-doc-history-org';
const TEST_USER_ID = 'e2e-doc-history-user';
const BOOTSTRAP_TEXT = 'Bootstrap-only line.';
const MANUAL_ADDITION = 'Manual revision line.';

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;
let encryptionKeyBase64: string;
let docId: string;

async function generateKeyBase64(): Promise<string> {
  const key = await webcrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const raw = await webcrypto.subtle.exportKey('raw', key);
  return Buffer.from(raw).toString('base64');
}

async function openCollabMarkdown(page: Page, initialContent: string): Promise<void> {
  await page.evaluate(
    async ({ documentId, content, serverUrl, orgId, userId, keyBase64 }) => {
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
        initialContent: content,
        documentType: 'markdown',
        serverUrl,
        orgId,
        userId,
        encryptionKeyBase64: keyBase64,
        urlExtraQuery: `test_user_id=${encodeURIComponent(userId)}&test_org_id=${encodeURIComponent(orgId)}`,
      });
    },
    {
      documentId: docId,
      content: initialContent,
      serverUrl: `ws://localhost:${WRANGLER_PORT}`,
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      keyBase64: encryptionKeyBase64,
    },
  );
}

async function readEditorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.querySelector('.collaborative-tab-editor [contenteditable="true"]');
    return root?.textContent?.trim() ?? '';
  });
}

async function waitForEditorText(page: Page, needle: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await readEditorText(page);
    if (last.includes(needle)) return;
    await page.waitForTimeout(150);
  }
  throw new Error(`Timed out waiting for editor to contain "${needle}". Last seen: "${last}"`);
}

async function countRevisionsInDialog(page: Page): Promise<number> {
  return page.locator('[data-testid^="collab-revision-"]').count();
}

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);

  workspaceDir = await createTempWorkspace();
  encryptionKeyBase64 = await generateKeyBase64();
  docId = `history-spec-${Date.now()}.md`;

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
});

test.afterAll(async () => {
  await electronApp?.close();
  await stopWrangler();
  if (workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('bootstrap + manual save + restore cycle', async () => {
  // 1. Open the markdown collab doc with seed content.
  await openCollabMarkdown(page, BOOTSTRAP_TEXT);

  // 2. The editor mounts and shows the seeded text. This implicitly
  //    verifies the collab connection reached `connected` and the markdown
  //    branch published a history controller.
  await page.waitForSelector('.collaborative-tab-editor [contenteditable="true"]', {
    timeout: TEST_TIMEOUTS.EDITOR_LOAD,
  });
  await waitForEditorText(page, BOOTSTRAP_TEXT);

  // 3. Open the history dialog via Cmd/Ctrl+Y. The bootstrap revision is
  //    created asynchronously after `connected`; poll the dialog until it
  //    lists at least one entry rather than baking in a fixed delay.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+y' : 'Control+y');
  await page.waitForSelector('.collab-history-dialog', { timeout: 5_000 });

  await expect.poll(() => countRevisionsInDialog(page), {
    timeout: 15_000,
    message: 'Bootstrap revision never appeared in the History dialog',
  }).toBeGreaterThanOrEqual(1);

  const bootstrapRevisionId = await page
    .locator('[data-testid^="collab-revision-"]')
    .first()
    .getAttribute('data-testid');
  expect(bootstrapRevisionId).toBeTruthy();

  // Close the dialog so we can type into the editor.
  await page.keyboard.press('Escape');
  await page.waitForSelector('.collab-history-dialog', { state: 'detached', timeout: 5_000 });

  // 4. Edit content and trigger a manual save via Cmd/Ctrl+S.
  const editable = page.locator('.collaborative-tab-editor [contenteditable="true"]');
  await editable.click();
  // Move caret to end before typing so we don't overwrite the seed line.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(MANUAL_ADDITION);
  await waitForEditorText(page, MANUAL_ADDITION);

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');

  // 5. Reopen the history dialog; it should now list at least 2 revisions
  //    (bootstrap + manual). Poll because manual save is async.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+y' : 'Control+y');
  await page.waitForSelector('.collab-history-dialog', { timeout: 5_000 });

  await expect.poll(() => countRevisionsInDialog(page), {
    timeout: 15_000,
    message: 'Manual revision never appeared after Cmd/Ctrl+S',
  }).toBeGreaterThanOrEqual(2);

  // 6. Select the bootstrap revision (the LAST entry; list is newest-first)
  //    and restore.
  const items = page.locator('[data-testid^="collab-revision-"]');
  const itemCount = await items.count();
  expect(itemCount).toBeGreaterThanOrEqual(2);
  await items.nth(itemCount - 1).click();

  // Restore button is enabled only when sync state is `connected`; we
  // already verified the bootstrap landed which implies connected.
  const restoreBtn = page.locator('.history-restore-button');
  await expect(restoreBtn).toBeEnabled({ timeout: 10_000 });
  await restoreBtn.click();

  // Dialog closes on successful restore.
  await page.waitForSelector('.collab-history-dialog', { state: 'detached', timeout: 10_000 });

  // 7. The editor content should revert to the bootstrap text. The manual
  //    addition line should be gone.
  await waitForEditorText(page, BOOTSTRAP_TEXT);
  const finalText = await readEditorText(page);
  expect(finalText).toContain(BOOTSTRAP_TEXT);
  expect(finalText).not.toContain(MANUAL_ADDITION);
});
