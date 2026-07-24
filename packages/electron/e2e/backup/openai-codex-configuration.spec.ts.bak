import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { ElectronApplication, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { execSync } from 'child_process';

test.describe('CLI Provider Configuration and Functionality', () => {
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    // Create a temporary user data directory for testing
    const testUserDataDir = path.join(os.tmpdir(), 'preditor-e2e-test', `test-${Date.now()}`);
    await fs.mkdir(testUserDataDir, { recursive: true });

    // Create a test workspace directory
    const testWorkspaceDir = path.join(os.tmpdir(), 'preditor-test-workspace', `workspace-${Date.now()}`);
    await fs.mkdir(testWorkspaceDir, { recursive: true });
    await fs.writeFile(path.join(testWorkspaceDir, 'test.md'), '# Test Document\n\nThis is a test document for E2E testing.');

    // Build the app first
    const electronMain = path.resolve(__dirname, '../out/main/index.js');

    // Start the Electron app with test user data directory and workspace
    electronApp = await electron.launch({
      args: [electronMain, '--workspace', testWorkspaceDir],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'test-key',
        USER_DATA_DIR: testUserDataDir
      }
    });

    // Get the main window
    page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // Wait for app to fully load
    await page.waitForTimeout(500);
  });

  test.afterEach(async () => {
    await electronApp?.close();
  });

  test('should configure claude-code and openai-codex without warning symbols', async () => {
    // Check if claude-code is installed
    let isClaudeCodeInstalled = false;
    try {
      execSync('which claude-code', { stdio: 'ignore' });
      isClaudeCodeInstalled = true;
    } catch {}

    // Check if openai-codex is installed (assuming it's a similar CLI)
    let isOpenAICodexInstalled = false;
    try {
      execSync('which openai-codex', { stdio: 'ignore' });
      isOpenAICodexInstalled = true;
    } catch {}

    // Open AI Models configuration using keyboard shortcut
    await page.keyboard.press('Meta+Alt+m');
    await page.waitForTimeout(300);

    // First check Claude Code
    await page.click('text=Claude Code');
    await page.waitForTimeout(300);

    // Check installation status for Claude Code
    let installationSection = await page.locator('.installation-status').first();
    await expect(installationSection).toBeVisible();

    // Click refresh to check actual installation status
    const refreshButton = await page.locator('button:has-text("Refresh Status")');
    if (refreshButton) {
      await refreshButton.click();
      await page.waitForTimeout(500);
    }

    // If installed, enable it
    if (isClaudeCodeInstalled) {
      const statusText = await installationSection.textContent();
      if (statusText?.includes('Installed')) {
        const enableToggle = await page.locator('.provider-toggle input[type="checkbox"]').first();
        const isEnabled = await enableToggle.isChecked();
        if (!isEnabled) {
          await enableToggle.click();
          await page.waitForTimeout(200);
        }
      }
    }

    // Now check OpenAI Codex
    await page.click('text=OpenAI Codex');
    await page.waitForTimeout(300);

    // Check installation status for OpenAI Codex
    installationSection = await page.locator('.installation-status').first();
    await expect(installationSection).toBeVisible();

    // Click refresh to check actual installation status
    const codexRefreshButton = await page.locator('button:has-text("Refresh Status")');
    if (codexRefreshButton) {
      await codexRefreshButton.click();
      await page.waitForTimeout(500);
    }

    // If installed, enable it and add API key
    if (isOpenAICodexInstalled) {
      const statusText = await installationSection.textContent();
      if (statusText?.includes('Installed')) {
        const enableToggle = await page.locator('.provider-toggle input[type="checkbox"]').first();
        const isEnabled = await enableToggle.isChecked();
        if (!isEnabled) {
          await enableToggle.click();
          await page.waitForTimeout(200);
        }

        // Add API key for OpenAI Codex
        const apiKeyInput = await page.locator('.api-key-input').first();
        if (apiKeyInput) {
          await apiKeyInput.fill(process.env.OPENAI_API_KEY || 'sk-test-key');
        }
      }
    }

    // Save settings
    await page.click('button:has-text("Save")');
    await page.waitForTimeout(300);

    // Re-open to check warning symbols are gone
    await page.keyboard.press('Meta+,');
    await page.waitForTimeout(300);

    // Check Claude Code status indicator
    const claudeCodeNavItem = await page.locator('.nav-item:has-text("Claude Code")');
    const claudeCodeStatusIcon = await claudeCodeNavItem.locator('.nav-item-status');
    const claudeCodeStatusText = await claudeCodeStatusIcon.textContent();

    // Should not have warning symbol if installed and configured
    if (isClaudeCodeInstalled) {
      expect(claudeCodeStatusText).not.toBe('⚠');
    }

    // Check OpenAI Codex status indicator
    const openaiCodexNavItem = await page.locator('.nav-item:has-text("OpenAI Codex")');
    const openaiCodexStatusIcon = await openaiCodexNavItem.locator('.nav-item-status');
    const openaiCodexStatusText = await openaiCodexStatusIcon.textContent();

    // Should not have warning symbol if installed and configured with API key
    if (isOpenAICodexInstalled) {
      expect(openaiCodexStatusText).not.toBe('⚠');
    }
  });

  test('should show OpenAI Codex in AI Models configuration', async () => {
    // Open AI Models configuration using keyboard shortcut - opens in a new window
    const [aiModelsPage] = await Promise.all([
      electronApp.waitForEvent('window'),
      page.keyboard.press('Meta+Alt+m')
    ]);

    // Wait for the new page to load
    await aiModelsPage.waitForLoadState('domcontentloaded');
    await aiModelsPage.waitForTimeout(500);

    // Wait for AI Models dialog to be visible
    await aiModelsPage.waitForSelector('.ai-models-redesigned', { timeout: 5000 });

    // Check that OpenAI Codex is listed in the providers
    const codexNavItem = await aiModelsPage.locator('.nav-item:has-text("OpenAI Codex")');
    await expect(codexNavItem).toBeVisible();

    // Click on OpenAI Codex to select it
    await codexNavItem.click();
    await aiModelsPage.waitForTimeout(200);

    // Verify the panel shows OpenAI Codex configuration
    const panelTitle = await aiModelsPage.locator('.provider-panel-title:has-text("OpenAI Codex")');
    await expect(panelTitle).toBeVisible();

    // Check that it shows as CLI-based
    const cliDescription = await aiModelsPage.locator('text=/CLI.*[Aa]gent/');
    await expect(cliDescription).toBeVisible();

    // Close the AI Models window
    await aiModelsPage.close();
  });

  test('should enable OpenAI Codex and verify it appears in ProviderSelector', async () => {
    // Open AI Models configuration using keyboard shortcut - opens in a new window
    const [aiModelsPage] = await Promise.all([
      electronApp.waitForEvent('window'),
      page.keyboard.press('Meta+Alt+m')
    ]);

    // Wait for the new page to load
    await aiModelsPage.waitForLoadState('domcontentloaded');
    await aiModelsPage.waitForTimeout(500);

    // Wait for AI Models dialog to be visible
    await aiModelsPage.waitForSelector('.ai-models-redesigned', { timeout: 5000 });

    // Click on OpenAI Codex provider
    const codexNavItem = await aiModelsPage.locator('.nav-item:has-text("OpenAI Codex")');
    await codexNavItem.click();
    await aiModelsPage.waitForTimeout(200);

    // Enable OpenAI Codex
    const enableToggle = await aiModelsPage.locator('.provider-toggle input[type="checkbox"]');
    const isEnabled = await enableToggle.isChecked();
    if (!isEnabled) {
      await enableToggle.click();
      await aiModelsPage.waitForTimeout(200);
    }

    // Enter API key if needed
    const apiKeyInput = await aiModelsPage.locator('.api-key-input').first();
    if (apiKeyInput) {
      await apiKeyInput.fill(process.env.OPENAI_API_KEY || 'sk-test-key');
    }

    // Save settings and close
    await aiModelsPage.click('button:has-text("Save")');
    await aiModelsPage.waitForTimeout(300);

    // Open a new document
    await page.keyboard.press('Meta+n');
    await page.waitForTimeout(300);

    // Open AI Chat panel
    await page.keyboard.press('Meta+Shift+a');
    await page.waitForTimeout(300);

    // Click on provider selector dropdown
    const providerSelector = await page.locator('.provider-selector-trigger').first();
    if (providerSelector) {
      await providerSelector.click();
      await page.waitForTimeout(200);

      // Check that OpenAI Codex appears in the dropdown
      const codexOption = await page.locator('.provider-selector-option:has-text("OpenAI Codex")');
      await expect(codexOption).toBeVisible();

      // Check for the CLI description
      const cliDescription = await page.locator('.provider-selector-option-description:has-text("CLI Agent")');
      await expect(cliDescription).toBeVisible();
    }
  });

  test('should verify OpenAI Codex installation status', async () => {
    // Open AI Models configuration using keyboard shortcut
    await page.keyboard.press('Meta+Alt+m');
    await page.waitForTimeout(300);

    // Click on OpenAI Codex
    await page.click('text=OpenAI Codex');
    await page.waitForTimeout(200);

    // Check installation status section
    const installationSection = await page.locator('.installation-status');
    await expect(installationSection).toBeVisible();

    // If installed, it should show version
    const statusText = await installationSection.textContent();

    // Test that we can check installation status
    const refreshButton = await page.locator('button:has-text("Refresh Status")');
    if (refreshButton) {
      await refreshButton.click();
      await page.waitForTimeout(500);

      // After refresh, check if status updated
      const updatedStatus = await installationSection.textContent();
      expect(updatedStatus).toBeTruthy();

      // If installed, should not show "Not Installed"
      if (statusText?.includes('Installed')) {
        expect(updatedStatus).toContain('Installed');
      }
    }
  });

  test('should save OpenAI Codex configuration to capacitor settings', async () => {
    // Evaluate in renderer to check localStorage
    const settingsBefore = await page.evaluate(() => {
      const raw = window.localStorage.getItem('capacitor-ai-settings-v1');
      return raw ? JSON.parse(raw) : null;
    });

    // Open AI Models configuration using keyboard shortcut
    await page.keyboard.press('Meta+Alt+m');
    await page.waitForTimeout(300);

    // Click on OpenAI Codex
    await page.click('text=OpenAI Codex');
    await page.waitForTimeout(200);

    // Enable OpenAI Codex
    const enableToggle = await page.locator('.provider-toggle input[type="checkbox"]');
    await enableToggle.click();
    await page.waitForTimeout(200);

    // Save settings
    await page.click('button:has-text("Save")');
    await page.waitForTimeout(300);

    // Check that settings were saved with openai-codex
    const settingsAfter = await page.evaluate(() => {
      const raw = window.localStorage.getItem('capacitor-ai-settings-v1');
      return raw ? JSON.parse(raw) : null;
    });

    // Verify openai-codex is in the saved settings
    expect(settingsAfter).toBeTruthy();
    expect(settingsAfter.ai).toBeTruthy();
    expect(settingsAfter.ai.providers).toBeTruthy();
    expect(settingsAfter.ai.providers['openai-codex']).toBeTruthy();
    expect(settingsAfter.ai.providers['openai-codex'].enabled).toBe(true);

    // Should have selectedModels with the CLI model
    expect(settingsAfter.ai.providers['openai-codex'].selectedModels).toBeTruthy();
    expect(settingsAfter.ai.providers['openai-codex'].selectedModels).toContain('openai-codex:openai-codex-cli');
  });

  test('should select and use OpenAI Codex from ProviderSelector', async () => {
    // First enable OpenAI Codex using keyboard shortcut
    await page.keyboard.press('Meta+,');
    await page.waitForTimeout(300);

    await page.click('text=OpenAI Codex');
    await page.waitForTimeout(200);

    const enableToggle = await page.locator('.provider-toggle input[type="checkbox"]');
    const isEnabled = await enableToggle.isChecked();
    if (!isEnabled) {
      await enableToggle.click();
      await page.waitForTimeout(200);
    }

    // Enter API key
    const apiKeyInput = await page.locator('.api-key-input').first();
    await apiKeyInput.fill(process.env.OPENAI_API_KEY || 'sk-test-key');

    await page.click('button:has-text("Save")');
    await page.waitForTimeout(300);

    // Open a new document
    await page.keyboard.press('Meta+n');
    await page.waitForTimeout(300);

    // Type some content
    await page.keyboard.type('Test document for OpenAI Codex');
    await page.waitForTimeout(200);

    // Open AI Chat
    await page.keyboard.press('Meta+Shift+a');
    await page.waitForTimeout(300);

    // Click provider selector
    const providerSelector = await page.locator('.provider-selector-trigger').first();
    await providerSelector.click();
    await page.waitForTimeout(200);

    // Select OpenAI Codex
    const codexOption = await page.locator('.provider-selector-option:has-text("OpenAI Codex")');
    await codexOption.click();
    await page.waitForTimeout(200);

    // Verify it was selected
    const selectedProvider = await page.locator('.provider-selector-label').textContent();
    expect(selectedProvider).toContain('OpenAI Codex');

    // Send a test message
    const chatInput = await page.locator('textarea[placeholder*="message"]').first();
    await chatInput.fill('Hello, can you help me with code?');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    // Check that a response appears (or error if no API key)
    const messages = await page.locator('.ai-chat-message');
    const messageCount = await messages.count();
    expect(messageCount).toBeGreaterThan(0);
  });
});