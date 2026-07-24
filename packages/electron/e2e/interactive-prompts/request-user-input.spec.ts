/**
 * E2E Tests for RequestUserInput Widget
 *
 * Covers the three interactive field types end-to-end via the durable-prompt
 * test harness (no real AI calls). Uses the same DB-insertion helpers as the
 * AskUserQuestion suite and asserts on the rendered widget.
 *
 * Each test creates its own session, inserts a pending tool_use, verifies the
 * widget is in the expected pending state, and (where applicable) inserts a
 * tool_result to confirm the completed state renders.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  TEST_TIMEOUTS,
} from '../helpers';
import {
  createTestSession,
  insertUserPrompt,
  insertPendingRequestUserInput,
  insertRequestUserInputResult,
  cleanupTestSessions,
  INTERACTIVE_PROMPT_SELECTORS,
} from '../utils/interactivePromptTestHelpers';
import { switchToAgentMode } from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

let app: ElectronApplication;
let page: Page;
let workspacePath: string;

test.describe('RequestUserInput Widget', () => {
  test.beforeAll(async () => {
    workspacePath = await createTempWorkspace();
    await fs.writeFile(
      path.join(workspacePath, 'test.md'),
      '# Test Document\n\nContent for testing.\n',
      'utf8',
    );

    app = await launchElectronApp({
      workspace: workspacePath,
      permissionMode: 'allow-all',
    });
    page = await app.firstWindow();
    await waitForAppReady(page);

    await switchToAgentMode(page);
    await page.waitForTimeout(500);
  });

  test.afterAll(async () => {
    if (page) {
      await cleanupTestSessions(page, workspacePath);
    }
    if (app) {
      await app.close();
    }
    await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
  });

  test('multiSelect: renders rich rows and toggles selection', async () => {
    const sessionId = await createTestSession(page, workspacePath, {
      title: 'Test RUI multiSelect',
    });
    await insertUserPrompt(page, sessionId, 'Pick the sessions to clean up');

    const { id: toolId } = await insertPendingRequestUserInput(page, sessionId, {
      title: 'Cleanup sessions',
      intro: 'Found 3 stale sessions.',
      fields: [
        {
          type: 'multiSelect',
          id: 'sessionsToArchive',
          label: 'Sessions',
          items: [
            { id: 's1', title: 'Refactor settings panel', subtitle: 'Last touched 47d ago', defaultChecked: true },
            { id: 's2', title: 'Investigate sync warning', subtitle: 'Last touched 33d ago', defaultChecked: true },
            { id: 's3', title: 'iOS test infrastructure', subtitle: 'Last touched 35d ago' },
          ],
        },
      ],
    });

    expect(toolId).toBeTruthy();

    await page.waitForTimeout(1000);
    const sessionItem = page.locator(`#session-list-item-${sessionId}`);
    await expect(sessionItem).toBeVisible({ timeout: TEST_TIMEOUTS.MEDIUM });
    await sessionItem.click();
    await page.waitForTimeout(1000);

    const widget = page.locator(INTERACTIVE_PROMPT_SELECTORS.requestUserInputWidget);
    await expect(widget).toBeVisible({ timeout: TEST_TIMEOUTS.VERY_LONG });
    await expect(widget).toHaveAttribute('data-state', 'pending');

    // Two of three rows are pre-checked from defaultChecked.
    const rows = widget.locator(INTERACTIVE_PROMPT_SELECTORS.requestUserInputMultiSelectRow);
    await expect(rows).toHaveCount(3);

    const s1 = rows.filter({ has: page.locator('text=Refactor settings panel') });
    const s2 = rows.filter({ has: page.locator('text=Investigate sync warning') });
    const s3 = rows.filter({ has: page.locator('text=iOS test infrastructure') });
    await expect(s1).toHaveAttribute('data-selected', 'true');
    await expect(s2).toHaveAttribute('data-selected', 'true');
    await expect(s3).toHaveAttribute('data-selected', 'false');

    // Toggle s3 on, s1 off.
    await s3.click();
    await s1.click();
    await expect(s1).toHaveAttribute('data-selected', 'false');
    await expect(s3).toHaveAttribute('data-selected', 'true');

    // Submit button is enabled because at least one row is selected.
    const submit = widget.locator(INTERACTIVE_PROMPT_SELECTORS.requestUserInputSubmitButton);
    await expect(submit).toBeEnabled();
  });

  test('reorder: renders rows with drag handles and remove buttons', async () => {
    const sessionId = await createTestSession(page, workspacePath, {
      title: 'Test RUI reorder',
    });
    await insertUserPrompt(page, sessionId, 'Confirm task order');

    await insertPendingRequestUserInput(page, sessionId, {
      title: 'Confirm task order',
      fields: [
        {
          type: 'reorder',
          id: 'tasks',
          label: 'Tasks',
          minItems: 1,
          items: [
            { id: 't1', title: 'Run unit tests', subtitle: '~12s', removable: true },
            { id: 't2', title: 'Run typecheck', subtitle: '~25s', removable: true },
            { id: 't3', title: 'Build electron renderer', subtitle: '~40s', removable: true },
          ],
        },
      ],
    });

    await page.waitForTimeout(1000);
    const sessionItem = page.locator(`#session-list-item-${sessionId}`);
    await expect(sessionItem).toBeVisible({ timeout: TEST_TIMEOUTS.MEDIUM });
    await sessionItem.click();
    await page.waitForTimeout(1000);

    const widget = page.locator(INTERACTIVE_PROMPT_SELECTORS.requestUserInputWidget);
    await expect(widget).toBeVisible({ timeout: TEST_TIMEOUTS.VERY_LONG });
    await expect(widget).toHaveAttribute('data-state', 'pending');

    const rows = widget.locator(INTERACTIVE_PROMPT_SELECTORS.requestUserInputReorderRow);
    await expect(rows).toHaveCount(3);

    // Each row shows a remove button (since removable: true on each).
    const removes = widget.locator(INTERACTIVE_PROMPT_SELECTORS.requestUserInputReorderRemove);
    await expect(removes).toHaveCount(3);

    // Remove the second task; remaining rows should be 2 and submit still enabled
    // (minItems: 1 still satisfied).
    await removes.nth(1).click();
    await expect(rows).toHaveCount(2);

    const submit = widget.locator(INTERACTIVE_PROMPT_SELECTORS.requestUserInputSubmitButton);
    await expect(submit).toBeEnabled();
  });

  test('editText: renders inline Lexical surface seeded with initial markdown', async () => {
    const sessionId = await createTestSession(page, workspacePath, {
      title: 'Test RUI editText',
    });
    await insertUserPrompt(page, sessionId, 'Edit commit message');

    await insertPendingRequestUserInput(page, sessionId, {
      title: 'Edit commit message',
      fields: [
        {
          type: 'editText',
          id: 'commitMessage',
          label: 'Commit message',
          format: 'markdown',
          initialText: 'feat(transcript): add RequestUserInput widget\n\nAdds the new structured-input prompt.',
        },
      ],
    });

    await page.waitForTimeout(1000);
    const sessionItem = page.locator(`#session-list-item-${sessionId}`);
    await expect(sessionItem).toBeVisible({ timeout: TEST_TIMEOUTS.MEDIUM });
    await sessionItem.click();
    await page.waitForTimeout(1000);

    const widget = page.locator(INTERACTIVE_PROMPT_SELECTORS.requestUserInputWidget);
    await expect(widget).toBeVisible({ timeout: TEST_TIMEOUTS.VERY_LONG });
    await expect(widget).toHaveAttribute('data-state', 'pending');

    const editor = widget.locator(INTERACTIVE_PROMPT_SELECTORS.requestUserInputEditTextContent);
    await expect(editor).toBeVisible();
    // Lexical renders the markdown text inline -- the seeded title appears.
    await expect(editor).toContainText('feat(transcript): add RequestUserInput widget');

    const submit = widget.locator(INTERACTIVE_PROMPT_SELECTORS.requestUserInputSubmitButton);
    await expect(submit).toBeEnabled();
  });

  test('shows completed state when result is present', async () => {
    const sessionId = await createTestSession(page, workspacePath, {
      title: 'Test RUI completed',
    });
    await insertUserPrompt(page, sessionId, 'Quick yes/no');

    const { id: toolId } = await insertPendingRequestUserInput(page, sessionId, {
      title: 'Confirm action',
      fields: [{ type: 'confirm', id: 'go', label: 'Proceed?' }],
    });

    await insertRequestUserInputResult(page, sessionId, toolId, {
      go: { type: 'confirm', value: true },
    });

    await page.waitForTimeout(1000);
    const sessionItem = page.locator(`#session-list-item-${sessionId}`);
    await expect(sessionItem).toBeVisible({ timeout: TEST_TIMEOUTS.MEDIUM });
    await sessionItem.click();
    await page.waitForTimeout(1000);

    const widget = page.locator(INTERACTIVE_PROMPT_SELECTORS.requestUserInputWidget);
    await expect(widget).toBeVisible({ timeout: TEST_TIMEOUTS.VERY_LONG });
    await expect(widget).toHaveAttribute('data-state', 'completed');
    await expect(
      page.locator(INTERACTIVE_PROMPT_SELECTORS.requestUserInputCompletedState),
    ).toBeVisible();
  });
});
