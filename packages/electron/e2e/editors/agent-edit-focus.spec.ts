/**
 * Focus-retention during agent edits (NIM-752)
 *
 * Reproduces the reported bug: when an AI session is actively editing a file the
 * user has open (markdown/Lexical), and the user is typing in the chat box,
 * keyboard focus is pulled from the chat textarea into the open editor, so the
 * user's keystrokes silently land in the file.
 *
 * The diff-apply path (root.clear reset + APPLY_MARKDOWN_REPLACE_COMMAND node
 * commit) reconciles Lexical's DOM selection, which focuses the contentEditable.
 * The fix tags those updates with SKIP_DOM_SELECTION_TAG when the editor isn't
 * focused, so the chat input keeps focus.
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
  ACTIVE_EDITOR_SELECTOR,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  openFileFromTree,
  openAIChatWithSession,
} from '../utils/testHelpers';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();
  await fs.writeFile(
    path.join(workspaceDir, 'focus-test.md'),
    '# Focus Test\n\nFirst paragraph baseline content.\n\nSecond paragraph baseline content.\n',
    'utf8'
  );

  electronApp = await launchElectronApp({ workspace: workspaceDir });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);
  await dismissProjectTrustToast(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  if (workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('agent diff on an open file does not steal focus from the chat input', async () => {
  const mdPath = path.join(workspaceDir, 'focus-test.md');
  const baseline = '# Focus Test\n\nFirst paragraph baseline content.\n\nSecond paragraph baseline content.\n';
  const aiContent = '# Focus Test\n\nFirst paragraph UPDATED BY AGENT.\n\nSecond paragraph UPDATED BY AGENT.\n';

  await fs.writeFile(mdPath, baseline, 'utf8');

  // Open the file in FilesMode (real Lexical editor attaches to DocumentModel)
  await openFileFromTree(page, 'focus-test.md');
  await page.waitForSelector(ACTIVE_EDITOR_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Click into the editor first so it holds a lingering RangeSelection -- this
  // matches the real scenario (the user had the file open and placed a cursor
  // in it) and is what makes the diff-apply reconciliation pull focus back.
  const editorForFocus = page.locator(ACTIVE_EDITOR_SELECTOR);
  await editorForFocus.click();
  await page.keyboard.press('End');
  await page.waitForTimeout(100);

  // Open the Files-mode AI chat panel and focus its input -- this is where the
  // user is typing while the agent edits the open file.
  await openAIChatWithSession(page);
  const chatInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.filesChatInput);
  await chatInput.click();
  await chatInput.fill('');
  await page.keyboard.type('BEFORE');

  // Sanity: the chat input holds focus before the agent edit.
  await expect.poll(async () =>
    page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
  ).toBe('files-mode-chat-input');

  // Pre-edit tag so the file watcher correlates the AI disk write to a session
  // and routes it through DocumentModel's diff session (onDiffRequested ->
  // applyDiffState), which is the focus-stealing path.
  await page.evaluate(async ({ workspacePath, filePath, content }) => {
    await window.electronAPI.history.createTag(
      workspacePath,
      filePath,
      `focus-test-tag-${Date.now()}`,
      content,
      'focus-test-session',
      'tool-focus-test',
    );
  }, { workspacePath: workspaceDir, filePath: mdPath, content: baseline });
  await page.waitForTimeout(200);

  // Simulate the agent writing to disk -> diff is applied to the open editor.
  await fs.writeFile(mdPath, aiContent, 'utf8');

  // Wait for the diff to land in the editor.
  await page.waitForSelector(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader, { timeout: 5000 });
  await page.waitForTimeout(500);

  // The chat input must STILL hold focus -- the diff apply must not have pulled
  // focus into the contentEditable.
  const activeTestId = await page.evaluate(() =>
    document.activeElement?.getAttribute('data-testid')
  );
  expect(activeTestId).toBe('files-mode-chat-input');

  // And continued typing must land in the chat input, not in the file.
  await page.keyboard.type('AFTER');
  await expect(chatInput).toHaveValue('BEFOREAFTER');

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await expect(editor).not.toContainText('BEFORE');
  await expect(editor).not.toContainText('AFTER');
});
