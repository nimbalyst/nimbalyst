/**
 * Acceptance for the Wiki's Local section on files (local-wiki plan, Phase 3).
 *
 * On a fresh user-data dir with no account, the Local section is there and
 * creates nothing on disk until the first page. Creating a page and a page
 * inside it writes `<project>/nimbalyst-local/wiki/` in the local-wiki format
 * (marker file, `Title.md` with `id` and `order` frontmatter, the child under
 * a sibling `Title/` folder). The page opens as an ordinary file tab, and text
 * typed there lands in the file. An item of a wiki type (its YAML declares
 * `storage: pages`) created with quick create is a typed page file with flat
 * frontmatter, shown in the tree. A drawing dropped into the folder is a page
 * too: it gets a hidden sidecar with its id and opens in the drawing editor.
 * After a relaunch on the same user-data dir
 * and workspace, the tree, the files and the text are all still there.
 *
 * Run with:
 *   pnpm exec playwright test e2e/pages/local-wiki-files.spec.ts --max-failures=1
 */

import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { launchElectronApp } from '../helpers';
import { PLAYWRIGHT_TEST_SELECTORS as selectors, dismissAPIKeyDialog } from '../utils/testHelpers';

const ROOT_PAGE = 'Plans';
const CHILD_PAGE = 'Q3 goals';
const SENTENCE = 'Local pages are files on disk.';
const ITEM_TITLE = 'Acme Corp';
const DRAWING = 'Board.excalidraw';
const DRAWING_JSON = '{"type":"excalidraw","version":2,"source":"e2e","elements":[],"appState":{},"files":{}}\n';
const COMPETITOR_YAML = `type: competitor
displayName: Competitor
displayNamePlural: Competitors
icon: flag
color: '#0f766e'
modes:
  inline: false
  fullDocument: true
idPrefix: cmp
idFormat: ulid
fields:
  - name: title
    type: string
    required: true
  - name: status
    type: select
    default: active
    options:
      - value: active
        label: Active
      - value: defunct
        label: Defunct
roles:
  title: title
  workflowStatus: status
sharing: personal
storage: pages
`;

function log(message: string): void {
  console.log(`[local-wiki] ${message}`);
}

function localSidebar(page: Page): Locator {
  return page.locator('[data-testid="collab-sidebar-personal"]:visible');
}

function pageRow(page: Page, name: string): Locator {
  return localSidebar(page).locator('.file-tree-file:not([data-testid="collab-tree-item-row"])', {
    has: page.locator('.file-tree-name', { hasText: new RegExp(`^${name}(\\.md)?$`) }),
  });
}

async function openPagesMode(page: Page): Promise<void> {
  const modeButton = page.getByTestId('collab-mode-button');
  await expect(modeButton).toBeVisible({ timeout: 15_000 });
  if ((await modeButton.getAttribute('aria-pressed')) !== 'true') await modeButton.click();
  await expect(localSidebar(page)).toBeVisible({ timeout: 15_000 });
}

async function ensureExpanded(row: Locator): Promise<void> {
  await expect(row).toBeVisible({ timeout: 10_000 });
  const expand = row.locator('[aria-label="Expand"]');
  if (await expand.count()) {
    await expand.click();
    return;
  }
  const closedIcon = row.locator('.file-tree-chevron', { hasText: 'keyboard_arrow_right' });
  if (await closedIcon.count()) await row.click();
}

async function closeApp(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return;
  const closed = app.close().then(() => true, () => true);
  const timedOut = new Promise<false>((resolve) => setTimeout(() => resolve(false), 20_000));
  if (!(await Promise.race([closed, timedOut]))) {
    log('app.close() did not finish in 20s; killing the app process');
    app.process().kill('SIGKILL');
  }
}

async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

test('Local pages are markdown files in the wiki folder and survive a relaunch', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'local-wiki-files-')));
  const workspace = path.join(root, 'workspace');
  const wikiRoot = path.join(workspace, 'nimbalyst-local', 'wiki');
  const rootFile = path.join(wikiRoot, `${ROOT_PAGE}.md`);
  const childFile = path.join(wikiRoot, ROOT_PAGE, `${CHILD_PAGE}.md`);
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'README.md'), '# Local wiki\n');
  await fs.mkdir(path.join(workspace, '.nimbalyst', 'trackers'), { recursive: true });
  await fs.writeFile(path.join(workspace, '.nimbalyst', 'trackers', 'competitor.yaml'), COMPETITOR_YAML);
  const itemFile = path.join(wikiRoot, `${ITEM_TITLE}.md`);

  let app: ElectronApplication | undefined;
  const launch = async (): Promise<Page> => {
    app = await launchElectronApp({
      workspace,
      preserveTestDatabase: true,
      recordVideo: { dir: path.join(testInfo.outputDir, 'video') },
      env: {
        NIMBALYST_USER_DATA_PATH: path.join(root, 'database'),
        NIMBALYST_USER_DATA_DIR: path.join(root, 'user-data'),
        NIMBALYST_CDP_PORT: '0',
      },
    });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page
      .locator('.workspace-sidebar:visible, [data-testid="collab-sidebar-personal"]:visible')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 });
    await dismissAPIKeyDialog(page);
    return page;
  };

  try {
    let page = await launch();

    await test.step('the Local section shows with no account and writes nothing yet', async () => {
      await openPagesMode(page);
      await expect(page.getByTestId('collab-sidebar-section-personal')).toContainText('Local');
      await page.waitForTimeout(1_000);
      expect(existsSync(path.join(workspace, 'nimbalyst-local'))).toBe(false);
      log('step 1 ok: Local section visible, no wiki folder on disk');
    });

    await test.step('create a page and a page inside it; both are files in the format', async () => {
      await page.getByTestId('window-top-bar-create-left').click();
      let dialog = page.getByTestId('collab-create-dialog');
      await expect(dialog).toBeVisible();
      const rootOption = dialog.getByTestId('collab-create-location-option-root');
      if (await rootOption.count()) await rootOption.click();
      await dialog.getByTestId('collab-create-name-input').fill(ROOT_PAGE);
      await dialog.locator('.collab-create-confirm').click();
      await expect(dialog).toHaveCount(0);
      await expect(pageRow(page, ROOT_PAGE)).toBeVisible({ timeout: 10_000 });

      await pageRow(page, ROOT_PAGE).click({ button: 'right' });
      await page.locator('.collab-page-new-inside').click();
      dialog = page.getByTestId('collab-create-dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByTestId('collab-create-name-input').fill(CHILD_PAGE);
      await dialog.locator('.collab-create-confirm').click();
      await expect(dialog).toHaveCount(0);
      await ensureExpanded(pageRow(page, ROOT_PAGE));
      await expect(pageRow(page, CHILD_PAGE)).toBeVisible({ timeout: 10_000 });

      const marker = await readText(path.join(wikiRoot, '.nimbalyst-wiki.yaml'));
      expect(marker).toMatch(/^formatVersion: 1$/m);
      expect(await readText(rootFile)).toMatch(/^---\nid: \S+\norder: \d+\n---\n/);
      expect(await readText(childFile)).toMatch(/^---\nid: \S+\norder: \d+\n---\n/);
      log('step 2 ok: marker, Plans.md and Plans/Q3 goals.md written with id and order');
    });

    await test.step('the page opens as a file tab and typed text lands in the file', async () => {
      await pageRow(page, ROOT_PAGE).click();
      const editor = page.locator(`[data-file-path="${rootFile}"]`).locator(selectors.contentEditable).first();
      await expect(editor).toBeVisible({ timeout: 10_000 });
      await editor.click();
      await page.keyboard.type(SENTENCE);
      await expect(editor).toContainText(SENTENCE);
      await page.keyboard.press('ControlOrMeta+s');
      await expect.poll(() => readText(rootFile), { timeout: 10_000 }).toContain(SENTENCE);
      // The editor kept the frontmatter the library owns.
      expect(await readText(rootFile)).toMatch(/^---\nid: \S+\norder: \d+\n---\n/);
      log('step 3 ok: file tab saved the sentence and kept the frontmatter');
    });

    await test.step('a drawing dropped into the folder is a page with a sidecar that opens in its editor', async () => {
      const drawingFile = path.join(wikiRoot, DRAWING);
      await fs.writeFile(drawingFile, DRAWING_JSON);
      await expect(pageRow(page, DRAWING)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => readText(path.join(wikiRoot, `.${DRAWING}.wiki.yaml`)), { timeout: 10_000 }).toMatch(/^id: \S+\ndocumentType: excalidraw\n/);
      await pageRow(page, DRAWING).click();
      const tab = page.locator(`[data-file-path="${drawingFile}"]`);
      await expect(tab.locator('.excalidraw').first()).toBeVisible({ timeout: 15_000 });
      expect(await readText(drawingFile)).toBe(DRAWING_JSON);
      log('step 3b ok: Board.excalidraw listed, sidecar written, opened in the Excalidraw editor');
    });

    await test.step('an item of a wiki type is a typed page file shown in the tree', async () => {
      await page.keyboard.press('ControlOrMeta+Shift+I');
      const search = page.locator(selectors.trackerQuickCreateTypeSearch);
      await expect(search).toBeVisible();
      await search.fill('Competitor');
      await search.press('Enter');
      const title = page.locator(selectors.trackerQuickCreateTitle);
      await title.fill(ITEM_TITLE);
      await title.press('ControlOrMeta+Enter');
      await expect(title).not.toBeVisible({ timeout: 10_000 });
      await expect.poll(() => readText(itemFile), { timeout: 10_000 }).toMatch(/^---\nid: \S+\ntype: competitor\norder: \d+\n/);
      await openPagesMode(page);
      await expect(localSidebar(page).locator('[data-testid="collab-tree-item-row"]', { hasText: ITEM_TITLE })).toBeVisible({ timeout: 10_000 });
      log('step 4 ok: quick-created competitor is Acme Corp.md with flat type frontmatter, shown in the Local tree');
    });

    await closeApp(app);
    app = undefined;
    page = await launch();

    await test.step('after a relaunch the tree, the files and the text are still there', async () => {
      await openPagesMode(page);
      await expect(pageRow(page, ROOT_PAGE)).toBeVisible({ timeout: 15_000 });
      await ensureExpanded(pageRow(page, ROOT_PAGE));
      await expect(pageRow(page, CHILD_PAGE)).toBeVisible({ timeout: 10_000 });
      expect(await readText(rootFile)).toContain(SENTENCE);
      expect(existsSync(childFile)).toBe(true);
      expect(await readText(itemFile)).toMatch(/^---\nid: \S+\ntype: competitor\n/);
      await expect(pageRow(page, DRAWING)).toBeVisible({ timeout: 10_000 });
      await expect(localSidebar(page).locator('[data-testid="collab-tree-item-row"]', { hasText: ITEM_TITLE })).toBeVisible({ timeout: 10_000 });
      await pageRow(page, ROOT_PAGE).click();
      await expect(page.locator(`[data-file-path="${rootFile}"]`).locator(selectors.contentEditable).first())
        .toContainText(SENTENCE, { timeout: 10_000 });
      log('step 5 ok: tree, files, text and the typed page survived the relaunch');
    });
  } finally {
    await closeApp(app);
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
