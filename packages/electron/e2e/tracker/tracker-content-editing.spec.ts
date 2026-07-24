/**
 * Tracker content editing E2E tests.
 *
 * Tests the rich content (Lexical) editor in the tracker detail panel:
 * - Type content into a native bug's content editor
 * - Close and reopen the detail panel
 * - Verify content persisted to PGLite
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
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
import * as fs from 'fs/promises';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;
let itemId: string;

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  electronApp = await launchElectronApp({ workspace: workspaceDir, permissionMode: 'allow-all' });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await dismissAPIKeyDialog(page);
  await waitForWorkspaceReady(page);
});

test.afterAll(async () => {
  await electronApp?.close();
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
  await quickAddInput.fill('Content Persistence Test');
  await quickAddInput.press('Enter');

  const newRow = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerTableRow, { hasText: 'Content Persistence Test' });
  await expect(newRow).toBeVisible({ timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 6 });

  itemId = (await newRow.getAttribute('data-item-id'))!;
  expect(itemId).toBeTruthy();

  await newRow.locator('.tracker-table-cell.title').click();
  await page.waitForTimeout(300);

  const detailPanel = page.locator('.tracker-item-detail');
  await detailPanel.waitFor({ state: 'visible', timeout: 5000 });
});

test('should type content into the Lexical editor and have it persist', async () => {
  const detailPanel = page.locator('.tracker-item-detail');
  await detailPanel.waitFor({ state: 'visible', timeout: 3000 });

  const contentEditor = page.locator('[data-testid="tracker-detail-content-editor"]');
  await expect(contentEditor).toBeVisible({ timeout: 5000 });

  // The Lexical editor's contenteditable div
  const editable = contentEditor.locator('[contenteditable="true"]');
  await expect(editable).toBeVisible({ timeout: 3000 });

  // Click into the editor and type
  await editable.click();
  await page.keyboard.type('Hello from the E2E test');

  // Wait for debounced save (800ms) + buffer
  await page.waitForTimeout(1500);

  // Verify the text is visible in the editor
  await expect(editable).toContainText('Hello from the E2E test');

  // Close the detail panel
  await page.keyboard.press('Escape');
  await expect(detailPanel).not.toBeVisible({ timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });
});

test('should show persisted content when reopening the item', async () => {
  // Reopen the same item
  const rowById = page.locator(`[data-item-id="${itemId}"]`);
  await expect(rowById).toBeVisible({ timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });
  await rowById.locator('.tracker-table-cell.title').click();
  await page.waitForTimeout(300);

  const detailPanel = page.locator('.tracker-item-detail');
  await detailPanel.waitFor({ state: 'visible', timeout: 5000 });

  const contentEditor = page.locator('[data-testid="tracker-detail-content-editor"]');
  await expect(contentEditor).toBeVisible({ timeout: 5000 });

  const editable = contentEditor.locator('[contenteditable="true"]');
  await expect(editable).toBeVisible({ timeout: 3000 });

  // Content should have persisted through close/reopen
  await expect(editable).toContainText('Hello from the E2E test', { timeout: 5000 });
});

test('should not lose content while typing rapidly', async () => {
  const contentEditor = page.locator('[data-testid="tracker-detail-content-editor"]');
  const editable = contentEditor.locator('[contenteditable="true"]');

  // Select all existing content and replace
  await editable.click();
  await page.keyboard.press('Meta+a');
  await page.keyboard.type('Line one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Line two');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Line three');

  // Wait a moment for React to settle
  await page.waitForTimeout(500);

  // All three lines should be visible (no vanishing text)
  await expect(editable).toContainText('Line one');
  await expect(editable).toContainText('Line two');
  await expect(editable).toContainText('Line three');

  // Wait for debounced save
  await page.waitForTimeout(1500);

  // Close and reopen to verify persistence of multi-line content
  await page.keyboard.press('Escape');
  const detailPanel = page.locator('.tracker-item-detail');
  await expect(detailPanel).not.toBeVisible({ timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });

  const rowById = page.locator(`[data-item-id="${itemId}"]`);
  await rowById.locator('.tracker-table-cell.title').click();
  await page.waitForTimeout(300);
  await detailPanel.waitFor({ state: 'visible', timeout: 5000 });

  const editableAfter = page.locator('[data-testid="tracker-detail-content-editor"] [contenteditable="true"]');
  await expect(editableAfter).toBeVisible({ timeout: 3000 });
  await expect(editableAfter).toContainText('Line one', { timeout: 5000 });
  await expect(editableAfter).toContainText('Line two');
  await expect(editableAfter).toContainText('Line three');
});
