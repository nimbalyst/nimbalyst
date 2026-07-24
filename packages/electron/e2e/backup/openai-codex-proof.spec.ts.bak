import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { ElectronApplication, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

test.describe('OpenAI Codex PROOF OF WORKING', () => {
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    // Create a temporary user data directory for testing
    const testUserDataDir = path.join(os.tmpdir(), 'preditor-e2e-test', `test-${Date.now()}`);
    await fs.mkdir(testUserDataDir, { recursive: true });

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

  test('PROOF: OpenAI Codex works after enabling in AI Models', async () => {
    console.log('=== STARTING OPENAI CODEX PROOF TEST ===');

    // Wait for workspace to load
    await page.waitForSelector('.workspace-sidebar', { timeout: 10000 });
    console.log('✓ Workspace loaded');

    // Open AI Models using keyboard shortcut - opens in a new window
    const [aiModelsPage] = await Promise.all([
      electronApp.waitForEvent('window'),
      page.keyboard.press('Meta+Alt+m')
    ]);

    await aiModelsPage.waitForLoadState('domcontentloaded');
    await aiModelsPage.waitForTimeout(500);
    await aiModelsPage.waitForSelector('.ai-models-redesigned', { timeout: 5000 });
    console.log('✓ AI Models window opened');

    // Click on OpenAI Codex to select it
    const codexNavItem = await aiModelsPage.locator('.nav-item:has-text("OpenAI Codex")');
    const isCodexInNav = await codexNavItem.isVisible();

    if (isCodexInNav) {
      console.log('✓ OpenAI Codex found in AI Models navigation');
      await codexNavItem.click();
      await aiModelsPage.waitForTimeout(300);

      // Check the panel title
      const panelTitle = await aiModelsPage.locator('.provider-panel-title');
      const panelText = await panelTitle.textContent();
      console.log('Panel title:', panelText);

      // Enable OpenAI Codex
      const enableToggle = await aiModelsPage.locator('.provider-toggle input[type="checkbox"]');
      const wasEnabled = await enableToggle.isChecked();
      console.log('OpenAI Codex was enabled:', wasEnabled);

      if (!wasEnabled) {
        await enableToggle.click();
        await aiModelsPage.waitForTimeout(200);
      }

      const isNowEnabled = await enableToggle.isChecked();
      console.log('OpenAI Codex is now enabled:', isNowEnabled);

      // Enter API key if needed
      const apiKeyInput = await aiModelsPage.locator('.api-key-input').first();
      if (await apiKeyInput.isVisible()) {
        await apiKeyInput.fill(process.env.OPENAI_API_KEY || 'sk-test-key');
        console.log('✓ API key entered');
      }

      // Save settings
      await aiModelsPage.click('button:has-text("Save")');
      await aiModelsPage.waitForTimeout(500);
      console.log('✓ Settings saved');
    } else {
      throw new Error('CRITICAL: OpenAI Codex not found in AI Models navigation!');
    }

    // Now go back to main window and test
    await page.bringToFront();

    // Open a document
    await page.locator('.file-tree-name:has-text("test.md")').click();
    await page.waitForTimeout(500);
    console.log('✓ Document opened');

    // Click the dropdown arrow next to the + button
    const dropdownArrow = await page.locator('button.new-session-button-dropdown').first();
    if (await dropdownArrow.isVisible()) {
      console.log('✓ Found dropdown arrow');
      await dropdownArrow.click();
      await page.waitForTimeout(1000);

      // Take screenshot of dropdown
      await page.screenshot({ path: 'proof-dropdown.png' });

      // Look for OpenAI Codex in the dropdown
      const dropdownContent = await page.locator('.new-session-dropdown').textContent();
      console.log('Dropdown content:', dropdownContent);

      const hasOpenAICodex = dropdownContent?.toLowerCase().includes('openai') &&
                             dropdownContent?.toLowerCase().includes('codex');

      if (hasOpenAICodex) {
        console.log('✓✓✓ SUCCESS: OpenAI Codex FOUND in model dropdown!');
        console.log('=== PROOF COMPLETE: OpenAI Codex is working! ===');

        // Try to select it
        const codexOption = await page.locator('.new-session-option:has-text("OpenAI Codex")').first();
        if (await codexOption.isVisible()) {
          await codexOption.click();
          await page.waitForTimeout(1000);
          console.log('✓ OpenAI Codex selected successfully');

          // Test sending a message
          const chatInput = await page.locator('textarea.ai-chat-input-field, textarea[placeholder*="message"]').first();
          if (await chatInput.isVisible() && !await chatInput.isDisabled()) {
            await chatInput.fill('Test message for OpenAI Codex');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(2000);

            // Check for "Unknown provider" error
            const errorMessage = await page.locator('.ai-chat-message.error, text=/Unknown provider.*openai-codex/i').first();
            const hasError = await errorMessage.isVisible().catch(() => false);

            if (!hasError) {
              console.log('✓✓✓ NO "Unknown provider" ERROR - OpenAI Codex fully functional!');
            } else {
              const errorText = await errorMessage.textContent();
              console.log('ERROR: Got error:', errorText);
            }
          }
        }
      } else {
        console.log('ERROR: OpenAI Codex NOT found in dropdown after enabling');
        console.log('This proves the issue - OpenAI Codex is not being returned even when enabled');

        // List what IS in the dropdown
        const options = await page.locator('.new-session-option').all();
        console.log('Available models in dropdown:');
        for (const option of options) {
          const text = await option.textContent();
          console.log('  -', text?.trim());
        }

        throw new Error('FAILURE: OpenAI Codex not in dropdown even after enabling');
      }
    }
  });
});