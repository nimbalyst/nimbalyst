/**
 * CSV editor keyboard / clipboard / undo smoke tests.
 *
 * The controller logic is unit-tested in the extension; these check that it is
 * actually in front of RevoGrid in the real app: a data jump, a typed Tab/Enter
 * run, a quoted multi-line TSV paste, and a structural edit undone in one step.
 * Grid state is read from the grid's own row models.
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
// One pinned header row, so body row 0 is "A".
const SHEET = '# nimbalyst: {"hasHeaders":true,"headerRowCount":1}\nName,Qty\nA,1\nB,2\nC,3\n';

/** Non-empty rows of the grid as [A, B] pairs, header rows first. */
async function gridRows(): Promise<string[][]> {
  return page.evaluate(() => {
    const grid = document.querySelector('revo-grid') as unknown as {
      source: Record<string, unknown>[];
      pinnedTopSource: Record<string, unknown>[];
    };
    return [...(grid.pinnedTopSource ?? []), ...(grid.source ?? [])]
      .map((row) => [String(row.A ?? ''), String(row.B ?? '')])
      .filter((row) => row.some((cell) => cell !== ''));
  });
}

async function openSheet(name: string) {
  await fs.writeFile(path.join(workspaceDir, name), SHEET, 'utf8');
  await openFileFromTree(page, name);
  await page.waitForSelector('revo-grid', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);
}

/** Click a body cell by its section-local row and column. */
async function clickCell(row: number, col: number) {
  await page.locator(`revogr-data[type="rgRow"] [role="gridcell"][data-rgrow="${row}"][data-rgcol="${col}"]`).first().click();
  await page.waitForTimeout(200);
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

test('mod+ArrowDown jumps to the end of the data, then Tab/Enter runs type a row', async () => {
  await openSheet('jump.csv');
  await clickCell(0, 0); // A2 ("A")

  await page.keyboard.press(`${MOD}+ArrowDown`);
  await page.keyboard.press('ArrowDown'); // first blank row below the data
  await page.keyboard.type('D');
  await page.keyboard.press('Tab');
  await page.keyboard.type('4');
  await page.keyboard.press('Enter');
  await page.keyboard.type('E');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);

  expect(await gridRows()).toEqual([
    ['Name', 'Qty'], ['A', '1'], ['B', '2'], ['C', '3'], ['D', '4'], ['E', ''],
  ]);

  // At human pace the keystroke opens the real cell editor with what was typed,
  // and Escape abandons it.
  await clickCell(2, 1);
  await page.waitForTimeout(300);
  await page.keyboard.type('9');
  const editor = page.locator('revo-grid textarea');
  await editor.waitFor({ state: 'visible', timeout: 2000 });
  expect(await editor.inputValue()).toBe('9');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  expect((await gridRows())[3]).toEqual(['C', '3']);
  await closeTabByFileName(page, 'jump.csv');
});

test('pasting quoted multi-line TSV keeps each quoted cell whole', async () => {
  await openSheet('paste.csv');
  await clickCell(0, 0);

  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'x\t"line 1\nline 2"\ny\t"say ""hi"""');
    document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);

  expect((await gridRows()).slice(1, 3)).toEqual([['x', 'line 1\nline 2'], ['y', 'say "hi"']]);
  await closeTabByFileName(page, 'paste.csv');
});

test('insert row then undo restores the sheet in one step', async () => {
  await openSheet('undo.csv');
  await clickCell(1, 0); // B3 ("B")

  await page.locator('revogr-data[type="rgRow"] [role="gridcell"][data-rgrow="1"][data-rgcol="0"]').first().click({ button: 'right' });
  await page.getByText('Insert Row Above', { exact: true }).click();
  await page.waitForTimeout(300);
  expect(await gridRows()).toEqual([['Name', 'Qty'], ['A', '1'], ['B', '2'], ['C', '3']]);
  expect(await page.evaluate(() => (document.querySelector('revo-grid') as unknown as { source: Record<string, unknown>[] }).source[1].A)).toBe('');

  await clickCell(0, 0);
  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (document.querySelector('revo-grid') as unknown as { source: Record<string, unknown>[] }).source[1].A)).toBe('B');
  await closeTabByFileName(page, 'undo.csv');
});

test('double-clicking the fill handle continues the series to the end of the neighboring column', async () => {
  await fs.writeFile(path.join(workspaceDir, 'fill.csv'), '# nimbalyst: {"hasHeaders":true,"headerRowCount":1}\nName,Qty\nA,1\nB,2\nC,\nD,\n', 'utf8');
  await openFileFromTree(page, 'fill.csv');
  await page.waitForSelector('revo-grid', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);
  await clickCell(0, 1);
  await page.locator('revogr-data[type="rgRow"] [role="gridcell"][data-rgrow="1"][data-rgcol="1"]').first().click({ modifiers: ['Shift'] });
  await page.waitForTimeout(200);

  await page.locator('revo-grid .autofill-handle').first().dblclick();
  await page.waitForTimeout(300);
  expect(await gridRows()).toEqual([['Name', 'Qty'], ['A', '1'], ['B', '2'], ['C', '3'], ['D', '4']]);

  await page.keyboard.press(`${MOD}+z`);
  await page.waitForTimeout(300);
  expect(await gridRows()).toEqual([['Name', 'Qty'], ['A', '1'], ['B', '2'], ['C', ''], ['D', '']]);
  await closeTabByFileName(page, 'fill.csv');
});

test('mod+K adds a link to the cell as a HYPERLINK and reopens it for editing', async () => {
  await openSheet('link.csv');
  await clickCell(0, 0); // "A"

  await page.keyboard.press(`${MOD}+k`);
  const dialog = page.locator('.csv-link-dialog');
  await dialog.waitFor({ state: 'visible', timeout: 2000 });
  expect(await dialog.locator('.csv-link-text').inputValue()).toBe('A');
  await page.keyboard.type('https://example.com');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  expect((await gridRows())[1]).toEqual(['=HYPERLINK("https://example.com","A")', '1']);

  await clickCell(0, 0);
  await page.keyboard.press(`${MOD}+k`);
  await dialog.waitFor({ state: 'visible', timeout: 2000 });
  expect(await dialog.locator('.csv-link-url').inputValue()).toBe('https://example.com');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await closeTabByFileName(page, 'link.csv');
});

test('mod+B bolds the selected cell instead of toggling the left pane', async () => {
  await openSheet('bold.csv');
  await clickCell(1, 0); // "B"
  await page.keyboard.press(`${MOD}+b`);
  await page.waitForTimeout(300);
  await expect(page.locator('revogr-data[type="rgRow"] [role="gridcell"][data-rgrow="1"][data-rgcol="0"]').first()).toHaveClass(/csv-cell-bold/);
  // The file tree is still there: the host did not take the chord.
  await expect(page.locator('.tab-title', { hasText: 'bold.csv' })).toBeVisible();
  await closeTabByFileName(page, 'bold.csv');
});
