/**
 * CSV Spreadsheet Extension - Live Integration Tests
 *
 * Run against a live Nimbalyst instance via CDP.
 *
 * Prerequisites: Nimbalyst running in dev mode (CDP on port 9222)
 *
 * Run:
 *   npm run test:extensions -- csv
 */

import { test as base, expect } from '@playwright/test';
import { chromium } from 'playwright';
import * as path from 'path';

const TEST_DIR = __dirname;

const test = base.extend<{ page: import('playwright').Page }>({
  page: async ({}, use) => {
    const browser = await chromium.connectOverCDP('http://localhost:9222');
    let target: import('playwright').Page | undefined;
    // Find the window whose workspace contains this test file
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        const url = p.url();
        if (url.startsWith('devtools://') || url.includes('mode=capture')) continue;
        try {
          const ws = await p.evaluate(async () =>
            (await (window as any).electronAPI.getInitialState?.())?.workspacePath
          );
          if (ws && TEST_DIR.startsWith(ws)) {
            target = p;
            break;
          }
        } catch {}
      }
      if (target) break;
    }
    if (!target) throw new Error(`No Nimbalyst window found whose workspace contains ${TEST_DIR}`);
    await use(target);
    browser.close();
  },
});

const CSV_PATH = path.resolve(TEST_DIR, '../samples/demo.csv');

/**
 * Open the CSV file and wait for the grid to be ready.
 * If in pending-review diff mode, press Keep then re-open for clean state.
 */
async function openCSVAndWaitReady(page: import('playwright').Page) {
  const openFile = async () => {
    await page.evaluate(async (fp: string) => {
      const handler = (window as any).__handleWorkspaceFileSelect;
      if (!handler) throw new Error('__handleWorkspaceFileSelect not available');
      await handler(fp);
    }, CSV_PATH);
    await page.waitForSelector('revo-grid', { timeout: 5000 });
    await page.waitForTimeout(300);
  };

  await openFile();

  // If the grid is in readonly diff mode, press Keep to accept, then re-open
  const readonly = await page.evaluate((fp: string) => {
    const ext = document.querySelector(`[data-extension-id][data-file-path="${fp}"]`);
    const grid = ext?.querySelector('revo-grid') as any;
    return grid?.readonly;
  }, CSV_PATH);

  if (readonly) {
    // Revert to clear diff and restore file to pre-edit state
    await page.evaluate((fp: string) => {
      const ext = document.querySelector(`[data-extension-id][data-file-path="${fp}"]`);
      const btn = ext?.querySelector('[data-testid="diff-revert-all"]') as HTMLElement;
      btn?.click();
    }, CSV_PATH);
    await page.waitForTimeout(500);
    // Re-open to get clean grid state after diff dismissal
    await openFile();
  }
}

/** Locator scoped to the active CSV file's extension container */
const EXT_SELECTOR = `[data-extension-id="com.nimbalyst.csv-spreadsheet"][data-file-path="${CSV_PATH}"]`;

function extLocator(page: import('playwright').Page, selector: string) {
  return page.locator(`${EXT_SELECTOR} ${selector}`);
}

/**
 * Get bounding rect of a data cell (not row header, not pinned header) by text.
 */
async function getDataCellByText(page: import('playwright').Page, text: string) {
  return page.evaluate(({ searchText, fp }: { searchText: string; fp: string }) => {
    const ext = document.querySelector(`[data-extension-id][data-file-path="${fp}"]`);
    if (!ext) return null;
    const allCells = ext.querySelectorAll('revo-grid .rgCell');
    for (const cell of Array.from(allCells)) {
      if (cell.closest('.rowHeaders')) continue;
      if (cell.closest('.rgRow')?.classList.contains('header-row')) continue;
      if (cell.textContent?.trim() === searchText) {
        const rect = cell.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: cell.textContent?.trim() };
      }
    }
    return null;
  }, { searchText: text, fp: CSV_PATH });
}

/**
 * Get the first non-empty, non-numeric data cell (skipping row headers and pinned header row).
 */
async function getFirstDataCell(page: import('playwright').Page) {
  return page.evaluate((fp: string) => {
    const ext = document.querySelector(`[data-extension-id][data-file-path="${fp}"]`);
    if (!ext) return null;
    const allCells = ext.querySelectorAll('revo-grid .rgCell');
    for (const cell of Array.from(allCells)) {
      if (cell.closest('.rowHeaders')) continue;
      if (cell.closest('.rgRow')?.classList.contains('header-row')) continue;
      const text = cell.textContent?.trim();
      if (text && text.length > 1 && !/^\d+$/.test(text)) {
        const rect = cell.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text };
      }
    }
    return null;
  }, CSV_PATH);
}

test.describe('CSV Spreadsheet Extension', () => {
  test.describe.configure({ mode: 'serial' });

  // --- Non-mutating tests first (no cell edits, no diff creation) ---

  test('opens CSV and renders full editor UI', async ({ page }) => {
    await openCSVAndWaitReady(page);

    const ext = page.locator(EXT_SELECTOR);
    await expect(ext).toBeVisible();

    // Formula bar: cell ref display + input
    await expect(extLocator(page, '.font-mono.font-semibold')).toBeVisible();
    await expect(extLocator(page, 'input[placeholder="Enter value"]')).toBeVisible();

    // Grid structure: headers, cells, rows
    expect(await extLocator(page, 'revo-grid .rgHeaderCell').count()).toBeGreaterThan(0);
    expect(await extLocator(page, 'revo-grid .rgCell').count()).toBeGreaterThan(0);
    expect(await extLocator(page, 'revo-grid .rgRow').count()).toBeGreaterThanOrEqual(8);

    // CSV data present in data cells
    const cellTexts = await page.evaluate((fp: string) => {
      const ext = document.querySelector(`[data-extension-id][data-file-path="${fp}"]`);
      const dataCells = ext?.querySelectorAll('revo-grid .main-viewport revogr-data .rgCell') ?? [];
      return Array.from(dataCells).map(c => c.textContent?.trim()).filter(Boolean).slice(0, 30);
    }, CSV_PATH);
    expect(cellTexts.length).toBeGreaterThan(0);
    expect(cellTexts.join(' ')).toMatch(/Cloud Platform|Product|Infrastructure/);
  });

  test('cell click updates formula bar with cell reference and value', async ({ page }) => {
    // Reuse grid from previous test — don't re-open to avoid diff cycle

    const cellInfo = await getFirstDataCell(page);
    expect(cellInfo).not.toBeNull();
    await page.mouse.click(cellInfo!.x, cellInfo!.y);
    await page.waitForTimeout(200);

    const refText = await extLocator(page, '.font-mono.font-semibold').textContent();
    expect(refText).toMatch(/^[A-Z]+\d+$/);

    const input = extLocator(page, 'input[placeholder="Enter value"]');
    await expect(input).toBeEnabled();
    const inputVal = await input.inputValue();
    expect(inputVal).toBe(cellInfo!.text);
  });

  // --- Mutating tests (cell edits that may create pending-review diffs) ---

  test('double-click cell opens inline editor and Enter saves', async ({ page }) => {
    await openCSVAndWaitReady(page);

    const cellInfo = await getFirstDataCell(page);
    expect(cellInfo).not.toBeNull();
    const originalText = cellInfo!.text;

    await page.mouse.dblclick(cellInfo!.x, cellInfo!.y);
    await page.waitForTimeout(300);

    const editInput = extLocator(page, 'revo-grid input[type="text"]');
    await expect(editInput).toBeVisible({ timeout: 2000 });

    const currentVal = await editInput.inputValue();
    expect(currentVal).toBe(originalText);

    // Type a new value and save with Enter
    const testValue = 'TestProduct_' + Date.now();
    await editInput.fill(testValue);
    await editInput.press('Enter');
    await page.waitForTimeout(300);

    const updatedCell = await getDataCellByText(page, testValue);
    expect(updatedCell).not.toBeNull();

    // Restore original value
    await page.mouse.dblclick(updatedCell!.x, updatedCell!.y);
    await page.waitForTimeout(300);
    const restoreInput = extLocator(page, 'revo-grid input[type="text"]');
    await restoreInput.fill(originalText);
    await restoreInput.press('Enter');
    await page.waitForTimeout(200);
  });

  test('Escape cancels cell edit without saving', async ({ page }) => {
    await openCSVAndWaitReady(page);

    const cellInfo = await getFirstDataCell(page);
    expect(cellInfo).not.toBeNull();
    const originalText = cellInfo!.text;

    await page.mouse.dblclick(cellInfo!.x, cellInfo!.y);
    await page.waitForTimeout(300);

    const editInput = extLocator(page, 'revo-grid input[type="text"]');
    await expect(editInput).toBeVisible({ timeout: 2000 });

    await editInput.fill('SHOULD_NOT_SAVE');
    await editInput.press('Escape');
    await page.waitForTimeout(200);

    const stillThere = await getDataCellByText(page, originalText);
    expect(stillThere).not.toBeNull();

    const badCell = await getDataCellByText(page, 'SHOULD_NOT_SAVE');
    expect(badCell).toBeNull();
  });
});
