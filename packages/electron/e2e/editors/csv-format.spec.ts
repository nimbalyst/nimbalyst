/**
 * CSV editor formatting and layout (Phase 3) smoke tests.
 *
 * The metadata model, format actions, row sizing and validation rules are
 * unit-tested in the extension; these check that the real grid paints and
 * persists them: a per-cell currency shortcut and its undo, wrap growing a
 * row, a hidden column surviving save and reopen, and picking a value from a
 * validation dropdown.
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
import { openFileFromTree, closeTabByFileName } from '../utils/testHelpers';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const HEADER = '{"hasHeaders":true,"headerRowCount":1';
const SHEET = `# nimbalyst: ${HEADER}}\nName,Qty,Status\nAlpha,1,Open\nBeta,2,Done\nGamma,3,\n`;

/** A rendered body cell by section-local row and sheet column (no frozen columns here). */
function cell(row: number, col: number) {
  return page.locator(`revogr-data[type="rgRow"] [role="gridcell"][data-rgrow="${row}"][data-rgcol="${col}"]`).first();
}

async function openSheet(name: string, content = SHEET) {
  await fs.writeFile(path.join(workspaceDir, name), content, 'utf8');
  await openFileFromTree(page, name);
  await page.waitForSelector('revo-grid', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);
}

async function modelValue(bodyRow: number, prop: string): Promise<string> {
  return page.evaluate(({ bodyRow, prop }) => {
    const grid = document.querySelector('revo-grid') as unknown as { source: Record<string, unknown>[] };
    return String(grid.source[bodyRow]?.[prop] ?? '');
  }, { bodyRow, prop });
}

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceDir, 'placeholder.md'), '# x\n', 'utf8');
  electronApp = await launchElectronApp({ workspace: workspaceDir, env: { NIMBALYST_RELEASE_CHANNEL: 'alpha' } });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);
  await dismissProjectTrustToast(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  if (workspaceDir) await fs.rm(workspaceDir, { recursive: true, force: true });
});

test('mod+Shift+4 formats only the selected cell as currency, and undo removes it', async () => {
  await openSheet('currency.csv');
  await cell(0, 1).click(); // B2
  await page.waitForTimeout(200);
  await page.keyboard.press(`${MOD}+Shift+Digit4`);
  await page.waitForTimeout(300);
  await expect(cell(0, 1)).toHaveText('$1.00');
  // Per cell, not per column: B3 keeps its plain value.
  await expect(cell(1, 1)).toHaveText('2');

  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(300);
  await expect(cell(0, 1)).toHaveText('1');
  await closeTabByFileName(page, 'currency.csv');
});

test('wrapping a long cell makes its row taller', async () => {
  const long = 'A long description that cannot fit in one line of a default width column';
  await openSheet('wrap.csv', `# nimbalyst: ${HEADER}}\nName,Qty\n"${long}",1\nShort,2\n`);
  const before = (await cell(0, 0).boundingBox())!.height;
  await cell(0, 0).click();
  await page.locator('[data-toolbar="wrap"]').click();
  await page.waitForTimeout(400);
  const after = (await cell(0, 0).boundingBox())!.height;
  expect(after).toBeGreaterThan(before + 10);
  // The neighbouring row keeps the default height.
  expect((await cell(1, 0).boundingBox())!.height).toBeCloseTo(before, 0);
  await closeTabByFileName(page, 'wrap.csv');
});

test('a hidden column stays hidden after save and reopen', async () => {
  await openSheet('hide.csv');
  await cell(0, 1).click(); // column B
  await page.locator('[data-toolbar="hide"]').click();
  await page.getByText('Hide column B', { exact: true }).click();
  await page.waitForTimeout(300);
  await page.keyboard.press(`${MOD}+s`);
  await expect.poll(() => fs.readFile(path.join(workspaceDir, 'hide.csv'), 'utf8'), { timeout: 5000 })
    .toContain('"hiddenCols":[1]');

  await closeTabByFileName(page, 'hide.csv');
  await openFileFromTree(page, 'hide.csv');
  await page.waitForSelector('revo-grid', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);
  expect((await cell(0, 1).boundingBox())!.width).toBeLessThan(10);
  // The data is still there, only out of view.
  expect(await modelValue(0, 'B')).toBe('1');
  await closeTabByFileName(page, 'hide.csv');
});

test('picking from a validation dropdown writes the option', async () => {
  const rule = '"validation":{"C2:C4":{"kind":"list","mode":"reject","options":[{"value":"Open","color":"green"},{"value":"Done","color":"blue"}]}}';
  await openSheet('validation.csv', SHEET.replace(`${HEADER}}`, `${HEADER},${rule}}`));
  await cell(2, 2).click(); // C4, blank
  await cell(2, 2).locator('[data-csv-list]').click();
  const dropdown = page.locator('.csv-validation-dropdown');
  await dropdown.waitFor({ state: 'visible', timeout: 2000 });
  await dropdown.getByText('Done', { exact: true }).click();
  await page.waitForTimeout(300);
  expect(await modelValue(2, 'C')).toBe('Done');

  // Reject mode: a typed value outside the list is refused with a message.
  // C2 by keyboard: a click on it would land on its chip and open the list.
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('Maybe');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await expect(page.locator('.csv-validation-message')).toBeVisible();
  expect(await modelValue(0, 'C')).toBe('Open');
  await closeTabByFileName(page, 'validation.csv');
});
