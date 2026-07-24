/**
 * Tracker item editing E2E tests.
 *
 * Tests the detail panel editing workflow for native (database-stored) tracker items:
 * - Creating a new native bug via the "+ New" toolbar button
 * - Verifying the "Database" source badge
 * - Editing title (debounced), status (CustomSelect), priority (CustomSelect), owner (text input)
 * - Closing and re-opening to verify all edits persisted
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

test('should edit native tracker item fields in detail panel', async () => {
  // --- Navigate to Tracker mode ---
  // Click the nav gutter button directly (keyboard shortcut is platform-specific: Meta on macOS, Ctrl on Linux)
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerModeButton).click();

  const trackerSidebar = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerSidebar);
  await trackerSidebar.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });

  // --- Select Bugs type ---
  const bugsButton = page.locator(`${PLAYWRIGHT_TEST_SELECTORS.trackerTypeButton}[data-tracker-type="bug"]`);
  await bugsButton.click();

  const trackerTable = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerTable);
  await trackerTable.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });

  // --- Create a new native bug via toolbar "+ New" button ---
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerToolbarNewButton).click();

  const quickAddInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerQuickAddInput);
  await quickAddInput.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });
  await quickAddInput.fill('Test Bug For Editing');
  await quickAddInput.press('Enter');

  // Wait for the new row to appear in the table
  const newRow = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerTableRow, { hasText: 'Test Bug For Editing' });
  await expect(newRow).toBeVisible({ timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 6 });

  // Save item ID for re-finding the row after title changes
  const itemId = await newRow.getAttribute('data-item-id');
  expect(itemId).toBeTruthy();

  // --- Open detail panel ---
  // Click the title cell specifically: the status/priority cells have e.stopPropagation()
  // which prevents the row onClick (onItemSelect) from firing if Playwright hits them.
  await newRow.locator('.tracker-table-cell.title').click();
  // Brief wait for atom update to propagate (onItemSelect → selectedItemId → render)
  await page.waitForTimeout(300);

  const detailPanel = page.locator('.tracker-item-detail');
  await detailPanel.waitFor({ state: 'visible', timeout: 5000 });

  // --- Verify the "Database" source badge is shown ---
  // Wait for item to load in atom (badge only appears when item is not null)
  const dbBadge = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerSourceDbBadge).first();
  await expect(dbBadge).toBeVisible({ timeout: 3000 });

  // --- Edit the title ---
  const titleInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerDetailTitle);
  await titleInput.click();
  await titleInput.selectText();
  await titleInput.fill('Updated Bug Title');

  // Wait for debounce (500ms) + buffer
  await page.waitForTimeout(700);

  // --- Change status via CustomSelect (first .custom-select-trigger in detail panel = status) ---
  const selectTriggers = detailPanel.locator(PLAYWRIGHT_TEST_SELECTORS.customSelectTrigger);
  await selectTriggers.first().click();

  // Options are rendered via FloatingPortal at document root — target by label text
  const inProgressOption = page.locator(PLAYWRIGHT_TEST_SELECTORS.customSelectOption, { hasText: 'In Progress' });
  await inProgressOption.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });
  await inProgressOption.click();

  // --- Change priority via second CustomSelect ---
  await selectTriggers.nth(1).click();

  const highOption = page.locator(PLAYWRIGHT_TEST_SELECTORS.customSelectOption, { hasText: 'High' });
  await highOption.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });
  await highOption.click();

  // --- Edit owner (text input, id="field-owner") ---
  const ownerInput = detailPanel.locator('#field-owner');
  await ownerInput.click();
  await ownerInput.fill('testuser');

  // Wait for debounce to fire for both title and owner
  await page.waitForTimeout(700);

  // --- Close detail panel ---
  await page.keyboard.press('Escape');
  await expect(detailPanel).not.toBeVisible({ timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });

  // --- Re-open the same item by data-item-id (title has changed, can't use hasText) ---
  const rowById = page.locator(`[data-item-id="${itemId}"]`);
  await expect(rowById).toBeVisible({ timeout: TEST_TIMEOUTS.DEFAULT_WAIT * 4 });
  await rowById.locator('.tracker-table-cell.title').click();
  await page.waitForTimeout(300);
  await detailPanel.waitFor({ state: 'visible', timeout: 5000 });

  // --- Verify title was persisted ---
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.trackerDetailTitle)).toHaveValue('Updated Bug Title');

  // --- Verify status was persisted (first CustomSelect shows "In Progress") ---
  const statusValue = detailPanel.locator(PLAYWRIGHT_TEST_SELECTORS.customSelectTrigger).first()
    .locator(PLAYWRIGHT_TEST_SELECTORS.customSelectValue);
  await expect(statusValue).toContainText('In Progress');

  // --- Verify priority was persisted (second CustomSelect shows "High") ---
  const priorityValue = detailPanel.locator(PLAYWRIGHT_TEST_SELECTORS.customSelectTrigger).nth(1)
    .locator(PLAYWRIGHT_TEST_SELECTORS.customSelectValue);
  await expect(priorityValue).toContainText('High');

  // --- Verify owner was persisted ---
  await expect(detailPanel.locator('#field-owner')).toHaveValue('testuser');
});
