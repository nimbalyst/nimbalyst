/**
 * A Local wiki page an agent edited opens in the Wiki showing the edited text,
 * never the red/green review: no diff header, no diff marks, and the pending
 * edit is accepted rather than left waiting.
 *
 * Runs signed out on a temp workspace; no account or server needed.
 *
 *   pnpm exec playwright test e2e/pages/local-wiki-agent-edit.spec.ts --max-failures=1
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { launchElectronApp } from '../helpers';
import { PLAYWRIGHT_TEST_SELECTORS as selectors, dismissAPIKeyDialog } from '../utils/testHelpers';

const FRONTMATTER = '---\nid: 01JWIKIAGENTEDIT0000000000\norder: 1000\n---\n';
const BEFORE = `${FRONTMATTER}\nThe plan is to ship in March.\n`;
const AFTER = `${FRONTMATTER}\nThe plan is to ship in April.\n`;

let app: ElectronApplication | undefined;
let root: string;

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test('an agent-edited wiki page opens with the edit applied, not under review', async () => {
  test.setTimeout(90_000);
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'local-wiki-agent-edit-')));
  const workspace = path.join(root, 'workspace');
  const wikiRoot = path.join(workspace, 'nimbalyst-local', 'wiki');
  const pageFile = path.join(wikiRoot, 'Plans.md');
  await fs.mkdir(wikiRoot, { recursive: true });
  await fs.writeFile(path.join(wikiRoot, '.nimbalyst-wiki.yaml'), 'formatVersion: 1\n');
  // Disk holds the agent's version; the history holds the pre-edit tag.
  await fs.writeFile(pageFile, AFTER);

  app = await launchElectronApp({
    workspace,
    env: {
      NIMBALYST_USER_DATA_PATH: path.join(root, 'database'),
      NIMBALYST_USER_DATA_DIR: path.join(root, 'user-data'),
      NIMBALYST_CDP_PORT: '0',
    },
  });
  const page: Page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await dismissAPIKeyDialog(page);

  await page.evaluate(async ({ wp, fp, before }) => {
    await (window as any).electronAPI.history.createTag(wp, fp, 'wiki-agent-edit-tag', before, 'wiki-agent-session', 'wiki-agent-tool');
  }, { wp: workspace, fp: pageFile, before: BEFORE });

  const modeButton = page.getByTestId('collab-mode-button');
  await expect(modeButton).toBeVisible({ timeout: 15_000 });
  if ((await modeButton.getAttribute('aria-pressed')) !== 'true') await modeButton.click();
  const sidebar = page.locator('[data-testid="collab-sidebar-personal"]:visible');
  const row = sidebar.locator('.file-tree-file', { has: page.locator('.file-tree-name', { hasText: /^Plans(\.md)?$/ }) });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();

  const tab = page.locator(`[data-file-path="${pageFile}"]`);
  const editor = tab.locator(selectors.contentEditable).first();
  await expect(editor).toContainText('ship in April', { timeout: 15_000 });
  // Give a diff presentation time to land before asserting it never did.
  await page.waitForTimeout(1_500);
  await expect(tab.locator('.unified-diff-header')).toHaveCount(0);
  await expect(editor).not.toContainText('March');
  expect(await fs.readFile(pageFile, 'utf8')).toBe(AFTER);
});
