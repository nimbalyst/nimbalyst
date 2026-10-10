/**
 * Decision and open-question marks on a sentence (knowledge pages Phase 4,
 * Decision 17), and the cross-page marks list (Decision 21).
 *
 * 1. In a local markdown file, select a sentence, choose "Mark decided" in the
 *    floating toolbar, fill who / not chosen in the small editor, and save:
 *    the chip and the faint line draw, and the file holds
 *    `[sentence]{decided by="..." on=... over="..."}` with the rest unchanged.
 * 2. A Local wiki page (a markdown file in the wiki folder) whose body holds
 *    an open mark is listed by `page-marks:list` under its `personal://` uri,
 *    and its file tab draws the mark.
 *
 * Runs signed out on a temp workspace; no account or server needed.
 *
 *   npx playwright test e2e/pages/page-marks.spec.ts --max-failures=1
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ACTIVE_EDITOR_SELECTOR, TEST_TIMEOUTS, createTempWorkspace, launchElectronApp } from '../helpers';
import { dismissAPIKeyDialog, openFileFromTree, waitForWorkspaceReady } from '../utils/testHelpers';

test.describe.configure({ mode: 'serial' });

const SENTENCE = 'Storage and evaluation live in Flagship.';
const FLAGS = ['# Flags', '', `${SENTENCE} Exposure is logged by us.`, '', 'Last line.', ''].join('\n');
const OPEN_BODY = 'Notes\n\n[Is Flagship fast enough on the hot path?]{open by="Spike 6"}\n';

let app: ElectronApplication;
let page: Page;
let workspace: string;

test.beforeAll(async () => {
  workspace = await createTempWorkspace();
  await fs.writeFile(path.join(workspace, 'flags.md'), FLAGS, 'utf8');
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

test('marking a sentence decided draws the chip and the faint line and saves the span syntax', async () => {
  await openFileFromTree(page, 'flags.md');
  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await expect(editor).toBeVisible({ timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  // Select exactly the first sentence of the paragraph.
  const paragraph = editor.locator('p', { hasText: SENTENCE });
  await paragraph.click({ position: { x: 2, y: 5 } });
  await page.keyboard.press('Home');
  for (let i = 0; i < SENTENCE.length; i++) await page.keyboard.press('Shift+ArrowRight');

  await page.getByTestId('floating-toolbar-action-mark-decided').click();
  const markEditor = page.getByTestId('page-mark-editor');
  await expect(markEditor).toBeVisible();
  await markEditor.getByPlaceholder('Name').fill('Greg');
  await markEditor.getByPlaceholder('What was set aside').fill('our own engine');
  await page.getByTestId('page-mark-editor-save').click();
  await expect(markEditor).toHaveCount(0);

  const mark = editor.locator('.page-mark--decided');
  await expect(mark).toHaveText(SENTENCE);
  await expect(mark).toHaveAttribute('data-page-mark-who', /^Greg, \w{3} \d+, over our own engine$/);

  await page.keyboard.press('ControlOrMeta+S');
  await expect
    .poll(() => fs.readFile(path.join(workspace, 'flags.md'), 'utf8'), { timeout: 10_000 })
    .toMatch(new RegExp(`^# Flags\\n\\n\\[${SENTENCE.replace('.', '\\.')}\\]\\{decided by="Greg" on=\\d{4}-\\d{2}-\\d{2} over="our own engine"\\} Exposure is logged by us\\.\\n\\nLast line\\.`));
});

test('a Local page with an open question is listed by the marks query', async () => {
  await page.getByTestId('collab-mode-button').click();
  await expect(page.getByTestId('collab-sidebar-section-personal')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('window-top-bar-create-left').click();
  const dialog = page.getByTestId('collab-create-dialog');
  await expect(dialog).toBeVisible();
  const root = dialog.getByTestId('collab-create-location-option-root');
  if (await root.count()) await root.click();
  await dialog.getByTestId('collab-create-name-input').fill('Flag notes');
  await dialog.locator('.collab-create-confirm').click();
  await expect(dialog).toHaveCount(0);

  // The page is a file in the wiki folder; its id is in the frontmatter.
  // The workspace path the app was launched with (not its realpath): tabs key on it.
  const pageFile = path.join(workspace, 'nimbalyst-local', 'wiki', 'Flag notes.md');
  await expect.poll(() => fs.readFile(pageFile, 'utf8').catch(() => ''), { timeout: 10_000 }).toMatch(/^---\nid: \S+/);
  const frontmatter = (await fs.readFile(pageFile, 'utf8')).match(/^---\n[\s\S]*?\n---\n/)![0];
  const documentId = frontmatter.match(/^id: (\S+)$/m)![1];
  const tab = page.locator(`[data-file-path="${pageFile}"]`);
  if (!(await tab.isVisible())) await page.locator('[data-testid="collab-sidebar-personal"]:visible').locator('.file-tree-name', { hasText: /^Flag notes(\.md)?$/ }).click();
  await expect(tab).toBeVisible({ timeout: 10_000 });

  // Write the body to the file, as an agent edit would.
  await fs.writeFile(pageFile, `${frontmatter}${OPEN_BODY}`, 'utf8');

  await expect
    .poll(async () => {
      const result = await page.evaluate(
        (ws) => window.electronAPI.invoke('page-marks:list', { workspacePath: ws, query: { kind: 'open' } }),
        workspace,
      ) as { success: boolean; marks?: Array<{ plainText: string; by: string | null; page: { uri: string } }> };
      return result.marks?.map((m) => [m.plainText, m.by, m.page.uri]);
    }, { timeout: 10_000 })
    .toEqual([['Is Flagship fast enough on the hot path?', 'Spike 6', `personal://${documentId}`]]);

  await expect(tab.locator('.page-mark--open')).toHaveText('Is Flagship fast enough on the hot path?', { timeout: 10_000 });
});
