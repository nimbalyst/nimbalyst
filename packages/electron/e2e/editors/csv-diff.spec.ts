/**
 * CSV Spreadsheet Editor E2E Tests: agent diff review
 *
 * - Rows deleted by an agent edit leave the grid once the diff is kept
 * - Repeated agent writes show the latest generation and resolve once
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

// Helper to get all first-column values from the grid
async function getFirstColumnValues(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    // RevoGrid virtualizes however many columns fit in the viewport, so DOM
    // position is not a stable column identifier. Use its explicit column
    // coordinate and exclude the row-header viewport.
    const cells = document.querySelectorAll(
      'revogr-data[col-type="rgCol"] [role="gridcell"][data-rgcol="0"]'
    );
    const values: string[] = [];
    cells.forEach((cell) => {
      const text = (cell as HTMLElement).textContent?.trim() || '';
      if (text) values.push(text);
    });
    return values;
  });
}

// Shared app instance for all tests in this file
test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  await fs.writeFile(path.join(workspaceDir, 'diff-delete-test.csv'), 'Name,Color,Price\nApple,Red,1.50\nBanana,Yellow,0.75\nCherry,Red,2.00\nDate,Brown,3.50\nElderberry,Purple,4.00\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'diff-repeated-test.csv'), 'Name,Color,Price\nApple,Red,1.50\nBanana,Yellow,0.75\n', 'utf8');

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

// NIM-5359 (plan item 1h) -- a diff-capable custom editor (CSV declares
// supportsDiffMode: true) is a real generation recipient, so it must show the
// LATEST agent write while a review is open, not whichever generation happened
// to arrive before the session stalled.
//
// Before Phase 3 (generation-scoped `completeDiffApply`) and Phase 7 (single
// presentation path) the mount path never acknowledged an apply, so once a
// remount presented a generation the model's DiffSession sat in `applying` and
// every later write queued with no reachable drain.
test('diff-capable custom editor shows the latest of repeated agent writes and resolves once', async () => {
  test.setTimeout(120_000);
  const csvPath = path.join(workspaceDir, 'diff-repeated-test.csv');
  const originalContent = 'Name,Color,Price\nApple,Red,1.50\nBanana,Yellow,0.75\n';
  await fs.writeFile(csvPath, originalContent, 'utf8');

  await openFileFromTree(page, 'diff-repeated-test.csv');
  await page.waitForSelector(REVOGRID_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  await page.evaluate(async ({ workspacePath, filePath, content }) => {
    await window.electronAPI.history.createTag(
      workspacePath, filePath, 'csv-repeated-tag', content, 'csv-repeated-session', 'tool-csv-repeated',
    );
  }, { workspacePath: workspaceDir, filePath: csvPath, content: originalContent });
  await page.waitForTimeout(200);

  // Three generations; the diff bar must stay up across all of them.
  const gen1 = `${originalContent}Cherry,Red,2.00\n`;
  const gen2 = `${originalContent}Cherry,Red,2.00\nDate,Brown,3.50\n`;
  const gen3 = `${originalContent}Cherry,Red,2.00\nDate,Brown,3.50\nElderberry,Purple,4.00\n`;
  await fs.writeFile(csvPath, gen1, 'utf8');
  await page.waitForSelector('.unified-diff-header', { timeout: 5000 });
  await fs.writeFile(csvPath, gen2, 'utf8');
  await page.waitForTimeout(150);
  await fs.writeFile(csvPath, gen3, 'utf8');
  await page.waitForTimeout(2000);

  await expect(page.locator('.unified-diff-header')).toBeVisible();

  await page.locator('.unified-diff-header button', { hasText: 'Keep' }).click();
  await page.waitForTimeout(1000);

  // The grid holds every row from the newest generation.
  const gridAfterAccept = await getFirstColumnValues(page);
  for (const name of ['Apple', 'Banana', 'Cherry', 'Date', 'Elderberry']) {
    expect(gridAfterAccept).toContain(name);
  }

  // Disk holds exactly the newest generation, and the review resolved once.
  expect(await fs.readFile(csvPath, 'utf8')).toBe(gen3);
  const tags: Array<{ type: string; status: string }> = await page.evaluate(
    (fp) => window.electronAPI.invoke('history:get-all-tags', fp), csvPath,
  );
  expect(tags.filter((t) => t.type === 'pre-edit')).toHaveLength(1);
  expect(tags.filter((t) => t.status === 'pending-review')).toHaveLength(0);

  await closeTabByFileName(page, 'diff-repeated-test.csv');
});
