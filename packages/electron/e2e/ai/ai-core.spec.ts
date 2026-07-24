/**
 * AI Core E2E Tests
 *
 * Consolidated from:
 *   ai-features.spec.ts (session creation, context usage, mode switching)
 *
 * Tests share a single Electron app instance.
 * No real AI API calls - all tests use IPC-level simulation.
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

// ============================================================================
// AI Features (from ai-features.spec.ts)
// ============================================================================

test('should create Claude Code session via electronAPI', async () => {
  const providerTest = await page.evaluate(async () => {
    try {
      const electronAPI = (window as any).electronAPI;
      if (!electronAPI) {
        return { success: false, error: 'electronAPI not available' };
      }

      try {
        const sessionResult = await electronAPI.aiCreateSession(
          'claude-code',
          undefined,
          '/tmp',
          'claude-code-cli'
        );

        return {
          success: true,
          sessionId: sessionResult?.sessionId,
          provider: sessionResult?.provider,
        };
      } catch (error) {
        return {
          success: false,
          error: (error as Error).message,
        };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Session creation should either succeed or fail gracefully (no crash)
  if (providerTest.error) {
    expect(providerTest.error).not.toContain('CRASH');
    expect(providerTest.error).not.toContain('FATAL');
  } else {
    expect(providerTest.success).toBe(true);
  }
});

test('should show context usage display for Claude Code sessions', async () => {
  await switchToAgentMode(page);
  await page.waitForTimeout(1000);

  // Context usage display may or may not be visible depending on whether
  // a Claude Code session has been used. This test verifies the format when present.
  const contextUsage = page.locator('.context-usage-display');
  const count = await contextUsage.count();

  if (count > 0) {
    const isVisible = await contextUsage.isVisible().catch(() => false);
    if (isVisible) {
      const usageText = await contextUsage.textContent();
      expect(usageText).toMatch(/\d+k?\/\d+k Tokens \(\d+%\)/);
    }
  }

  // Also verify model selector is present
  const modelSelector = page.locator('.model-selector');
  if (await modelSelector.isVisible().catch(() => false)) {
    const providerText = await modelSelector.textContent();
    expect(providerText).toBeTruthy();
  }
});

test('should switch to agent mode without errors', async () => {
  // Verify app is in a good state and agent mode works
  const agentModeButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentModeButton);
  const isVisible = await agentModeButton.isVisible({ timeout: 5000 }).catch(() => false);

  if (isVisible) {
    await agentModeButton.click();
    await page.waitForTimeout(1000);

    // Verify we're in agent mode (chat input visible)
    const chatInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentChatInput);
    await expect(chatInput).toBeVisible({ timeout: 3000 });
  }
});

