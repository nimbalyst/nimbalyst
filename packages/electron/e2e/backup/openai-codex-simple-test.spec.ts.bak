import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { ElectronApplication, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

test.describe('OpenAI Codex Simple Test', () => {
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

  test('OpenAI Codex exists in model dropdown', async () => {
    // Wait for workspace to load
    await page.waitForSelector('.workspace-sidebar', { timeout: 10000 });

    // Open a document
    await page.locator('.file-tree-name:has-text("test.md")').click();
    await page.waitForTimeout(500);

    // Look for the dropdown arrow button next to the + button
    const dropdownArrow = await page.locator('button.new-session-button-dropdown, button[class*="dropdown"]:has([class*="expand"])').first();

    // Take screenshot before clicking
    await page.screenshot({ path: 'before-dropdown.png', fullPage: false });

    if (await dropdownArrow.isVisible()) {
      console.log('Found dropdown arrow, clicking it');
      await dropdownArrow.click();
      await page.waitForTimeout(500);

      // Take screenshot after clicking
      await page.screenshot({ path: 'after-dropdown.png', fullPage: false });

      // Look for any text containing "codex" (case insensitive)
      const codexText = await page.locator('text=/codex/i').first();
      const hasCodex = await codexText.isVisible().catch(() => false);

      if (hasCodex) {
        const text = await codexText.textContent();
        console.log('✓ SUCCESS: Found Codex option:', text);

        // Try to click it
        await codexText.click();
        await page.waitForTimeout(1000);

        // Now send a test message
        const chatInput = await page.locator('textarea').first();
        if (await chatInput.isVisible()) {
          await chatInput.fill('Test message for OpenAI Codex');
          await page.keyboard.press('Enter');
          await page.waitForTimeout(2000);

          // Check for "Unknown provider" error
          const errorText = await page.locator('text=/Unknown provider.*codex/i').first();
          const hasError = await errorText.isVisible().catch(() => false);

          if (hasError) {
            const error = await errorText.textContent();
            throw new Error(`OpenAI Codex error: ${error}`);
          } else {
            console.log('✓ SUCCESS: No "Unknown provider" error!');
          }
        }
      } else {
        // List all visible text in dropdown for debugging
        const allTexts = await page.locator('.new-session-dropdown *').allTextContents();
        console.log('All texts in dropdown:', allTexts);

        throw new Error('OpenAI Codex not found in dropdown');
      }
    } else {
      // Try alternate selectors
      const altButton = await page.locator('button:has-text("+")').first();
      if (await altButton.isVisible()) {
        console.log('Found + button');

        // Look for adjacent dropdown button
        const adjacentDropdown = await altButton.locator('~ button').first();
        if (await adjacentDropdown.isVisible()) {
          await adjacentDropdown.click();
          await page.waitForTimeout(500);
        }
      }

      throw new Error('Could not find dropdown arrow');
    }

    // Final screenshot
    await page.screenshot({ path: 'final-state.png', fullPage: false });
  });
});