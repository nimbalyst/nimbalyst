import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { ElectronApplication, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

test.describe('OpenAI Codex Provider Test', () => {
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    // Create a temporary user data directory for testing
    const testUserDataDir = path.join(os.tmpdir(), 'preditor-e2e-test', `test-${Date.now()}`);
    await fs.mkdir(testUserDataDir, { recursive: true });

    // Create a test workspace directory
    const testWorkspaceDir = path.join(os.tmpdir(), 'preditor-test-workspace', `workspace-${Date.now()}`);
    await fs.mkdir(testWorkspaceDir, { recursive: true });
    await fs.writeFile(path.join(testWorkspaceDir, 'test.md'), '# Test Document\n\nTest for OpenAI Codex.');

    // Build the app first
    const electronMain = path.resolve(__dirname, '../out/main/index.js');

    // Start the Electron app with test user data directory and workspace
    electronApp = await electron.launch({
      args: [electronMain, '--workspace', testWorkspaceDir],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-key',
        USER_DATA_DIR: testUserDataDir
      }
    });

    // Get the main window
    page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Wait for app to fully load
    await page.waitForTimeout(1000);
  });

  test.afterEach(async () => {
    await electronApp?.close();
  });

  test('OpenAI Codex appears in provider selector', async () => {
    // Wait for workspace to load
    await page.waitForSelector('.workspace-sidebar', { timeout: 10000 });

    // Open a document first
    await page.locator('.file-tree-name:has-text("test.md")').click();
    await page.waitForTimeout(500);

    // Look for the provider selector - should be in the AI panel header
    // The selector is in the AI panel which appears to be open by default
    const providerSelector = await page.locator('.provider-selector-trigger, button:has-text("Claude"), button:has-text("Model")').first();

    if (await providerSelector.isVisible()) {
      console.log('Found provider selector, clicking it');
      await providerSelector.click();
      await page.waitForTimeout(500);

      // Look for OpenAI Codex in the dropdown
      const openaiCodexOption = await page.locator('text=/OpenAI.*Codex/i').first();
      const isVisible = await openaiCodexOption.isVisible().catch(() => false);

      if (isVisible) {
        console.log('SUCCESS: OpenAI Codex is visible in the provider dropdown!');
        const optionText = await openaiCodexOption.textContent();
        console.log('OpenAI Codex option text:', optionText);
        expect(isVisible).toBe(true);
      } else {
        // Try to find all options in the dropdown
        const allOptions = await page.locator('[class*="provider-selector-option"], [class*="model-option"], [role="option"]').all();
        console.log('Found', allOptions.length, 'options in dropdown');

        for (let i = 0; i < allOptions.length; i++) {
          const text = await allOptions[i].textContent();
          console.log(`Option ${i + 1}: ${text}`);
        }

        // Check if OpenAI Codex is in any of them
        const texts = await Promise.all(allOptions.map(opt => opt.textContent()));
        const hasCodex = texts.some(t => t?.toLowerCase().includes('codex'));

        if (hasCodex) {
          console.log('SUCCESS: Found OpenAI Codex in provider options');
        } else {
          console.log('ERROR: OpenAI Codex not found in provider options');
        }

        expect(hasCodex).toBe(true);
      }
    } else {
      console.log('Provider selector not visible, looking for it in the AI panel');

      // Look in the AI panel header area
      const aiHeader = await page.locator('[class*="ai-chat-header"], [class*="ai-assistant"] header').first();
      if (await aiHeader.isVisible()) {
        console.log('Found AI header, looking for provider info');
        const headerText = await aiHeader.textContent();
        console.log('AI header text:', headerText);
      }

      // Try to find the + button to start a new session
      const newSessionBtn = await page.locator('button[title*="New"], button:has([class*="add"]), button:has-text("+")').first();
      if (await newSessionBtn.isVisible()) {
        console.log('Found new session button, clicking it');
        await newSessionBtn.click();
        await page.waitForTimeout(500);

        // Now look for provider selector again
        const selector = await page.locator('.provider-selector-trigger, button:has-text("Model")').first();
        if (await selector.isVisible()) {
          await selector.click();
          await page.waitForTimeout(500);

          const openaiCodex = await page.locator('text=/OpenAI.*Codex/i').first();
          const isCodexVisible = await openaiCodex.isVisible().catch(() => false);
          expect(isCodexVisible).toBe(true);

          if (isCodexVisible) {
            console.log('SUCCESS: OpenAI Codex found after creating new session');
          }
        }
      }
    }

    // Take a screenshot for debugging
    await page.screenshot({ path: 'openai-codex-test.png', fullPage: true });
  });
});