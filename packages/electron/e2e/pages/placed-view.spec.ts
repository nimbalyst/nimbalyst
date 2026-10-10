/**
 * Views placed in a page (knowledge pages Phase 6, Decision 22).
 *
 * A page holds `[Label](https://console.nimbalyst.com/.../view/type/<typeId> "...")`
 * with the view's definition in the link title; older `nimbalyst://view/...`
 * links still draw. The link draws as a live table whose cells edit the
 * items, or as a 2x2 of two number fields with pinned points; the slash menu
 * places one; a static ```2x2 fence draws the same chart from typed-in points.
 *
 * Runs against a local workspace: the competitor type comes from a YAML schema
 * and its items are created over the tracker IPC, so no account is needed.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs/promises';
import * as path from 'path';
import { launchElectronApp, createTempWorkspace, TEST_TIMEOUTS, ACTIVE_EDITOR_SELECTOR } from '../helpers';
import { dismissAPIKeyDialog, waitForWorkspaceReady, openFileFromTree } from '../utils/testHelpers';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

const COMPETITOR_YAML = `type: competitor
displayName: Competitor
displayNamePlural: Competitors
icon: flag
color: "#a78bfa"
modes:
  inline: false
  fullDocument: true
idPrefix: cmp
idFormat: ulid
fields:
  - name: title
    type: string
    required: true
  - name: devFirst
    type: number
  - name: realtime
    type: number
`;

const LANDSCAPE = [
  '# Competitive landscape',
  '',
  'Realtime is the bet.',
  '',
  // A console link (Decision 23) and, below, an app link from before it: both draw.
  '[Competitors](https://console.nimbalyst.com/app/view/type/competitor "cols=title,devFirst,realtime sort=realtime:desc")',
  '',
  '[Landscape](nimbalyst://view/type/competitor "mode=2x2 x=devFirst y=realtime pin=UserCurrent@0.85,0.9")',
  '',
  '```2x2',
  'x: Closed -> Open',
  'y: Batch -> Realtime',
  '- Typed point: 0.3, 0.6 !',
  '```',
  '',
].join('\n');

async function competitorRealtime(title: string): Promise<unknown> {
  return page.evaluate(async (wanted) => {
    const items = await (window as any).electronAPI.invoke('document-service:tracker-items-list');
    const item = (items as Array<{ title?: string; customFields?: Record<string, unknown>; fields?: Record<string, unknown> }>)
      .find((entry) => entry.title === wanted);
    return item?.customFields?.realtime ?? item?.fields?.realtime;
  }, title);
}

test.beforeAll(async () => {
  test.setTimeout(60_000);
  workspaceDir = await createTempWorkspace();
  const trackersDir = path.join(workspaceDir, '.nimbalyst', 'trackers');
  await fs.mkdir(trackersDir, { recursive: true });
  await fs.writeFile(path.join(trackersDir, 'competitor.yaml'), COMPETITOR_YAML, 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'landscape.md'), LANDSCAPE, 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'empty.md'), '# Empty\n\n', 'utf8');

  electronApp = await launchElectronApp({ workspace: workspaceDir, permissionMode: 'allow-all' });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await dismissAPIKeyDialog(page);
  await waitForWorkspaceReady(page);

  await page.evaluate(async (workspace) => {
    const create = (id: string, title: string, devFirst: number, realtime: number) =>
      (window as any).electronAPI.invoke('document-service:create-tracker-item', {
        id, type: 'competitor', title, status: 'active', priority: 'medium', workspace,
        customFields: { devFirst, realtime },
      });
    await create('cmp_salesforce', 'Salesforce', 0.15, 0.85);
    await create('cmp_posthog', 'PostHog', 0.9, 0.3);
  }, workspaceDir);
});

test.afterAll(async () => {
  test.setTimeout(60_000);
  await electronApp?.close();
  if (workspaceDir) await fs.rm(workspaceDir, { recursive: true, force: true });
});

test('a placed table and a placed 2x2 draw live from the items', async () => {
  await openFileFromTree(page, 'landscape.md');
  await expect(page.locator(ACTIVE_EDITOR_SELECTOR)).toBeVisible({ timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  const table = page.locator('[data-testid="tracker-saved-view-embed"]').first();
  await expect(table).toBeVisible({ timeout: 10000 });
  await expect(table).toContainText('2 items');
  await expect(table).toContainText('Salesforce');

  const quadrant = page.locator('[data-testid="placed-view-quadrant"]');
  await expect(quadrant).toContainText('2 placed');
  await expect(quadrant.locator('[data-pinned="true"]')).toContainText('UserCurrent');

  // The static fence draws the same chart from the typed-in point.
  await expect(page.locator('[data-testid="quadrant-block"]')).toContainText('Typed point');
});

test('editing a cell in the placed table edits the item', async () => {
  const table = page.locator('[data-testid="tracker-saved-view-embed"]').first();
  const cell = table.locator('revogr-data [role="gridcell"]', { hasText: '0.3' }).first();
  await cell.dblclick();
  // RevoGrid mounts and focuses its editor asynchronously after double-click.
  await expect(table.locator('.tracker-grid-editor-input')).toBeFocused();
  await page.keyboard.press('Meta+A');
  await page.keyboard.type('0.45');
  await page.keyboard.press('Enter');

  await expect.poll(() => competitorRealtime('PostHog'), { timeout: 5000 }).toBe(0.45);
  // The 2x2 on the same page follows the edit.
  await expect(page.locator('[data-testid="placed-view-quadrant"] [data-testid="quadrant-chart"]')).toContainText('PostHog');
});

test('the slash menu places a view of a type, and the page stores its console link', async () => {
  await openFileFromTree(page, 'empty.md');
  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await expect(editor).toBeVisible({ timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await editor.click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/Competitors');
  await page.getByRole('option').filter({ has: page.getByText('Table: Competitors', { exact: true }) }).click();

  await expect(editor.locator('[data-testid="tracker-saved-view-embed"]')).toBeVisible({ timeout: 10000 });
  await expect.poll(async () => fs.readFile(path.join(workspaceDir, 'empty.md'), 'utf8'), { timeout: 8000 })
    // A workspace file is not a team page, so the link is scoped `local`.
    .toContain('[Competitors](https://console.nimbalyst.com/app/view/type/competitor)');
});


test('view settings persist in markdown and new items are created from the embed', async () => {
  await openFileFromTree(page, 'landscape.md');
  const table = page.getByTestId('tracker-saved-view-embed').first();
  await table.locator('revogr-header').getByText('Realtime', { exact: true }).click();
  await expect.poll(async () => fs.readFile(path.join(workspaceDir, 'landscape.md'), 'utf8'), { timeout: 8000 }).toContain('sort=realtime:asc');
  const settings = page.locator('.placed-view-settings').first();
  await settings.getByRole('button', { name: /View settings/ }).click();
  await page.getByRole('dialog', { name: 'View settings' }).getByRole('button', { name: /Layout/ }).click();
  await page.getByTestId('tracker-display-view-mode-list').click();
  await page.keyboard.press('Escape');
  await expect.poll(async () => fs.readFile(path.join(workspaceDir, 'landscape.md'), 'utf8'), { timeout: 8000 }).toContain('mode=list');
  await openFileFromTree(page, 'empty.md');
  await openFileFromTree(page, 'landscape.md');
  const view = page.getByTestId('tracker-saved-view-embed').first();
  await expect(view).toHaveAttribute('data-view-mode', 'list');
  await view.getByRole('button', { name: '+ New', exact: true }).click();
  await view.getByLabel('New item title').fill('New competitor from view');
  await view.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(view).toContainText('New competitor from view');
  await expect(view).toContainText('3 items');
  // The full view retains the current definition and explores without editing the source.
  const source = await fs.readFile(path.join(workspaceDir, 'landscape.md'), 'utf8');
  await page.getByRole('button', { name: 'Open full view', exact: true }).first().click();
  const fullView = page.getByTestId('type-page-table');
  await expect(fullView).toContainText('Unsaved view');
  await expect(fullView.getByTestId('tracker-saved-view-embed')).toHaveAttribute('data-view-mode', 'list');
  await fullView.getByRole('button', { name: /View settings/ }).click();
  await page.getByRole('dialog', { name: 'View settings' }).getByRole('button', { name: /Layout/ }).click();
  await page.getByTestId('tracker-display-view-mode-table').click();
  await page.keyboard.press('Escape');
  await expect(fullView.getByTestId('tracker-saved-view-embed')).toHaveAttribute('data-view-mode', 'table');
  expect(await fs.readFile(path.join(workspaceDir, 'landscape.md'), 'utf8')).toBe(source);
  await fullView.getByRole('tab', { name: 'All', exact: true }).click();
  await expect(fullView).not.toContainText('Unsaved view');
});

test('named type views survive reload and carry their definition when placed elsewhere', async () => {
  const type = page.getByTestId('type-page-table');
  await type.getByRole('button', { name: 'Add view', exact: true }).click();
  await type.getByLabel('View name').fill('Research list');
  await type.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(type.getByRole('tab', { name: 'Research list', exact: true })).toHaveAttribute('aria-selected', 'true');
  await type.getByRole('button', { name: /View settings/ }).click();
  await page.getByRole('dialog', { name: 'View settings' }).getByRole('button', { name: /Layout/ }).click();
  await page.getByTestId('tracker-display-view-mode-list').click();
  await page.keyboard.press('Escape');
  await expect(type.getByTestId('tracker-saved-view-embed')).toHaveAttribute('data-view-mode', 'list');
  await type.getByRole('button', { name: 'Place in page', exact: true }).click();
  await expect(type.getByLabel('View link to copy')).toHaveValue(/mode=list/);
  await type.getByRole('button', { name: 'Rename view', exact: true }).click();
  await type.getByLabel('View name').fill('Research');
  await type.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(type.getByRole('tab', { name: 'Research', exact: true })).toBeVisible();
  // Leave through the tab's existing save/flush lifecycle, then reload the real app.
  await type.getByRole('tab', { name: 'All', exact: true }).click();
  await expect.poll(() => page.evaluate(async workspace => {
    const result = await (window as any).electronAPI.invoke('personal-pages:get-body', workspace, 'type-page:competitor');
    return result?.content;
  }, workspaceDir)).toContain('"name":"Research"');
  await page.reload();
  await expect(page.getByTestId('type-page-table').getByRole('tab', { name: 'Research', exact: true })).toBeVisible({ timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.getByTestId('type-page-table').getByRole('tab', { name: 'Research', exact: true }).click();
  await expect(page.getByTestId('type-page-table').getByTestId('tracker-saved-view-embed')).toHaveAttribute('data-view-mode', 'list');
});
