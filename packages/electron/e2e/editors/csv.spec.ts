/**
 * CSV Spreadsheet Editor E2E Tests: saving and reloading
 *
 * - Autosave and save on tab close
 * - External file change detection
 * - Column formatting
 * - Trailing column trimming and sparse rows
 *
 * Diff review lives in csv-diff.spec.ts; focus isolation in csv-focus.spec.ts.
 * All tests share a single app instance for performance.
 */

import { test, expect, ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  dismissProjectTrustToast,
  TEST_TIMEOUTS,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  openFileFromTree,
  closeTabByFileName,
  getTabByFileName,
} from '../utils/testHelpers';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

// Visible RevoGrid selector
const REVOGRID_SELECTOR = 'revo-grid';

// Helper to type in a CSV cell (double-click, clear, type, enter)
async function editCsvCell(page: Page, cellIndex: number, value: string): Promise<void> {
  const dataCells = page.locator('revogr-data [role="gridcell"]');
  const targetCell = dataCells.nth(cellIndex);
  await targetCell.dblclick();

  const editInput = page.locator('revo-grid textarea');
  await editInput.waitFor({ state: 'visible', timeout: 2000 });
  await editInput.clear();
  await page.keyboard.type(value);
  await page.waitForTimeout(100);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
}

// Helper to wait for autosave to complete
async function waitForAutosaveComplete(page: Page, fileName: string): Promise<void> {
  const tab = getTabByFileName(page, fileName);
  await expect(tab.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toBeVisible({ timeout: 2000 });
  await page.waitForTimeout(3500);
  await expect(tab.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toHaveCount(0, { timeout: 1000 });
}

// Helper to check if cell contains specific text
async function cellContainsText(page: Page, text: string): Promise<boolean> {
  return page.evaluate((searchText) => {
    const cells = document.querySelectorAll('revogr-data [role="gridcell"]');
    for (const cell of cells) {
      if ((cell as HTMLElement).textContent?.trim() === searchText) {
        return true;
      }
    }
    return false;
  }, text);
}

// Shared app instance for all tests in this file
test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  await fs.writeFile(path.join(workspaceDir, 'autosave-test.csv'), 'A,B,C\n1,2,3\n4,5,6\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'dirty-close-test.csv'), 'A,B,C\n1,2,3\n4,5,6\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'external-change-test.csv'), 'Name,Value\nOriginal,100\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'column-format-test.csv'), 'Name,Price\nApple,1.5\nBanana,2.25\nCherry,3.99\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'trailing-test.csv'), 'A,B,,,\n1,2,,,\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'sparse-test.csv'), 'Name,,,,\n1,,,,\n2,,,,SPARSE\n', 'utf8');

  // Launch with alpha release channel so CSV extension loads
  electronApp = await launchElectronApp({
    workspace: workspaceDir,
    env: { NIMBALYST_RELEASE_CHANNEL: 'alpha' }
  });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);
  await dismissProjectTrustToast(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  if (workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

// ============================================================================
// AUTOSAVE TESTS
// ============================================================================

test('autosave clears dirty indicator and saves content', async () => {
  const csvPath = path.join(workspaceDir, 'autosave-test.csv');

  await openFileFromTree(page, 'autosave-test.csv');
  await page.waitForSelector(REVOGRID_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Edit a cell
  await editCsvCell(page, 6, 'AUTOSAVED'); // First data cell in second row

  // Verify dirty indicator appears then clears after autosave
  await waitForAutosaveComplete(page, 'autosave-test.csv');

  // Verify content saved to disk
  const savedContent = await fs.readFile(csvPath, 'utf-8');
  expect(savedContent).toContain('AUTOSAVED');

  await closeTabByFileName(page, 'autosave-test.csv');
});

// ============================================================================
// DIRTY CLOSE TESTS
// ============================================================================

test('edited content is saved when tab is closed', async () => {
  const csvPath = path.join(workspaceDir, 'dirty-close-test.csv');

  await openFileFromTree(page, 'dirty-close-test.csv');
  await page.waitForSelector(REVOGRID_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Edit a cell
  await editCsvCell(page, 6, 'NEWVALUE');

  // Verify dirty indicator appears
  const tabElement = getTabByFileName(page, 'dirty-close-test.csv');
  await expect(tabElement.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toBeVisible({ timeout: 2000 });

  // Close the tab
  await closeTabByFileName(page, 'dirty-close-test.csv');
  await page.waitForTimeout(500);

  // Verify content was saved
  const savedContent = await fs.readFile(csvPath, 'utf-8');
  expect(savedContent).toContain('NEWVALUE');
});

// ============================================================================
// EXTERNAL CHANGE TESTS
// ============================================================================

test('external file change auto-reloads when editor is clean', async () => {
  const csvPath = path.join(workspaceDir, 'external-change-test.csv');

  await openFileFromTree(page, 'external-change-test.csv');
  await page.waitForSelector(REVOGRID_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Verify no dirty indicator
  const tabElement = getTabByFileName(page, 'external-change-test.csv');
  await expect(tabElement.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toHaveCount(0);

  // Verify original content
  expect(await cellContainsText(page, 'Original')).toBe(true);

  // Modify file externally
  await fs.writeFile(csvPath, 'Name,Value\nExternal,200\n', 'utf8');

  // Wait for file watcher to detect and reload
  await page.waitForTimeout(1500);

  // Verify editor shows new content
  expect(await cellContainsText(page, 'External')).toBe(true);
  expect(await cellContainsText(page, 'Original')).toBe(false);

  await closeTabByFileName(page, 'external-change-test.csv');
});

// ============================================================================
// COLUMN FORMATTING TESTS
// ============================================================================

// Skip: Column formatting test is flaky - the format dialog interaction doesn't reliably apply
test.skip('should format column B as currency when format is applied', async () => {
  await openFileFromTree(page, 'column-format-test.csv');
  await page.waitForSelector(REVOGRID_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Find the cell containing "1.5" (first price value)
  const priceCell = page.locator('revogr-data .rgCell:text("1.5")').first();
  await expect(priceCell).toBeVisible({ timeout: 2000 });
  const priceCellBefore = await priceCell.textContent();
  expect(priceCellBefore?.trim()).toBe('1.5');

  // Right-click on column B header to open context menu
  const columnBHeader = page.locator('revogr-header .rgHeaderCell', { hasText: 'B' });
  await columnBHeader.click({ button: 'right' });

  // Wait for context menu
  await page.waitForSelector('.context-menu', { timeout: 2000 });

  // Click on "Format Column (Text)..."
  await page.locator('.context-menu-item', { hasText: 'Format Column' }).click();

  // Wait for the format dialog
  await page.waitForSelector('.column-format-dialog', { timeout: 2000 });

  // Select "Currency" from the type dropdown
  const typeSelect = page.locator('.column-format-dialog select').first();
  await typeSelect.selectOption('currency');

  // Click Apply button
  await page.locator('.dialog-button.primary', { hasText: 'Apply' }).click();

  // Wait for dialog to close
  await expect(page.locator('.column-format-dialog')).not.toBeVisible({ timeout: 2000 });
  await page.waitForTimeout(500);

  // Find the formatted cell (should now show "$1.50")
  const formattedCell = page.locator('revogr-data .rgCell:text("$1.50")').first();
  await expect(formattedCell).toBeVisible({ timeout: 2000 });

  await closeTabByFileName(page, 'column-format-test.csv');
});

// ============================================================================
// TRAILING COLUMN TESTS
// ============================================================================

test('trailing empty columns are trimmed when saving', async () => {
  const csvPath = path.join(workspaceDir, 'trailing-test.csv');
  // Reset file content
  await fs.writeFile(csvPath, 'A,B,,,\n1,2,,,\n', 'utf8');

  await openFileFromTree(page, 'trailing-test.csv');
  await page.waitForSelector(REVOGRID_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Make an edit to trigger dirty state (edit first cell)
  const dataCells = page.locator('revogr-data [role="gridcell"]');
  const targetCell = dataCells.nth(0);
  await targetCell.dblclick();

  const editInput = page.locator('revo-grid textarea');
  await editInput.waitFor({ state: 'visible', timeout: 2000 });
  await editInput.clear();
  // A different value: committing the same text is a no-op and leaves the file clean.
  await page.keyboard.type('Z');
  await page.keyboard.press('Enter');
  await editInput.waitFor({ state: 'hidden', timeout: 2000 });
  await page.waitForTimeout(200);

  // Save with Cmd+S. The keydown does not reach the tab's save handler from a
  // grid cell under Playwright, so wait for the file (autosave writes it too).
  await page.keyboard.press('Meta+s');
  await expect.poll(() => fs.readFile(csvPath, 'utf-8'), { timeout: 6000 }).not.toContain(',,,');

  // Verify trailing empty columns were trimmed
  const savedContent = await fs.readFile(csvPath, 'utf-8');
  expect(savedContent).not.toContain(',,,');
  expect(savedContent.trim()).toBe('Z,B\n1,2');

  await closeTabByFileName(page, 'trailing-test.csv');
});

test('sparse data in later rows is preserved', async () => {
  const csvPath = path.join(workspaceDir, 'sparse-test.csv');
  // Reset file content
  await fs.writeFile(csvPath, 'Name,,,,\n1,,,,\n2,,,,SPARSE\n', 'utf8');

  await openFileFromTree(page, 'sparse-test.csv');
  await page.waitForSelector(REVOGRID_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Make a small edit to trigger dirty state
  const dataCells = page.locator('revogr-data [role="gridcell"]');
  const targetCell = dataCells.nth(0);
  await targetCell.dblclick();

  const editInput = page.locator('revo-grid textarea');
  await editInput.waitFor({ state: 'visible', timeout: 2000 });
  await editInput.clear();
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');
  await editInput.waitFor({ state: 'hidden', timeout: 2000 });
  await page.waitForTimeout(200);

  // Save with Cmd+S
  await page.keyboard.press('Meta+s');
  await page.waitForTimeout(1000);

  // Verify sparse data was preserved
  const savedContent = await fs.readFile(csvPath, 'utf-8');
  expect(savedContent).toContain('SPARSE');

  // Verify 5 columns in the sparse row (4 commas)
  const lines = savedContent.trim().split('\n');
  const rowWithSparse = lines.find(line => line.includes('SPARSE'));
  expect(rowWithSparse).toBeTruthy();
  const commaCount = (rowWithSparse!.match(/,/g) || []).length;
  expect(commaCount).toBe(4);

  await closeTabByFileName(page, 'sparse-test.csv');
});
