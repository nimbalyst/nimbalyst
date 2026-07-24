import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { ElectronApplication, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

test.describe('OpenAI Codex Integration Final Test', () => {
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    // Create a temporary user data directory for testing
    const testUserDataDir = path.join(os.tmpdir(), 'preditor-e2e-test', `test-${Date.now()}`);
    await fs.mkdir(testUserDataDir, { recursive: true });

    // Pre-configure OpenAI Codex as enabled in ai-settings store
    const settingsFile = path.join(testUserDataDir, 'ai-settings.json');
    await fs.writeFile(settingsFile, JSON.stringify({
      providerSettings: {
        'openai-codex': {
          enabled: true
        },
        'openai': {
          enabled: true
        }
      },
      apiKeys: {
        'openai': process.env.OPENAI_API_KEY || 'sk-test-key'
      }
    }));

    // Create a test workspace directory
    const testWorkspaceDir = path.join(os.tmpdir(), 'preditor-test-workspace', `workspace-${Date.now()}`);
    await fs.mkdir(testWorkspaceDir, { recursive: true });
    await fs.writeFile(path.join(testWorkspaceDir, 'test.md'), '# Test Document\n\nTest content.');

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
    await page.waitForTimeout(1500);
  });

  test.afterEach(async () => {
    await electronApp?.close();
  });

  test('OpenAI Codex can create session without Unknown Provider error', async () => {
    // Wait for workspace to load
    await page.waitForSelector('.workspace-sidebar', { timeout: 10000 });
    console.log('✓ Workspace loaded');

    // Open a document
    await page.locator('.file-tree-name:has-text("test.md")').click();
    await page.waitForTimeout(500);
    console.log('✓ Document opened');

    // Take initial screenshot
    await page.screenshot({ path: 'test-initial.png' });

    // Click the dropdown arrow next to the + button to see available models
    const dropdownArrow = await page.locator('button.new-session-button-dropdown').first();

    if (await dropdownArrow.isVisible()) {
      console.log('✓ Found dropdown arrow');
      await dropdownArrow.click();
      await page.waitForTimeout(1000);

      // Take screenshot of dropdown
      await page.screenshot({ path: 'test-dropdown.png' });

      // Check if OpenAI Codex is in the dropdown
      const dropdownContent = await page.locator('.new-session-dropdown').textContent();
      console.log('Dropdown content:', dropdownContent);

      // Look for OpenAI Codex model
      const codexOption = await page.locator('.new-session-option:has-text("OpenAI Codex")').first();
      const hasCodexOption = await codexOption.isVisible().catch(() => false);

      if (hasCodexOption) {
        console.log('✓ SUCCESS: OpenAI Codex found in model dropdown!');

        // Click to select OpenAI Codex
        await codexOption.click();
        await page.waitForTimeout(1000);

        // Take screenshot after selection
        await page.screenshot({ path: 'test-after-select.png' });

        // Now try to send a message
        const chatInput = await page.locator('textarea.ai-chat-input-field, textarea[placeholder*="message"]').first();

        if (await chatInput.isVisible()) {
          // Check if it's enabled (session should have been created)
          const isDisabled = await chatInput.isDisabled();

          if (!isDisabled) {
            console.log('✓ Chat input is enabled');
            await chatInput.fill('Test message for OpenAI Codex');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(2000);

            // Check for "Unknown provider" error
            const errorMessage = await page.locator('.ai-chat-message.error, text=/Unknown provider.*openai-codex/i').first();
            const hasError = await errorMessage.isVisible().catch(() => false);

            if (hasError) {
              const errorText = await errorMessage.textContent();
              console.log('ERROR: Got error message:', errorText);
              throw new Error(`OpenAI Codex provider error: ${errorText}`);
            } else {
              console.log('✓✓✓ SUCCESS: OpenAI Codex works without "Unknown provider" error!');
            }
          } else {
            console.log('Chat input is disabled - session may not have been created');
          }
        }
      } else {
        // OpenAI Codex not found - this is what we're testing to prevent
        console.log('ERROR: OpenAI Codex not found in model dropdown');

        // List all available options for debugging
        const allOptions = await page.locator('.new-session-option').all();
        console.log('Available models:');
        for (const option of allOptions) {
          const text = await option.textContent();
          console.log('  -', text?.trim());
        }

        throw new Error('OpenAI Codex not available in model selector - MAIN TEST FAILURE');
      }
    } else {
      console.log('ERROR: Could not find dropdown arrow');
      throw new Error('Model selector dropdown not found');
    }

    // Final screenshot
    await page.screenshot({ path: 'test-final.png' });
  });
});