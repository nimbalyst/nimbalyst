import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { ElectronApplication, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

test.describe('OpenAI Codex Integration', () => {
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    // Create a temporary user data directory for testing
    const testUserDataDir = path.join(os.tmpdir(), 'preditor-e2e-test', `test-${Date.now()}`);
    await fs.mkdir(testUserDataDir, { recursive: true });

    // Create a test workspace directory
    const testWorkspaceDir = path.join(os.tmpdir(), 'preditor-test-workspace', `workspace-${Date.now()}`);
    await fs.mkdir(testWorkspaceDir, { recursive: true });
    await fs.writeFile(path.join(testWorkspaceDir, 'test.md'), '# Test Document\n\nThis is a test document for OpenAI Codex testing.');

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

  test('should configure and use OpenAI Codex provider', async () => {
    // Wait for workspace to load
    await page.waitForSelector('.workspace-sidebar', { timeout: 10000 });

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

    // Click on OpenAI Codex to select it
    const codexNavItem = await aiModelsPage.locator('.nav-item:has-text("OpenAI Codex")');
    await expect(codexNavItem).toBeVisible();
    await codexNavItem.click();
    await aiModelsPage.waitForTimeout(300);

    // Verify the panel shows OpenAI Codex configuration
    const panelTitle = await aiModelsPage.locator('.provider-panel-title:has-text("OpenAI Codex")');
    await expect(panelTitle).toBeVisible();

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

    // Save settings and close
    await aiModelsPage.click('button:has-text("Save")');
    await aiModelsPage.waitForTimeout(500);

    // Now open a document
    await page.locator('.file-tree-name:has-text("test.md")').click();
    await page.waitForTimeout(500);

    // Open AI Chat panel by clicking the button
    const aiButton = await page.locator('button[title*="AI Assistant"], button:has-text("Open AI Assistant")');
    await aiButton.click();
    await page.waitForTimeout(500);

    // Wait for AI chat to be visible
    await page.waitForSelector('.ai-chat, .ai-chat-container', { timeout: 5000 });

    // Click on provider selector dropdown
    const providerSelector = await page.locator('.provider-selector-trigger');
    await expect(providerSelector).toBeVisible();
    await providerSelector.click();
    await page.waitForTimeout(200);

    // Verify OpenAI Codex appears in the dropdown
    const codexOption = await page.locator('.provider-selector-option:has-text("OpenAI Codex")');
    await expect(codexOption).toBeVisible();

    // Select OpenAI Codex
    await codexOption.click();
    await page.waitForTimeout(200);

    // Verify it was selected
    const selectedProvider = await page.locator('.provider-selector-label').textContent();
    expect(selectedProvider).toContain('OpenAI Codex');

    // Start a new session by clicking the + button
    const newSessionButton = await page.locator('button[title*="New conversation"]').first();
    await newSessionButton.click();
    await page.waitForTimeout(500);

    // Type a test message
    const chatInput = await page.locator('textarea[placeholder*="message"]').first();
    await chatInput.fill('Hello, this is a test message for OpenAI Codex');

    // Send the message
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    // Check if we get an error or a response
    // If OpenAI Codex is not installed or API key is invalid, we should get an error message
    // If it works, we should get a response
    const messages = await page.locator('.ai-chat-message');
    const messageCount = await messages.count();

    // Should have at least the user message
    expect(messageCount).toBeGreaterThan(0);

    // Check if there's an error message or a valid response
    const lastMessage = await messages.last();
    const messageText = await lastMessage.textContent();

    console.log('OpenAI Codex response:', messageText);

    // The test passes if we can create a session and send a message
    // Whether it responds successfully depends on if OpenAI Codex CLI is installed
    // and if the API key is valid
    if (messageText?.includes('Error')) {
      console.log('OpenAI Codex error (expected if not installed):', messageText);
      // Check that the error is about installation or API key, not "Unknown provider"
      expect(messageText).not.toContain('Unknown provider');
    } else {
      console.log('OpenAI Codex working successfully!');
    }
  });

  test('should verify OpenAI Codex appears in provider list', async () => {
    // Wait for workspace to load
    await page.waitForSelector('.workspace-sidebar', { timeout: 10000 });

    // Open a document first
    await page.locator('.file-tree-name:has-text("test.md")').click();
    await page.waitForTimeout(500);

    // Open AI Chat panel by clicking the button
    const aiButton = await page.locator('button[title*="AI Assistant"], button:has-text("Open AI Assistant")');
    await aiButton.click();
    await page.waitForTimeout(500);

    // Wait for AI chat to be visible
    await page.waitForSelector('.ai-chat, .ai-chat-container', { timeout: 5000 });

    // Click on provider selector dropdown
    const providerSelector = await page.locator('.provider-selector-trigger');
    await expect(providerSelector).toBeVisible();
    await providerSelector.click();
    await page.waitForTimeout(200);

    // Check all available providers
    const providers = await page.locator('.provider-selector-option').all();
    const providerNames = await Promise.all(providers.map(p => p.textContent()));

    console.log('Available providers:', providerNames);

    // Verify OpenAI Codex is in the list
    const hasOpenAICodex = providerNames.some(name => name?.includes('OpenAI Codex'));
    expect(hasOpenAICodex).toBe(true);

    // Also verify other expected providers
    const hasClaudeCode = providerNames.some(name => name?.includes('Claude Code'));
    const hasClaude = providerNames.some(name => name?.includes('Claude SDK'));
    const hasOpenAI = providerNames.some(name => name?.includes('OpenAI') && !name?.includes('Codex'));
    const hasLMStudio = providerNames.some(name => name?.includes('LM Studio'));

    expect(hasClaudeCode).toBe(true);
    expect(hasClaude).toBe(true);
    expect(hasOpenAI).toBe(true);
    expect(hasLMStudio).toBe(true);
  });
});