/**
 * CSV formula editing: point mode, F4 and autocomplete in the real grid.
 *
 * The text logic is unit-tested in the extension (`formula/__tests__`); these
 * check what only a live RevoGrid can show: a press on a cell mid-formula is
 * swallowed (the editor stays open and keeps focus, the selection does not
 * move) and the picked reference survives the editor's re-renders through to
 * the committed value.
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

// One pinned header row, so body row 0 is sheet row 2.
const SHEET = '# nimbalyst: {"hasHeaders":true,"headerRowCount":1}\nName,Qty\nA,1\nB,2\nC,3\n';

function bodyCell(row: number, col: number) {
  return page.locator(`revogr-data[type="rgRow"] [role="gridcell"][data-rgrow="${row}"][data-rgcol="${col}"]`).first();
}

async function cellCenter(row: number, col: number): Promise<{ x: number; y: number }> {
  const box = await bodyCell(row, col).boundingBox();
  if (!box) throw new Error(`cell ${row},${col} not rendered`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Raw value of a body cell (the formula, not its result). */
async function rawValue(row: number, column: string): Promise<string> {
  return page.evaluate(({ row, column }) => {
    const grid = document.querySelector('revo-grid') as unknown as { source: Record<string, unknown>[] };
    return String(grid.source?.[row]?.[column] ?? '');
  }, { row, column });
}

async function openSheet(name: string) {
  await fs.writeFile(path.join(workspaceDir, name), SHEET, 'utf8');
  await openFileFromTree(page, name);
  await page.waitForSelector('revo-grid', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);
}

/** Select a body cell and open its editor by typing. */
async function startTyping(row: number, col: number, text: string) {
  await bodyCell(row, col).click();
  await page.waitForTimeout(200);
  await page.keyboard.type(text);
  await page.locator('revo-grid textarea').waitFor({ state: 'visible', timeout: 2000 });
  // The editor focuses itself a tick after it renders; keys before that land elsewhere.
  await expect(page.locator('revo-grid textarea.csv-cell-editor')).toBeFocused();
}

const cellEditor = () => page.locator('revo-grid textarea.csv-cell-editor');
const nameBox = () => page.getByLabel('Name box');

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

test('dragging a range mid-formula inserts it at the caret without leaving the edit', async () => {
  await openSheet('point.csv');
  await startTyping(0, 2, '=SUM(');
  expect(await nameBox().inputValue()).toBe('C2');

  const from = await cellCenter(0, 1);
  const to = await cellCenter(2, 1);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  // Still editing C2, with the range written at the caret and outlined.
  await expect(cellEditor()).toBeFocused();
  expect(await cellEditor().inputValue()).toBe('=SUM(B2:B4');
  expect(await nameBox().inputValue()).toBe('C2');
  await expect(page.locator('.csv-formula-reference-outline')).toHaveCount(1);

  await page.keyboard.type(')');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  expect(await rawValue(0, 'C')).toBe('=SUM(B2:B4)');
  await expect(bodyCell(0, 2)).toHaveText('6');
  await expect(page.locator('.csv-formula-reference-outline')).toHaveCount(0);
});

test('a click where no reference can go is an ordinary click', async () => {
  await startTyping(1, 2, '=5');
  await bodyCell(2, 0).click();
  await page.waitForTimeout(300);
  expect(await rawValue(1, 'C')).toBe('=5');
  expect(await nameBox().inputValue()).toBe('A4');
});

test('F4 cycles the reference at the caret', async () => {
  await startTyping(2, 2, '=B2');
  await page.keyboard.press('F4');
  expect(await cellEditor().inputValue()).toBe('=$B$2');
  await page.keyboard.press('F4');
  expect(await cellEditor().inputValue()).toBe('=B$2');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  expect(await rawValue(2, 'C')).toBe('');
});

test('Tab accepts autocomplete, and Escape closes the list before it cancels the edit', async () => {
  await startTyping(2, 2, '=AVER');
  await expect(page.getByRole('listbox', { name: 'Functions' })).toBeVisible();
  await page.keyboard.press('Tab');
  expect(await cellEditor().inputValue()).toBe('=AVERAGE(');
  await expect(cellEditor()).toBeFocused();

  // Signature help is up now; the first Escape only closes it.
  await page.keyboard.press('Escape');
  await expect(cellEditor()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(cellEditor()).toBeHidden();
  expect(await rawValue(2, 'C')).toBe('');
});

test('pointing from the formula bar, then jumping with the name box', async () => {
  await bodyCell(2, 2).click();
  await page.waitForTimeout(200);
  const bar = page.locator('input.csv-formula-bar-input');
  await bar.click();
  await page.keyboard.type('=');
  await bodyCell(0, 1).click();
  await page.keyboard.type('+');
  await bodyCell(1, 1).click();
  await expect(bar).toBeFocused();
  expect(await bar.inputValue()).toBe('=B2+B3');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  expect(await rawValue(2, 'C')).toBe('=B2+B3');
  await expect(bodyCell(2, 2)).toHaveText('3');

  await nameBox().click();
  await page.keyboard.type('A2:B3');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  expect(await nameBox().inputValue()).toBe('A2:B3');
  await closeTabByFileName(page, 'point.csv');
});
