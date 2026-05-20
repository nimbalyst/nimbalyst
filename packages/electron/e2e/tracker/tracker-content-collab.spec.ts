/**
 * Collaborative tracker content editing E2E test.
 *
 * Tests the full CollaborationPlugin path in TrackerItemDetail:
 * - Native bug created with PGLite content
 * - Collaborative editor bootstraps from PGLite content
 * - User types in the collaborative editor
 * - Content persists to PGLite (via onDirtyChange/saveContent)
 * - Close and reopen verifies persistence
 * - `tracker_body_cache` has a row at the latest body_version
 *   (Limitation 2 regression guard)
 *
 * Requires: wrangler dev on port 8792 (started by this test)
 * Run with: RUN_COLLAB_TESTS=1 npx playwright test e2e/tracker/tracker-content-collab.spec.ts
 *
 * IMPORTANT: do NOT batch this spec with another file in the same
 * `npx playwright test` invocation -- each spec launches its own
 * Electron instance and they fight over the PGLite database lock. Run
 * one at a time.
 */

import { test, expect } from '@playwright/test';
test.skip(() => !process.env.RUN_COLLAB_TESTS, 'Requires RUN_COLLAB_TESTS=1 and wrangler dev');
import type { ElectronApplication, Page } from '@playwright/test';
import { webcrypto } from 'crypto';
import {
  launchElectronApp,
  createTempWorkspace,
  TEST_TIMEOUTS,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  dismissAPIKeyDialog,
  waitForWorkspaceReady,
} from '../utils/testHelpers';
import { startWrangler, stopWrangler } from '../utils/wranglerHelpers';
import * as fs from 'fs/promises';

test.describe.configure({ mode: 'serial' });

const WRANGLER_PORT = 8792;
const TEST_ORG_ID = 'e2e-collab-content-org';
const TEST_USER_ID = 'e2e-collab-user-a';

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;
let itemId: string;
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

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(90_000);

  workspaceDir = await createTempWorkspace();
  encryptionKeyBase64 = await generateKeyBase64();

  await startWrangler(WRANGLER_PORT);

  electronApp = await launchElectronApp({ workspace: workspaceDir, permissionMode: 'allow-all' });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await dismissAPIKeyDialog(page);
  await waitForWorkspaceReady(page);

  // Monkey-patch documentSync.open in the renderer to use the test handler.
  // This bypasses Stytch auth and connects directly to wrangler dev. The
  // `document-sync:open-test` channel is registered by `DocumentSyncHandlers`
  // when `process.env.PLAYWRIGHT === '1'` -- the same gate that protects
  // the resurrected `tracker-sync:connect-test` in the sibling spec.
  await page.evaluate(
    ({ orgId, userId, serverUrl, keyBase64 }) => {
      (window as any).electronAPI.documentSync.open = async (
        _workspacePath: string,
        documentId: string,
        title?: string,
      ) => {
        return (window as any).electronAPI.invoke('document-sync:open-test', {
          serverUrl,
          orgId,
          userId,
          documentId,
          title,
          encryptionKeyBase64: keyBase64,
        });
      };
      (window as any).electronAPI.documentSync.getJwt = async () => ({
        success: true,
        jwt: 'test-jwt',
      });
    },
    {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      serverUrl: `ws://localhost:${WRANGLER_PORT}`,
      keyBase64: encryptionKeyBase64,
    },
  );

  // Force the bug tracker model into team sync mode so contentMode flips
  // to 'collaborative' and the collab editor mounts.
  await page.evaluate(() => {
    const runtime = (window as any).__nimbalystRuntime;
    if (runtime?.trackerRegistry) {
      const bugModel = runtime.trackerRegistry.get('bug');
      if (bugModel) {
        bugModel.sync = { mode: 'team', projectId: 'test-project' };
      }
    }
  });
});

test.afterAll(async () => {
  await electronApp?.close();
  await stopWrangler();
  if (workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('should create a native bug and open detail panel', async () => {
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerModeButton).click();

  const trackerSidebar = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerSidebar);
  await trackerSidebar.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });

  const bugsButton = page.locator(`${PLAYWRIGHT_TEST_SELECTORS.trackerTypeButton}[data-tracker-type="bug"]`);
  await bugsButton.click();

  const trackerTable = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerTable);
  await trackerTable.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });

  await page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerToolbarNewButton).click();

  const quickAddInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerQuickAddInput);
  await quickAddInput.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });
  await quickAddInput.fill('Collab Content Test');
  await quickAddInput.press('Enter');

  const newRow = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerTableRow, { hasText: 'Collab Content Test' });
  await expect(newRow).toBeVisible({ timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 6 });

  itemId = (await newRow.getAttribute('data-item-id'))!;
  expect(itemId).toBeTruthy();

  await newRow.locator('.tracker-table-cell.title').click();
  await page.waitForTimeout(300);

  const detailPanel = page.locator('.tracker-item-detail');
  await detailPanel.waitFor({ state: 'visible', timeout: 5000 });
});

test('should render content editor and accept input in collaborative mode', async () => {
  const detailPanel = page.locator('.tracker-item-detail');
  await detailPanel.waitFor({ state: 'visible', timeout: 3000 });

  const contentEditor = page.locator('[data-testid="tracker-detail-content-editor"]');
  await expect(contentEditor).toBeVisible({ timeout: 10_000 });

  const editable = contentEditor.locator('[contenteditable="true"]');
  await expect(editable).toBeVisible({ timeout: 5000 });

  await editable.click();
  await page.keyboard.type('Collaborative content test');

  // Wait for debounced save.
  await page.waitForTimeout(1500);

  await expect(editable).toContainText('Collaborative content test');
});

test('should write a tracker_body_cache row after typing (Limitation 2 regression guard)', async () => {
  // Drives the producer side of the cold-instant body read. The new
  // `document-service:get-tracker-body-cache-for-detail` IPC is the
  // reader; if that fails because the cache table is empty the cold-open
  // optimistic paint silently falls back to the legacy `tracker_items.content`
  // path and the regression goes unnoticed.
  const row = await page.evaluate(async (id) => {
    return (window as any).electronAPI.documentService.getTrackerBodyCacheForDetail({ itemId: id });
  }, itemId);
  expect(row?.success).toBe(true);
  expect(row?.row).toBeTruthy();
  expect(row?.row?.bodyVersion).toBeGreaterThan(0);
  // Content stored is a markdown string (or a JSON-wrapped string).
  const content = typeof row.row.content === 'string' ? row.row.content : row.row.content?.markdown;
  expect(content).toContain('Collaborative content test');
});

test('should persist content through close and reopen', async () => {
  await page.keyboard.press('Escape');
  const detailPanel = page.locator('.tracker-item-detail');
  await expect(detailPanel).not.toBeVisible({ timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });

  const rowById = page.locator(`[data-item-id="${itemId}"]`);
  await expect(rowById).toBeVisible({ timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });
  await rowById.locator('.tracker-table-cell.title').click();
  await page.waitForTimeout(300);
  await detailPanel.waitFor({ state: 'visible', timeout: 5000 });

  const contentEditor = page.locator('[data-testid="tracker-detail-content-editor"]');
  await expect(contentEditor).toBeVisible({ timeout: 10_000 });

  const editable = contentEditor.locator('[contenteditable="true"]');
  await expect(editable).toBeVisible({ timeout: 5000 });

  await expect(editable).toContainText('Collaborative content test', { timeout: 5000 });
});
