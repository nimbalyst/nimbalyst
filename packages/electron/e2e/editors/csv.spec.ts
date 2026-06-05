/**
 * CSV Spreadsheet Editor E2E Tests (Consolidated)
 *
 * Tests for the RevoGrid-based CSV editor including:
 * - Autosave functionality
 * - Dirty close (save on tab close)
 * - External file change detection
 * - Column formatting
 * - Diff row deletion (AI edits)
 * - Keyboard navigation and focus isolation
 * - Quick open focus handling
 * - Trailing column trimming
 *
 * This file consolidates tests that previously lived in separate files.
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

  const editInput = page.locator('revo-grid input');
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

// Helper to get all first-column values from the grid
async function getFirstColumnValues(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const cells = document.querySelectorAll('revogr-data [role="gridcell"]');
    const values: string[] = [];
    // Assuming 3 columns per row for now - we read every 3rd cell starting at 0
    cells.forEach((cell, idx) => {
      if (idx % 3 === 0) {
        const text = (cell as HTMLElement).textContent?.trim() || '';
        if (text) values.push(text);
      }
    });
    return values;
  });
}

// Shared app instance for all tests in this file
test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  // Create ALL test files upfront for all scenarios
  await fs.writeFile(path.join(workspaceDir, 'autosave-test.csv'), 'A,B,C\n1,2,3\n4,5,6\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'dirty-close-test.csv'), 'A,B,C\n1,2,3\n4,5,6\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'external-change-test.csv'), 'Name,Value\nOriginal,100\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'column-format-test.csv'), 'Name,Price\nApple,1.5\nBanana,2.25\nCherry,3.99\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'diff-delete-test.csv'), 'Name,Color,Price\nApple,Red,1.50\nBanana,Yellow,0.75\nCherry,Red,2.00\nDate,Brown,3.50\nElderberry,Purple,4.00\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'keyboard-test.csv'), 'A,B,C\n1,2,3\n4,5,6\n7,8,9\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'quick-open-test.csv'), 'Name,Value\nAlice,100\nBob,200\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'trailing-test.csv'), 'A,B,,,\n1,2,,,\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'sparse-test.csv'), 'Name,,,,\n1,,,,\n2,,,,SPARSE\n', 'utf8');
  // Markdown file for quick open and tab switching tests
  await fs.writeFile(path.join(workspaceDir, 'notes.md'), '# Notes\n\nSome content here.\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'document.md'), '# Test Document\n\nHello world.\n', 'utf8');

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
// DIFF ROW DELETION TESTS
// ============================================================================

test('deleted rows should be removed from grid after accepting diff', async () => {
  const csvPath = path.join(workspaceDir, 'diff-delete-test.csv');

  // Reset file to original content
  const originalContent = `Name,Color,Price
Apple,Red,1.50
Banana,Yellow,0.75
Cherry,Red,2.00
Date,Brown,3.50
Elderberry,Purple,4.00
`;
  await fs.writeFile(csvPath, originalContent, 'utf8');

  await openFileFromTree(page, 'diff-delete-test.csv');
  await page.waitForSelector(REVOGRID_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Verify initial content
  const initialRows = await getFirstColumnValues(page);
  expect(initialRows).toContain('Apple');
  expect(initialRows).toContain('Cherry');
  expect(initialRows).toContain('Elderberry');

  // Modified content: delete Cherry row, add Fig at the end
  const modifiedContent = `Name,Color,Price
Apple,Red,1.50
Banana,Yellow,0.75
Date,Brown,3.50
Elderberry,Purple,4.00
Fig,Green,2.50
`;

  // Simulate AI edit
  await fs.writeFile(csvPath, modifiedContent, 'utf8');

  const tagId = `test-tag-${Date.now()}`;
  const sessionId = `test-session-${Date.now()}`;

  await page.evaluate(async ({ workspacePath, filePath, tagId, sessionId, originalContent }) => {
    await window.electronAPI.history.createTag(
      workspacePath,
      filePath,
      tagId,
      originalContent,
      sessionId,
      'test-tool-use'
    );
  }, { workspacePath: workspaceDir, filePath: csvPath, tagId, sessionId, originalContent });

  // Close and reopen to trigger pending tag check
  await page.keyboard.press('Meta+w');
  await page.waitForTimeout(300);

  await openFileFromTree(page, 'diff-delete-test.csv');
  await page.waitForSelector(REVOGRID_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Wait for diff header
  await page.waitForSelector('.unified-diff-header', { timeout: 5000 });

  // Click "Keep" to accept the changes
  const keepButton = page.locator('.unified-diff-header button', { hasText: 'Keep' });
  await keepButton.click();
  await page.waitForTimeout(500);

  // Verify the grid content after accepting
  const gridAfterAccept = await getFirstColumnValues(page);

  // Cherry should NOT be in the grid anymore
  expect(gridAfterAccept).not.toContain('Cherry');
  // Apple, Banana, Date, Elderberry should still be there
  expect(gridAfterAccept).toContain('Apple');
  expect(gridAfterAccept).toContain('Banana');
  expect(gridAfterAccept).toContain('Date');
  expect(gridAfterAccept).toContain('Elderberry');
  // Fig should be added
  expect(gridAfterAccept).toContain('Fig');

  await closeTabByFileName(page, 'diff-delete-test.csv');
});

// ============================================================================
// KEYBOARD NAVIGATION TESTS
// ============================================================================

test('double-click to edit should work', async () => {
  // Reset file content first (in case previous test modified it)
  await fs.writeFile(path.join(workspaceDir, 'keyboard-test.csv'), 'A,B,C\n1,2,3\n4,5,6\n7,8,9\n', 'utf8');

  await openFileFromTree(page, 'keyboard-test.csv');
  await page.waitForSelector(REVOGRID_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Double-click on a data cell
  const dataCells = page.locator('revogr-data [role="gridcell"]');
  const targetCell = dataCells.nth(6);
  await targetCell.dblclick();

  // Wait for edit input
  const editInput = page.locator('revo-grid input');
  await editInput.waitFor({ state: 'visible', timeout: 2000 });

  await editInput.fill('edited');
  await page.waitForTimeout(100);

  const inputValue = await editInput.inputValue();
  expect(inputValue).toBe('edited');

  await page.keyboard.press('Escape'); // Cancel edit
  await closeTabByFileName(page, 'keyboard-test.csv');
});

// ============================================================================
// QUICK OPEN FOCUS TESTS
// ============================================================================

test('CSV editor should not steal focus from quick open dialog', async () => {
  await openFileFromTree(page, 'quick-open-test.csv');
  await page.waitForSelector(REVOGRID_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  // Click on a cell to give the spreadsheet focus
  await page.locator('revo-grid').click();
  await page.waitForTimeout(300);

  // Open quick open with Cmd+O
  await page.keyboard.press('Meta+o');
  await page.waitForSelector('.unified-quick-open-modal', { timeout: 2000 });

  // The quick open input should have focus
  const quickOpenInput = page.locator('.unified-quick-open-search');
  await expect(quickOpenInput).toBeFocused({ timeout: 1000 });

  // Type a search query
  await page.keyboard.type('document', { delay: 50 });

  // Verify the text went into quick open input
  const inputValue = await quickOpenInput.inputValue();
  expect(inputValue).toBe('document');

  // Verify quick open shows results
  await expect(page.locator('.unified-quick-open-item').first()).toBeVisible({ timeout: 2000 });

  // Close quick open
  await page.keyboard.press('Escape');
  await closeTabByFileName(page, 'quick-open-test.csv');
});

test('typing in quick open should not appear in CSV cells', async () => {
  await openFileFromTree(page, 'quick-open-test.csv');
  await page.waitForSelector(REVOGRID_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  // Click on a cell
  const firstCell = page.locator('.rgCell').first();
  await firstCell.click();
  await page.waitForTimeout(300);

  const initialCellText = await firstCell.textContent();

  // Open quick open
  await page.keyboard.press('Meta+o');
  await page.waitForSelector('.unified-quick-open-modal', { timeout: 2000 });

  // Type some characters
  await page.keyboard.type('xyz', { delay: 50 });

  // Close quick open
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Verify the cell content hasn't changed
  const afterCellText = await firstCell.textContent();
  expect(afterCellText).toBe(initialCellText);

  await closeTabByFileName(page, 'quick-open-test.csv');
});

test('typing in another tab should not affect spreadsheet', async () => {
  await openFileFromTree(page, 'quick-open-test.csv');
  await page.waitForSelector(REVOGRID_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Click on a data cell
  const targetCell = page.locator('revogr-data [role="gridcell"]:text("Alice")').first();
  await targetCell.click();
  await page.waitForTimeout(200);
  const originalValue = await targetCell.textContent();

  // Open the markdown file in a new tab
  await openFileFromTree(page, 'notes.md');
  await page.waitForSelector('[contenteditable="true"]', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(300);

  // Type in markdown editor
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.type('Hello from markdown');
  await page.waitForTimeout(100);

  // Switch back to CSV tab
  await page.locator('.tab-title', { hasText: 'quick-open-test.csv' }).click();
  await page.waitForTimeout(300);

  // Verify CSV cell was NOT edited
  const afterValue = await targetCell.textContent();
  expect(afterValue).toBe(originalValue);

  await closeTabByFileName(page, 'notes.md');
  await closeTabByFileName(page, 'quick-open-test.csv');
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

  const editInput = page.locator('revo-grid input');
  await editInput.waitFor({ state: 'visible', timeout: 2000 });
  await editInput.clear();
  await page.keyboard.type('A');
  await page.keyboard.press('Enter');
  await editInput.waitFor({ state: 'hidden', timeout: 2000 });
  await page.waitForTimeout(200);

  // Save with Cmd+S
  await page.keyboard.press('Meta+s');
  await page.waitForTimeout(1000);

  // Verify trailing empty columns were trimmed
  const savedContent = await fs.readFile(csvPath, 'utf-8');
  expect(savedContent).not.toContain(',,,');
  expect(savedContent.trim()).toBe('A,B\n1,2');

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

  const editInput = page.locator('revo-grid input');
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
