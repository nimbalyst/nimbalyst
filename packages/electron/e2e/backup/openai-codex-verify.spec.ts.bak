import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { ElectronApplication, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

test.describe('OpenAI Codex Verification', () => {
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

  test('Can select OpenAI Codex and send message without Unknown Provider error', async () => {
    // Wait for workspace to load
    await page.waitForSelector('.workspace-sidebar', { timeout: 10000 });

    // First, open AI Models to enable OpenAI Codex
    const [aiModelsPage] = await Promise.all([
      electronApp.waitForEvent('window'),
      page.keyboard.press('Meta+Alt+m')
    ]);

    await aiModelsPage.waitForLoadState('domcontentloaded');
    await aiModelsPage.waitForTimeout(500);
    await aiModelsPage.waitForSelector('.ai-models-redesigned', { timeout: 5000 });

    // Click on OpenAI Codex in the nav
    const codexNavItem = await aiModelsPage.locator('.nav-item:has-text("OpenAI Codex")');
    if (await codexNavItem.isVisible()) {
      await codexNavItem.click();
      await aiModelsPage.waitForTimeout(300);

      // Enable OpenAI Codex
      const enableToggle = await aiModelsPage.locator('.provider-toggle input[type="checkbox"]');
      const isEnabled = await enableToggle.isChecked();
      if (!isEnabled) {
        await enableToggle.click();
        await aiModelsPage.waitForTimeout(200);
      }

      // Enter API key
      const apiKeyInput = await aiModelsPage.locator('.api-key-input').first();
      await apiKeyInput.fill(process.env.OPENAI_API_KEY || 'sk-test-key');

      // Save and close
      await aiModelsPage.click('button:has-text("Save")');
      await aiModelsPage.waitForTimeout(500);
    } else {
      console.log('WARNING: Could not find OpenAI Codex in AI Models nav');
    }

    // Now open a document
    await page.locator('.file-tree-name:has-text("test.md")').click();
    await page.waitForTimeout(500);

    // Close any dialogs that might be open
    const cancelButton = await page.locator('button:has-text("Cancel")').first();
    if (await cancelButton.isVisible().catch(() => false)) {
      await cancelButton.click();
      await page.waitForTimeout(200);
    }

    // Click the dropdown arrow next to the + button to open model selector
    const dropdownArrow = await page.locator('button.new-session-button-dropdown').first();
    const isDropdownVisible = await dropdownArrow.isVisible().catch(() => false);

    if (!isDropdownVisible) {
      console.log('Dropdown arrow not visible, looking for alternative selectors');
      // Alternative: click the session dropdown if available
      const sessionDropdown = await page.locator('button.session-dropdown-trigger').first();
      if (await sessionDropdown.isVisible()) {
        console.log('Clicking session dropdown');
        await sessionDropdown.click();
        await page.waitForTimeout(500);
      }
    } else {
      console.log('Found dropdown arrow, clicking it to open model selector');
      await dropdownArrow.click();
      await page.waitForTimeout(500);
    }

    // Check if the dropdown opened
    const dropdownMenu = await page.locator('.new-session-dropdown').first();
    const isMenuVisible = await dropdownMenu.isVisible().catch(() => false);

    if (isMenuVisible) {
      console.log('Model selector dropdown is visible');

      // Look for OpenAI Codex in the dropdown
      const openaiCodexOption = await page.locator('.new-session-option:has-text("openai-codex"), .new-session-option:has-text("Codex")').first();
      const isCodexVisible = await openaiCodexOption.isVisible().catch(() => false);

      if (isCodexVisible) {
        console.log('✓ SUCCESS: OpenAI Codex is visible in model dropdown!');

        // Select OpenAI Codex to create a new session with it
        await openaiCodexOption.click();
        await page.waitForTimeout(500);

        // Now try to send a message to test if the provider works
        const chatInput = await page.locator('textarea[placeholder*="message"], textarea[placeholder*="Type"], .ai-chat-input textarea').first();

        if (await chatInput.isVisible()) {
          console.log('Chat input is visible, sending test message');
          await chatInput.fill('Test message for OpenAI Codex');
          await page.keyboard.press('Enter');
          await page.waitForTimeout(2000);

          // Check for error messages
          const errorMessage = await page.locator('text=/Unknown provider|Error.*openai-codex/i, .ai-chat-message.error').first();
          const hasError = await errorMessage.isVisible().catch(() => false);

          if (hasError) {
            const errorText = await errorMessage.textContent();
            console.log('ERROR: Got error message:', errorText);
            // This should NOT happen if OpenAI Codex is properly registered
            throw new Error(`OpenAI Codex provider error: ${errorText}`);
          } else {
            console.log('✓ SUCCESS: No "Unknown provider" error! OpenAI Codex is properly registered');
          }

          // Check if we got any response or at least the message was sent
          const messages = await page.locator('.ai-chat-message').all();
          console.log(`Found ${messages.length} messages in chat`);

          if (messages.length > 0) {
            const firstMessage = await messages[0].textContent();
            console.log('First message content:', firstMessage?.substring(0, 100));
          }
        }
      } else {
        // OpenAI Codex not in dropdown - list all available options for debugging
        console.log('ERROR: OpenAI Codex NOT found in model dropdown');

        const allOptions = await page.locator('.new-session-option').all();
        console.log('Available models in dropdown:');
        for (const option of allOptions) {
          const text = await option.textContent();
          console.log('  -', text?.trim());
        }

        // Also check provider groups
        const providerGroups = await page.locator('.new-session-provider-group').all();
        console.log('Provider groups found:', providerGroups.length);
        for (const group of providerGroups) {
          const headerText = await group.locator('.new-session-provider-header').textContent();
          console.log('Provider:', headerText?.trim());
        }

        throw new Error('OpenAI Codex not available in model selector');
      }
    } else {
      console.log('Model selector dropdown not visible');

      // Try clicking the main + button to create a session first
      const newSessionMain = await page.locator('button.new-session-button-main').first();
      if (await newSessionMain.isVisible()) {
        console.log('Clicking main new session button');
        await newSessionMain.click();
        await page.waitForTimeout(500);

        // Now try the dropdown arrow again
        const dropdownArrowRetry = await page.locator('button.new-session-button-dropdown').first();
        if (await dropdownArrowRetry.isVisible()) {
          console.log('Clicking dropdown arrow after creating session');
          await dropdownArrowRetry.click();
          await page.waitForTimeout(500);

          // Check for OpenAI Codex
          const codexOption = await page.locator('text=/openai.*codex/i').first();
          const isVisible = await codexOption.isVisible().catch(() => false);

          if (isVisible) {
            console.log('✓ SUCCESS: Found OpenAI Codex option after retry');
          } else {
            console.log('ERROR: OpenAI Codex not found after retry');
            throw new Error('OpenAI Codex not available');
          }
        }
      } else {
        throw new Error('Could not find model selector UI');
      }
    }

    // Take a final screenshot
    await page.screenshot({ path: 'openai-codex-verify.png', fullPage: true });
  });
});