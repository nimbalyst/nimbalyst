/**
 * Mode toggle 3-way cycle E2E (issue #371).
 *
 * Verifies:
 * - ModeTag is rendered when provider === 'claude-code' and a session exists
 * - Click cycles Plan -> Agent -> Auto -> Plan
 * - Shift+Tab cycles the same order
 * - Selected mode persists across a page reload
 *
 * Classifier denial rendering and provider gating against OpenAI Codex are
 * covered by unit tests (ModeTag.test.tsx, ClaudeCodeRawParser.test.ts) and
 * manual verification -- mocking the SDK classifier in E2E adds little signal
 * beyond what the unit tests cover.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  dismissProjectTrustToast,
} from '../helpers';
import {
  switchToAgentMode,
  createNewAgentSession,
  dismissAPIKeyDialog,
  waitForWorkspaceReady,
} from '../utils/testHelpers';
import * as fs from 'fs/promises';

let electronApp: ElectronApplication;
let page: Page;
let workspacePath: string;

test.beforeAll(async () => {
  workspacePath = await createTempWorkspace('mode-toggle-cycle');
  electronApp = await launchElectronApp({ workspacePath });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
  await dismissProjectTrustToast(page);
  await dismissAPIKeyDialog(page);
  await waitForWorkspaceReady(page);
  await switchToAgentMode(page);
  await createNewAgentSession(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  if (workspacePath) {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});

test('ModeTag cycles Plan -> Agent -> Auto -> Plan on click', async () => {
  const modeTag = page.getByTestId('plan-mode-toggle');
  await expect(modeTag).toBeVisible();

  // Starting state depends on default; record it and cycle 3 times to return.
  const initialMode = await modeTag.getAttribute('data-mode');
  const cycle: Record<string, string> = {
    planning: 'agent',
    agent: 'auto',
    auto: 'planning',
  };

  let current = initialMode!;
  for (let i = 0; i < 3; i++) {
    await modeTag.click();
    const next = cycle[current];
    await expect(modeTag).toHaveAttribute('data-mode', next);
    current = next;
  }
  expect(current).toBe(initialMode);
});

test('Shift+Tab cycles modes same as click', async () => {
  const modeTag = page.getByTestId('plan-mode-toggle');
  const startMode = await modeTag.getAttribute('data-mode');
  const cycle: Record<string, string> = {
    planning: 'agent',
    agent: 'auto',
    auto: 'planning',
  };

  // Focus the AI input so the Shift+Tab keyboard handler fires.
  const aiInput = page.locator('textarea').first();
  await aiInput.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(modeTag).toHaveAttribute('data-mode', cycle[startMode!]);
});

test('Auto mode persists across reload', async () => {
  const modeTag = page.getByTestId('plan-mode-toggle');
  // Click until we reach auto.
  for (let attempts = 0; attempts < 3; attempts++) {
    const mode = await modeTag.getAttribute('data-mode');
    if (mode === 'auto') break;
    await modeTag.click();
  }
  await expect(modeTag).toHaveAttribute('data-mode', 'auto');

  await page.reload();
  await waitForAppReady(page);
  await switchToAgentMode(page);

  const reloadedTag = page.getByTestId('plan-mode-toggle');
  await expect(reloadedTag).toBeVisible();
  await expect(reloadedTag).toHaveAttribute('data-mode', 'auto');
});
