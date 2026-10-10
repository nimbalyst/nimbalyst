/**
 * Inline citations (knowledge pages Phase 5, Decision 18).
 *
 * A page holding a human citation and a source citation draws a blue initials
 * chip and a numbered source chip; hovering the human chip shows who said it
 * and the snapshotted quote; Page info lists every citation in the page.
 * Human citations are console links (Decision 23); a page written with the
 * older `nimbalyst://cite/` link still reads. An edit elsewhere in the page
 * saves every citation back byte for byte.
 *
 * Runs signed out on a temp workspace; no account or server needed.
 *
 *   npx playwright test e2e/pages/page-citations.spec.ts --max-failures=1
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ACTIVE_EDITOR_SELECTOR, TEST_TIMEOUTS, createTempWorkspace, launchElectronApp } from '../helpers';
import { dismissAPIKeyDialog, openFileFromTree, waitForWorkspaceReady } from '../utils/testHelpers';

// Written before console links; still read, and saved back unchanged.
const HUMAN_LEGACY = '[GH](nimbalyst://cite/sess-1/answer/toolu_01 "by=\'Greg Hinkle\' at=2026-09-30 ctx=\'answering round 3, TD-8\' quote=\'Building it means building the whole thing: keyboard shortcuts, ARIA, etc.\'")';
const HUMAN = '[GH](https://console.nimbalyst.com/app/cite/sess-1/prompt/msg-7 "by=\'Greg Hinkle\' email=greg@example.com at=2026-09-30 quote=\'Agents keep forgetting keyboard handling.\'")';
const SOURCE = '[TanStack Table docs](https://tanstack.com/table "cite")';
const BODY = [
  '# TanStack Table',
  '',
  `One shared DataTable component, built once and reused.${HUMAN_LEGACY}`,
  '',
  `Agents building tables without a library forget keyboard handling.${HUMAN}`,
  '',
  `The library supplies row models and column state.${SOURCE}`,
  '',
  'Last line.',
  '',
].join('\n');

let app: ElectronApplication;
let page: Page;
let workspace: string;

test.beforeAll(async () => {
  workspace = await createTempWorkspace();
  await fs.writeFile(path.join(workspace, 'table.md'), BODY, 'utf8');
  app = await launchElectronApp({ workspace, permissionMode: 'allow-all' });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await dismissAPIKeyDialog(page);
  await waitForWorkspaceReady(page);
});

test.afterAll(async () => {
  await app?.close();
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
});

test('citation chips, the quote popover and Page info\'s Sources', async () => {
  await openFileFromTree(page, 'table.md');
  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await expect(editor).toBeVisible({ timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  const chips = page.getByTestId('citation-chip');
  await expect(chips).toHaveCount(3);
  await expect(page.locator('.citation-chip--human')).toHaveText(['GH', 'GH']);
  await expect(page.locator('.citation-chip--source')).toHaveText('1');

  await page.locator('.citation-chip--human').first().hover();
  const popover = page.getByTestId('citation-popover');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('Greg Hinkle');
  await expect(popover).toContainText('answering round 3, TD-8');
  await expect(popover).toContainText('keyboard shortcuts, ARIA, etc.');

  // The page carries no Sources line; Page info lists the citations.
  await expect(page.getByTestId('citation-sources-line')).toHaveCount(0);
  await page.getByTestId('editor-header-page-info').click();
  const sources = page.getByTestId('citation-sources-list').locator('li');
  await expect(sources).toHaveCount(3);
  await expect(sources.nth(0)).toContainText('Greg Hinkle');
  await expect(sources.nth(2)).toContainText('TanStack Table docs');
});

test('an edit elsewhere saves every citation back unchanged, the legacy link included', async () => {
  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await editor.locator('p', { hasText: 'Last line.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Edited.');
  await page.keyboard.press('ControlOrMeta+S');
  await expect
    .poll(() => fs.readFile(path.join(workspace, 'table.md'), 'utf8'), { timeout: 10_000 })
    .toBe(BODY.replace('Last line.', 'Last line. Edited.'));
});
