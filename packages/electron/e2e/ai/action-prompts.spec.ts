/**
 * Action Prompts E2E Tests
 *
 * Verifies the composer's "Actions" dropdown reads ai-actions.md from
 * <workspace>/nimbalyst-local/ai-actions.md, lists each ## heading, and
 * inserts the action body verbatim into the AI input on click.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  dismissProjectTrustToast,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  dismissAPIKeyDialog,
  switchToAgentMode,
} from '../utils/testHelpers';

test.describe.configure({ mode: 'serial' });

const ACTIONS_FILE_RELATIVE = 'nimbalyst-local/ai-actions.md';
const ACTIONS_FILE_CONTENT = `# AI Action Prompts

## Review Changed Files
/review changed files in this session and call out regression risk.

## Plan Implementation
Look at the active issue.

Produce a structured plan that:
- breaks the work into 3-5 phases
- identifies the files I'll need to touch
`;

let electronApp: ElectronApplication;
let page: Page;
let workspacePath: string;

test.beforeAll(async () => {
  workspacePath = await createTempWorkspace();
  const actionsPath = path.join(workspacePath, ACTIONS_FILE_RELATIVE);
  await fs.mkdir(path.dirname(actionsPath), { recursive: true });
  await fs.writeFile(actionsPath, ACTIONS_FILE_CONTENT, 'utf8');

  electronApp = await launchElectronApp({
    workspace: workspacePath,
    env: { NODE_ENV: 'test' },
  });

  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);
  await dismissProjectTrustToast(page);
  await dismissAPIKeyDialog(page);

  await switchToAgentMode(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
});

test('opens the Actions dropdown and inserts the chosen body into the composer', async () => {
  const dropdownTrigger = page.locator('[data-testid="action-prompts-dropdown"]').first();
  await dropdownTrigger.waitFor({ state: 'visible', timeout: 5000 });
  await dropdownTrigger.click();

  const panel = page.locator('[data-testid="action-prompts-dropdown-panel"]');
  await panel.waitFor({ state: 'visible', timeout: 2000 });

  const planItem = panel.locator('[data-testid="action-prompt-item-plan-implementation"]');
  await expect(planItem).toBeVisible();
  await planItem.click();

  await expect(panel).toBeHidden();

  const chatInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentChatInput);
  await chatInput.waitFor({ state: 'visible', timeout: 2000 });
  const value = await chatInput.inputValue();
  expect(value).toContain('Look at the active issue.');
  expect(value).toContain('breaks the work into 3-5 phases');
});
