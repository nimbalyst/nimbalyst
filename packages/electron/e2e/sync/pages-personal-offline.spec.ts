/**
 * Acceptance for the Wiki's Local section on a fresh install with no account
 * and no collaboration server. Local pages are files in the wiki folder
 * (`nimbalyst-local/wiki`, local-wiki plan Phase 3).
 *
 * On a fresh user-data dir (signed out, no wrangler), Pages mode must show the
 * Local section with no error toast and no scope-resolution console error.
 * The user creates a root page and a page inside it, places the seeded
 * personal tracker type (the "Place type..." menu must not offer the seeded
 * team type; placing it makes it a wiki type, with no row of its own in the
 * tree), creates an item of that type and moves it under the child page, writes
 * a sentence into a plain page, and gives a second page a type in place right
 * after typing into it, without saving first: the unsaved text must reach the
 * file along with the type. After a relaunch on the same user-data dir and
 * workspace, the nesting, the wiki type, the moved item, the plain page with
 * its text and restored tab, and the typed page with its body are all still
 * there, in the tree and in the files.
 *
 * Run with:
 *   npx playwright test e2e/sync/pages-personal-offline.spec.ts --max-failures=1
 */

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { launchElectronApp } from '../helpers';
import { PLAYWRIGHT_TEST_SELECTORS as selectors, dismissAPIKeyDialog } from '../utils/testHelpers';

const PERSONAL_TYPE_ID = 'offline-note';
const PERSONAL_TYPE_NAME = 'Offline Note';
const PERSONAL_TYPE_PLURAL = 'Offline Notes';
const TEAM_TYPE_PLURAL = 'Team Only Specs';
const ROOT_PAGE = 'Offline Root';
const CHILD_PAGE = 'Offline Child';
const ITEM_TITLE = 'Offline item survives restart';
const PAGE_NAME = 'Offline Page';
const PAGE_SENTENCE = 'Personal pages work with no account.';
const TYPED_PAGE = 'Offline Typed';
const TYPED_SENTENCE = 'This local page keeps its words when it gets a type.';

function typeYaml(type: string, name: string, plural: string, sharing: 'personal' | 'team', prefix: string): string {
  return `type: ${type}
displayName: ${name}
displayNamePlural: ${plural}
icon: description
color: '#0f766e'
modes:
  inline: true
  fullDocument: true
idPrefix: ${prefix}
idFormat: ulid
fields:
  - name: title
    type: string
    required: true
    displayInline: true
  - name: status
    type: select
    required: false
    default: open
    displayInline: true
    options:
      - value: open
        label: Open
      - value: done
        label: Done
roles:
  title: title
  workflowStatus: status
sharing: ${sharing}
draftByDefault: false
`;
}

function log(message: string): void {
  console.log(`[P2-E] ${message}`);
}

const SCOPE_ERROR = 'Failed to resolve collaboration scope';

function captureConsole(page: Page, label: string, sink: string[]): void {
  page.on('console', (message) => {
    const text = message.text();
    if (
      message.type() === 'error' ||
      message.type() === 'warning' ||
      /CollabMode|personal|Personal|placement|typePlacement/.test(text)
    ) {
      sink.push(`[${label}] ${message.type()}: ${text.slice(0, 400)}`);
    }
  });
}

function personalSidebar(page: Page): Locator {
  return page.locator('[data-testid="collab-sidebar-personal"]:visible');
}

/** A page row (not an item row); new pages may carry a `.md` suffix. */
function namedPageRow(page: Page, name: string): Locator {
  return personalSidebar(page).locator('.file-tree-file:not([data-testid="collab-tree-item-row"])', {
    has: page.locator('.file-tree-name', { hasText: new RegExp(`^${name}(\\.md)?$`) }),
  });
}

function itemRow(page: Page): Locator {
  return personalSidebar(page).locator('[data-testid="collab-tree-item-row"]', { hasText: ITEM_TITLE });
}

function pageRow(page: Page): Locator {
  return namedPageRow(page, PAGE_NAME);
}

function typedItemRow(page: Page): Locator {
  return personalSidebar(page).locator('[data-testid="collab-tree-item-row"]', { hasText: TYPED_PAGE });
}

/** The editor of a Local page's file tab. */
function fileEditor(page: Page, file: string): Locator {
  return page.locator(`[data-file-path="${file}"]`).locator(selectors.contentEditable).first();
}

async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

async function openPagesMode(page: Page): Promise<void> {
  const modeButton = page.getByTestId('collab-mode-button');
  await expect(modeButton).toBeVisible({ timeout: 15_000 });
  if ((await modeButton.getAttribute('aria-pressed')) !== 'true') {
    await modeButton.click();
  }
  await expect(personalSidebar(page)).toBeVisible({ timeout: 15_000 });
}

/**
 * Close the app, killing it if quit has not finished in 20s: a quit that
 * stalls after the database worker closes would otherwise hold the run until
 * the test timeout and hide the result.
 */
async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  const closed = app.close().then(() => true, () => true);
  const timedOut = new Promise<false>((resolve) => setTimeout(() => resolve(false), 20_000));
  if (!(await Promise.race([closed, timedOut]))) {
    log('app.close() did not finish in 20s; killing the app process');
    app.process().kill('SIGKILL');
  }
}

/** How far `child`'s name sits right of `parent`'s: positive when nested under it. */
async function indentPast(parent: Locator, child: Locator): Promise<number> {
  const [parentBox, childBox] = await Promise.all([
    parent.locator('.file-tree-name').boundingBox(),
    child.locator('.file-tree-name').boundingBox(),
  ]);
  return (childBox?.x ?? 0) - (parentBox?.x ?? 0);
}

/** Expands a collapsed tree row via its chevron, which never opens a tab. */
async function ensureExpanded(row: Locator): Promise<void> {
  await expect(row).toBeVisible({ timeout: 10_000 });
  const expand = row.locator('[aria-label="Expand"]');
  if (await expand.count()) {
    await expand.click();
    return;
  }
  // Plain folder rows have no aria-label on the chevron; their icon says it.
  const closedIcon = row.locator('.file-tree-chevron', { hasText: 'keyboard_arrow_right' });
  if (await closedIcon.count()) await row.click();
}

test('signed-out personal page tree: nesting, placed type, moved item, page text and set type survive a relaunch', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pages-personal-offline-')));
  const workspace = path.join(root, 'workspace');
  const wikiRoot = path.join(workspace, 'nimbalyst-local', 'wiki');
  const pageFile = path.join(wikiRoot, `${PAGE_NAME}.md`);
  const typedFile = path.join(wikiRoot, `${TYPED_PAGE}.md`);
  const itemFile = path.join(wikiRoot, ROOT_PAGE, CHILD_PAGE, `${ITEM_TITLE}.md`);
  const personalTypeFile = path.join(workspace, '.nimbalyst', 'trackers', `${PERSONAL_TYPE_ID}.yaml`);
  const userDataDir = path.join(root, 'user-data');
  const databaseDir = path.join(root, 'database');
  await fs.mkdir(path.join(workspace, '.nimbalyst', 'trackers'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'README.md'), '# Offline pages\n');
  await fs.writeFile(
    personalTypeFile,
    typeYaml(PERSONAL_TYPE_ID, PERSONAL_TYPE_NAME, PERSONAL_TYPE_PLURAL, 'personal', 'offn'),
  );
  await fs.writeFile(
    path.join(workspace, '.nimbalyst', 'trackers', 'team-only-spec.yaml'),
    typeYaml('team-only-spec', 'Team Only Spec', TEAM_TYPE_PLURAL, 'team', 'tos'),
  );

  const consoleLines: string[] = [];
  let app: ElectronApplication | undefined;
  const launch = async (label: string): Promise<Page> => {
    app = await launchElectronApp({
      workspace,
      preserveTestDatabase: true,
      recordVideo: { dir: path.join(testInfo.outputDir, 'video') },
      env: {
        NIMBALYST_USER_DATA_PATH: databaseDir,
        NIMBALYST_USER_DATA_DIR: userDataDir,
        NIMBALYST_CDP_PORT: '0',
      },
    });
    const page = await app.firstWindow();
    captureConsole(page, label, consoleLines);
    await page.waitForLoadState('domcontentloaded');
    // A relaunch restores Pages mode, where the Files sidebar exists but is hidden.
    await page
      .locator('.workspace-sidebar:visible, [data-testid="collab-sidebar-personal"]:visible')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 });
    await dismissAPIKeyDialog(page);
    return page;
  };

  try {
    let page = await launch('run1');

    await test.step('Pages mode shows the Local section, signed out, with no error', async () => {
      await expect(page.getByTestId('collab-mode-button')).toBeVisible({ timeout: 15_000 });
      await openPagesMode(page);
      await expect(page.getByTestId('collab-sidebar-section-personal')).toBeVisible();
      await expect(page.getByTestId('collab-sidebar-section-personal')).toContainText('Local');
      await expect(page.getByTestId('pages-sidebar-team-note')).toBeVisible();
      await expect(page.getByTestId('collab-sidebar-section-team')).toHaveCount(0);
      // Give a failed scope resolution time to surface before asserting its absence.
      await page.waitForTimeout(1_500);
      await expect(page.locator('.error-toast--error')).toHaveCount(0);
      expect(consoleLines.filter((line) => line.includes(SCOPE_ERROR))).toEqual([]);
      log('step 1 ok: Pages button visible, Local section shown, team note shown, no error toast, no scope error');
    });

    /** Title-bar "+" creates a root page; "New page inside" creates a child. */
    const createPage = async (name: string, parent?: string) => {
      if (parent) {
        await namedPageRow(page, parent).click({ button: 'right' });
        await page.locator('.collab-page-new-inside').click();
      } else {
        await page.getByTestId('window-top-bar-create-left').click();
      }
      const dialog = page.getByTestId('collab-create-dialog');
      await expect(dialog).toBeVisible();
      if (!parent) {
        const root = dialog.getByTestId('collab-create-location-option-root');
        if (await root.count()) await root.click();
      }
      await dialog.getByTestId('collab-create-name-input').fill(name);
      await dialog.locator('.collab-create-confirm').click();
      await expect(dialog).toHaveCount(0);
      if (parent) await ensureExpanded(namedPageRow(page, parent));
      await expect(namedPageRow(page, name)).toBeVisible({ timeout: 10_000 });
    };

    /** Opens the page's file tab (creating a page may already have) and types into it. */
    const typeIntoPage = async (name: string, file: string, sentence: string): Promise<void> => {
      if (!(await fileEditor(page, file).isVisible())) await namedPageRow(page, name).click();
      const editor = fileEditor(page, file);
      await expect(editor).toBeVisible({ timeout: 10_000 });
      await editor.click();
      await page.keyboard.type(sentence);
      await expect(editor).toContainText(sentence);
    };

    await test.step('create a root page and a page inside it', async () => {
      await createPage(ROOT_PAGE);
      await createPage(CHILD_PAGE, ROOT_PAGE);
      expect(await readText(path.join(wikiRoot, `${ROOT_PAGE}.md`))).toMatch(/^---\nid: \S+/);
      expect(await readText(path.join(wikiRoot, ROOT_PAGE, `${CHILD_PAGE}.md`))).toMatch(/^---\nid: \S+/);
      log('step 2 ok: root page and nested child page visible, both files on disk');
    });

    await test.step('place the personal type; the team type is not offered and the type becomes a wiki type', async () => {
      const tree = personalSidebar(page).locator('.collab-sidebar-tree');
      await expect(tree).toBeVisible();
      const box = await tree.boundingBox();
      if (!box) throw new Error('Personal tree has no box');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height - 12, { button: 'right' });
      // Empty tree space opens New page / Place type...
      await page.locator('.collab-section-place-type').click();
      const menu = page.locator('.collab-place-type-menu');
      await expect(menu).toBeVisible();
      const options = await menu.locator('.collab-place-type-option').allInnerTexts();
      log(`step 3 place-type options: ${JSON.stringify(options.map((text) => text.replace(/^\S+\s*/, '').trim()))}`);
      await expect(menu.locator('.collab-place-type-option', { hasText: PERSONAL_TYPE_PLURAL })).toHaveCount(1);
      await expect(menu.locator('.collab-place-type-option', { hasText: TEAM_TYPE_PLURAL })).toHaveCount(0);
      await menu.locator('.collab-place-type-option', { hasText: PERSONAL_TYPE_PLURAL }).click();
      // Placing a type in the wiki makes it a wiki type: its items are files.
      // A page type gets no row of its own in the Local tree (its items are
      // files wherever they sit; a known gap of the files-backed section).
      await expect.poll(() => readText(personalTypeFile), { timeout: 10_000 }).toMatch(/^storage: pages$/m);
      log('step 3 ok: personal type placed (storage: pages); team type absent from the menu');
    });

    await test.step('create an item of the personal type and move it under the child page', async () => {
      await page.keyboard.press('ControlOrMeta+Shift+I');
      const search = page.locator(selectors.trackerQuickCreateTypeSearch);
      await expect(search).toBeVisible();
      await search.fill(PERSONAL_TYPE_NAME);
      await search.press('Enter');
      const title = page.locator(selectors.trackerQuickCreateTitle);
      await title.fill(ITEM_TITLE);
      await title.press('ControlOrMeta+Enter');
      await expect(title).not.toBeVisible({ timeout: 10_000 });
      await openPagesMode(page);
      await expect(itemRow(page)).toBeVisible({ timeout: 10_000 });
      await expect.poll(() => readText(path.join(wikiRoot, `${ITEM_TITLE}.md`)), { timeout: 10_000 })
        .toMatch(new RegExp(`^type: ${PERSONAL_TYPE_ID}$`, 'm'));
      log('step 4 item row visible; the item is a typed page file at the wiki root');

      await itemRow(page).click({ button: 'right' });
      await page.locator('.collab-item-move-to').click();
      const moveDialog = page.locator('.collab-page-move-dialog');
      await expect(moveDialog).toBeVisible();
      await moveDialog.locator('.collab-page-move-option', { hasText: CHILD_PAGE }).click();
      await moveDialog.locator('.collab-page-move-confirm').click();
      await expect(moveDialog).toHaveCount(0);
      await ensureExpanded(namedPageRow(page, CHILD_PAGE));
      await expect(itemRow(page)).toHaveCount(1);
      await expect(itemRow(page)).toBeVisible({ timeout: 10_000 });
      await expect.poll(() => indentPast(namedPageRow(page, CHILD_PAGE), itemRow(page)), { timeout: 10_000 }).toBeGreaterThan(4);
      await expect.poll(() => readText(itemFile), { timeout: 10_000 }).toMatch(new RegExp(`^type: ${PERSONAL_TYPE_ID}$`, 'm'));
      log('step 4 ok: item moved under the child page; its file moved into the child page folder');
    });

    await test.step('create a Local page and type a sentence into its file tab', async () => {
      await createPage(PAGE_NAME);
      await typeIntoPage(PAGE_NAME, pageFile, PAGE_SENTENCE);
      await page.keyboard.press('ControlOrMeta+s');
      await expect.poll(() => readText(pageFile), { timeout: 10_000 }).toContain(PAGE_SENTENCE);
      log('step 5 ok: the page file holds the sentence');
    });

    await test.step('set type on a page right after typing, without saving first', async () => {
      await createPage(TYPED_PAGE);
      await typeIntoPage(TYPED_PAGE, typedFile, TYPED_SENTENCE);
      // No save: Set type must write the open editor's text to the file first.
      await namedPageRow(page, TYPED_PAGE).click({ button: 'right' });
      await page.locator('.collab-page-set-type').click();
      const dialog = page.getByTestId('set-page-type-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('set-page-type-option-team-only-spec')).toHaveCount(0);
      await dialog.getByTestId(`set-page-type-option-${PERSONAL_TYPE_ID}`).click();
      await expect(dialog).toHaveCount(0, { timeout: 20_000 });
      await expect(typedItemRow(page)).toBeVisible({ timeout: 10_000 });
      await expect(namedPageRow(page, TYPED_PAGE)).toHaveCount(0);
      // Same file, now typed, with the text typed before Set type; the editor's
      // later saves keep the type.
      await page.waitForTimeout(3_000);
      const typed = await readText(typedFile);
      expect(typed).toMatch(new RegExp(`^type: ${PERSONAL_TYPE_ID}$`, 'm'));
      expect(typed).toContain(TYPED_SENTENCE);
      await expect(fileEditor(page, typedFile)).toContainText(TYPED_SENTENCE);
      log('step 6 ok: the page file gained the type in place and kept the unsaved sentence');
    });

    // Let tab persistence settle, then relaunch on the same user data and workspace.
    await page.waitForTimeout(1_000);
    await closeApp(app);
    app = undefined;
    log('closed run 1');

    page = await launch('run2');

    await test.step('after relaunch the tree, item, page text, tab and typed page are back', async () => {
      await openPagesMode(page);
      await expect(page.locator('.error-toast--error')).toHaveCount(0);
      await ensureExpanded(namedPageRow(page, ROOT_PAGE));
      await expect(namedPageRow(page, CHILD_PAGE)).toBeVisible({ timeout: 10_000 });
      log('step 7 root and child pages present');
      expect(await readText(personalTypeFile)).toMatch(/^storage: pages$/m);
      await ensureExpanded(namedPageRow(page, CHILD_PAGE));
      await expect(itemRow(page)).toBeVisible({ timeout: 10_000 });
      expect(await indentPast(namedPageRow(page, CHILD_PAGE), itemRow(page))).toBeGreaterThan(4);
      log('step 7 moved item present under the child page');
      await expect(typedItemRow(page)).toBeVisible({ timeout: 10_000 });
      await expect(namedPageRow(page, TYPED_PAGE)).toHaveCount(0);
      log('step 7 typed page present as an item row');
      await expect(pageRow(page)).toBeVisible({ timeout: 10_000 });
      const restoredTab = page.locator(`.tab[data-filename]:visible`, { hasText: PAGE_NAME });
      await expect(restoredTab).toHaveCount(1, { timeout: 15_000 });
      log('step 7 page tab restored');
      if (!(await fileEditor(page, pageFile).isVisible())) await restoredTab.click();
      await expect(fileEditor(page, pageFile)).toContainText(PAGE_SENTENCE, { timeout: 10_000 });
      await typedItemRow(page).click();
      await expect(fileEditor(page, typedFile)).toContainText(TYPED_SENTENCE, { timeout: 10_000 });
      expect(await readText(typedFile)).toMatch(new RegExp(`^type: ${PERSONAL_TYPE_ID}$`, 'm'));
      expect(await readText(itemFile)).toMatch(new RegExp(`^type: ${PERSONAL_TYPE_ID}$`, 'm'));
      expect(consoleLines.filter((line) => line.includes(SCOPE_ERROR))).toEqual([]);
      log('step 7 ok: page text and typed page body restored from their files; no scope error in either run');
    });
  } catch (error) {
    console.log(`[P2-E] renderer console (last 80 relevant lines):\n${consoleLines.slice(-80).join('\n')}`);
    throw error;
  } finally {
    await closeApp(app);
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
