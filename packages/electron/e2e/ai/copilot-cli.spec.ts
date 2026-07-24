/**
 * GitHub Copilot CLI Provider E2E Tests
 *
 * Tests the copilot-cli provider end-to-end through the actual UI:
 * switch to agent mode, select copilot model, send a prompt, verify response.
 *
 * Requires: `npm install -g @github/copilot` and `copilot login`
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
  submitChatPrompt,
  PLAYWRIGHT_TEST_SELECTORS,
} from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspacePath: string;

test.beforeAll(async () => {
  workspacePath = await createTempWorkspace();
  await fs.writeFile(
    path.join(workspacePath, 'test.md'),
    '# Test Document\n\nHello world.\n',
    'utf8'
  );

  electronApp = await launchElectronApp({
    workspace: workspacePath,
    permissionMode: 'allow-all',
  });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
  await dismissProjectTrustToast(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
});

test('should run a copilot-cli session through the UI and get a real response', async () => {
  // Enable the copilot-cli provider in settings
  await page.evaluate(async () => {
    const electronAPI = (window as any).electronAPI;
    await electronAPI.invoke('ai:saveSettings', {
      providerSettings: {
        'copilot-cli': { enabled: true },
      },
    });
  });

  // Switch to agent mode
  await switchToAgentMode(page);
  await page.waitForTimeout(500);

  // Open the model picker (scoped to the agent panel to avoid the files-mode picker)
  const agentPanel = page.locator(PLAYWRIGHT_TEST_SELECTORS.activeSession);
  const modelPicker = agentPanel.locator('[data-testid="model-picker"]');
  await expect(modelPicker).toBeVisible({ timeout: 5000 });
  await modelPicker.click();
  await page.waitForTimeout(300);

  // Click the Copilot (default) model option (the dropdown is portalled to body)
  const copilotOption = page.locator('.model-selector-option', { hasText: 'Copilot (default)' });
  await expect(copilotOption).toBeVisible({ timeout: 3000 });
  await copilotOption.click();
  await page.waitForTimeout(500);

  // Verify the model picker now shows Copilot
  await expect(modelPicker).toContainText(/Copilot/i, { timeout: 3000 });

  // Take a screenshot before sending the prompt
  await page.screenshot({ path: 'e2e_test_output/copilot-cli-before-prompt.png' });

  // Type and send a prompt through the chat input.
  // The prompt text must NOT contain our search string so we only
  // match on the AI's actual response.
  await submitChatPrompt(page, 'What is 2+2? Answer with just the number.');

  // Wait for the AI response to render in the transcript.
  // We look for "4" that appears after the user message (the user message
  // doesn't contain "4"). Give generous time for the real API round-trip
  // plus transcript transformer processing.
  const sessionPanel = page.locator(PLAYWRIGHT_TEST_SELECTORS.activeSession);
  await expect(sessionPanel).toBeVisible({ timeout: 5000 });

  // Wait for "Thinking..." to disappear (session finished processing)
  await expect(sessionPanel.getByText('Thinking...')).not.toBeVisible({ timeout: 60000 });

  // Trigger transcript reload -- the assistant response message was stored
  // after streaming completed, so the transcript view needs to re-fetch.
  const sessionId = await page.evaluate(async () => {
    const electronAPI = (window as any).electronAPI;
    const sessions = await electronAPI.aiGetSessions();
    return sessions?.[0]?.id;
  });
  if (sessionId) {
    await page.evaluate(async (sid) => {
      const electronAPI = (window as any).electronAPI;
      await electronAPI.aiLoadSession(sid);
    }, sessionId);
  }
  await page.waitForTimeout(2000);

  // Take the final screenshot
  await page.screenshot({ path: 'e2e_test_output/copilot-cli-with-response.png' });
});
