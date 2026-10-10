/**
 * CSV Spreadsheet Editor E2E Tests: editing entry and focus isolation
 *
 * - Double-click and type-over open the cell editor
 * - Quick open and other tabs never type into the grid
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
  openFileFromTree,
  closeTabByFileName,
} from '../utils/testHelpers';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

// Visible RevoGrid selector
const REVOGRID_SELECTOR = 'revo-grid';

// Shared app instance for all tests in this file
test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  await fs.writeFile(path.join(workspaceDir, 'keyboard-test.csv'), 'A,B,C\n1,2,3\n4,5,6\n7,8,9\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'quick-open-test.csv'), 'Name,Value\nAlice,100\nBob,200\n', 'utf8');
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
  const editInput = page.locator('revo-grid textarea');
  await editInput.waitFor({ state: 'visible', timeout: 2000 });

  await editInput.fill('edited');
  await page.waitForTimeout(100);

  const inputValue = await editInput.inputValue();
  expect(inputValue).toBe('edited');

  await page.keyboard.press('Escape'); // Cancel edit
  await closeTabByFileName(page, 'keyboard-test.csv');
});

// The other half of the quick-open guard below: declining keystrokes by origin
// must not decline the grid's own. Typing a printable key over a focused cell
// is how RevoGrid opens the editor without a double-click.
test('typing over a focused cell opens the cell editor', async () => {
  await fs.writeFile(path.join(workspaceDir, 'keyboard-test.csv'), 'A,B,C\n1,2,3\n4,5,6\n7,8,9\n', 'utf8');

  await openFileFromTree(page, 'keyboard-test.csv');
  await page.waitForSelector(REVOGRID_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  await page.locator('revogr-data [role="gridcell"]').nth(6).click();
  await page.waitForTimeout(300);

  await page.keyboard.type('Z');

  const editInput = page.locator('revo-grid textarea');
  await editInput.waitFor({ state: 'visible', timeout: 2000 });
  expect(await editInput.inputValue()).toBe('Z');

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
  // `:has-text`, not `:text`: the value renders in a span inside the cell, and
  // `:text` only matches the smallest element holding the text.
  const targetCell = page.locator('revogr-data [role="gridcell"]:has-text("Alice")').first();
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
