/**
 * An agent edit to a page shows as one "Updated <page>" line in the
 * transcript that opens the page, with no Undo (Decision 19), and an agent
 * edit to an open Local page lands as final text (Decision 20).
 *
 * A Local page is a markdown file in the wiki folder. The edit goes through
 * the open page's editor the way the agent edit path reaches a mounted Local
 * page (`personalAgentEdit` applies the replacements to the editor registered
 * at the page's file path; `aiToolSimulator.simulateApplyDiff` makes the same
 * call). The transcript rows are the ones the Claude Code SDK writes for an
 * `applyCollabDocEdit` call on the page's `personal://` uri and its result.
 *
 * Run with:
 *   npx playwright test e2e/ai/page-edit-line.spec.ts --max-failures=1
 */

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';

import { createTempWorkspace, launchElectronApp, TEST_TIMEOUTS, waitForAppReady } from '../helpers';
import { simulateApplyDiff } from '../utils/aiToolSimulator';
import { cleanupTestSessions, createTestSession, insertMessage } from '../utils/interactivePromptTestHelpers';
import { dismissAPIKeyDialog, switchToAgentMode } from '../utils/testHelpers';

const PAGE_TITLE = 'Table decisions';
const BEFORE = 'Tables: undecided.';
const AFTER = 'Tables: one shared DataTable, built once.';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspacePath: string;
/** Set when the page is created: the library's id and the page's markdown file. */
let documentId = '';
let pageFile = '';

function personalSidebar(): ReturnType<Page['locator']> {
  return page.locator('[data-testid="collab-sidebar-personal"]:visible');
}

function pageEditor(): ReturnType<Page['locator']> {
  return page.locator(`[data-file-path="${pageFile}"]:visible`);
}

async function openPagesMode(): Promise<void> {
  const modeButton = page.getByTestId('collab-mode-button');
  await expect(modeButton).toBeVisible({ timeout: 15_000 });
  if ((await modeButton.getAttribute('aria-pressed')) !== 'true') await modeButton.click();
  await expect(personalSidebar()).toBeVisible({ timeout: 15_000 });
}

async function storedBody(): Promise<string> {
  return fs.readFile(pageFile, 'utf8').catch(() => '');
}

test.beforeAll(async () => {
  workspacePath = await createTempWorkspace();
  electronApp = await launchElectronApp({
    workspace: workspacePath,
    permissionMode: 'allow-all',
    env: { PLAYWRIGHT_TEST: 'true' },
  });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
  await dismissAPIKeyDialog(page);
});

test.afterAll(async () => {
  if (page) await cleanupTestSessions(page, workspacePath).catch(() => undefined);
  await electronApp?.close();
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
});

test('an agent edit to a Local page lands directly and its transcript line opens the page', async () => {
  test.setTimeout(120_000);

  await test.step('a Local page with a body', async () => {
    const created = await page.evaluate(async ([ws, title, body]) => {
      const result = await window.electronAPI.invoke('local-wiki:command', ws, {
        type: 'register-document',
        title,
        parentFolderId: null,
        body: `# ${title}\n\n${body}\n`,
      }) as { id?: string };
      const id = result?.id ?? '';
      const filePath = await window.electronAPI.invoke('local-wiki:page-path', ws, id) as string | null;
      return { id, filePath: filePath ?? '' };
    }, [workspacePath, PAGE_TITLE, BEFORE] as const);
    documentId = created.id;
    pageFile = created.filePath;
    expect(documentId).not.toBe('');
    expect(pageFile).toMatch(/\/nimbalyst-local\/wiki\/Table decisions\.md$/);
    expect(await storedBody()).toContain(BEFORE);
  });

  await test.step('the agent edit to the open page is final text, saved with no review', async () => {
    await openPagesMode();
    await personalSidebar().locator('.file-tree-name', { hasText: PAGE_TITLE }).first().click();
    await expect(pageEditor()).toBeVisible({ timeout: TEST_TIMEOUTS.MEDIUM });

    const result = await simulateApplyDiff(page, pageFile, [{ oldText: BEFORE, newText: AFTER }]);
    expect(result.success).toBe(true);
    await expect(pageEditor()).toContainText(AFTER);
    await expect(pageEditor()).not.toContainText(BEFORE);
    await expect.poll(storedBody, { timeout: 10_000 }).toContain(AFTER);
  });

  await test.step('the transcript shows one "Updated <page>" line that opens the page', async () => {
    await switchToAgentMode(page);
    const sessionId = await createTestSession(page, workspacePath, { title: 'Page edit line' });
    const uri = `personal://${documentId}`;
    await insertMessage(page, sessionId, 'output', JSON.stringify({
      type: 'assistant',
      message: { content: [{
        type: 'tool_use',
        id: 'toolu_page_edit_1',
        name: 'mcp__nimbalyst-situational__applyCollabDocEdit',
        input: { filePath: uri, replacements: [{ oldText: BEFORE, newText: AFTER }] },
      }] },
    }), { source: 'claude-code' });
    await insertMessage(page, sessionId, 'output', JSON.stringify({
      type: 'user',
      message: { content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_page_edit_1',
        content: [{ type: 'text', text: `Updated "${PAGE_TITLE}" (${uri})` }],
      }] },
    }), { source: 'claude-code' });

    const sessionItem = page.locator(`#session-list-item-${sessionId}`);
    await expect(sessionItem).toBeVisible({ timeout: TEST_TIMEOUTS.MEDIUM });
    await sessionItem.click();

    const line = page.locator('.page-update-line:visible');
    await expect(line).toHaveCount(1, { timeout: TEST_TIMEOUTS.MEDIUM });
    await expect(line).toContainText('Updated');
    await expect(line).toContainText(PAGE_TITLE);
    await expect(line.getByText(/undo/i)).toHaveCount(0);

    await line.getByRole('button', { name: PAGE_TITLE }).click();
    await expect(pageEditor()).toBeVisible({ timeout: TEST_TIMEOUTS.MEDIUM });
    await expect(pageEditor()).toContainText(AFTER);
  });
});
