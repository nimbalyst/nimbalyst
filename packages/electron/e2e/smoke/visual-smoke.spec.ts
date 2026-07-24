/**
 * Visual Smoke Test
 *
 * A comprehensive smoke test that navigates through major screens and views,
 * capturing screenshots to validate basic functionality and catch visual regressions.
 *
 * This test is designed to:
 * 1. Launch the app with a realistic workspace
 * 2. Navigate through all major modes (files, agent, settings)
 * 3. Open different editor types (markdown, code, csv)
 * 4. Interact with key UI elements
 * 5. Capture screenshots at each major state
 *
 * Screenshots are saved to e2e/smoke/screenshots/ for visual comparison.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  TEST_TIMEOUTS,
  ACTIVE_FILE_TAB_SELECTOR,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  openFileFromTree,
  switchToAgentMode,
  switchToFilesMode,
} from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

const SELECTORS = PLAYWRIGHT_TEST_SELECTORS;
const SCREENSHOT_DIR = 'e2e/smoke/screenshots';

test.describe.configure({ mode: 'serial' });

test.describe('Visual Smoke Test', () => {
  let electronApp: ElectronApplication;
  let page: Page;
  let workspaceDir: string;

  test.beforeAll(async () => {
    // Create workspace with variety of file types
    workspaceDir = await createTempWorkspace();

    // Markdown file
    await fs.writeFile(
      path.join(workspaceDir, 'README.md'),
      `# Project README

This is a test project for smoke testing.

## Features

- Feature one
- Feature two
- Feature three

## Getting Started

Run the following command to get started:

\`\`\`bash
npm install
npm start
\`\`\`
`,
      'utf8'
    );

    // TypeScript file
    await fs.writeFile(
      path.join(workspaceDir, 'index.ts'),
      `interface User {
  id: number;
  name: string;
  email: string;
}

function greetUser(user: User): string {
  return \`Hello, \${user.name}!\`;
}

const testUser: User = {
  id: 1,
  name: 'Test User',
  email: 'test@example.com'
};

console.log(greetUser(testUser));
`,
      'utf8'
    );

    // CSV file
    await fs.writeFile(
      path.join(workspaceDir, 'data.csv'),
      `id,name,email,status
1,Alice,alice@example.com,active
2,Bob,bob@example.com,inactive
3,Charlie,charlie@example.com,active
4,Diana,diana@example.com,pending
`,
      'utf8'
    );

    // JSON file
    await fs.writeFile(
      path.join(workspaceDir, 'config.json'),
      JSON.stringify(
        {
          name: 'smoke-test',
          version: '1.0.0',
          settings: {
            debug: true,
            theme: 'dark',
          },
        },
        null,
        2
      ),
      'utf8'
    );

    // Create a subfolder with files
    const srcDir = path.join(workspaceDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(
      path.join(srcDir, 'utils.ts'),
      `export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
`,
      'utf8'
    );

    // Launch the app
    electronApp = await launchElectronApp({ workspace: workspaceDir });
    page = await electronApp.firstWindow();
    await waitForAppReady(page);

    // Ensure screenshot directory exists
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  });

  test.afterAll(async () => {
    await electronApp?.close();
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test('01 - App launches with file tree visible', async () => {
    // Verify basic app structure
    const sidebar = page.locator(SELECTORS.workspaceSidebar);
    await expect(sidebar).toBeVisible();

    // Verify file tree shows our test files
    await page.locator(SELECTORS.fileTreeItem, { hasText: 'README.md' }).waitFor({ timeout: TEST_TIMEOUTS.FILE_TREE_LOAD });
    await expect(page.locator(SELECTORS.fileTreeItem, { hasText: 'README.md' })).toBeVisible();
    await expect(page.locator(SELECTORS.fileTreeItem, { hasText: 'index.ts' })).toBeVisible();
    await expect(page.locator(SELECTORS.fileTreeItem, { hasText: 'data.csv' })).toBeVisible();

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-app-launch-file-tree.png`,
      fullPage: true,
    });
  });

  test('02 - Open markdown file in editor', async () => {
    await openFileFromTree(page, 'README.md');

    // Verify tab is open
    await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('README.md', {
      timeout: TEST_TIMEOUTS.TAB_SWITCH,
    });

    // Wait for content to render
    await page.waitForTimeout(500);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-markdown-editor.png`,
      fullPage: true,
    });
  });

  test('03 - Open TypeScript file in Monaco editor', async () => {
    await openFileFromTree(page, 'index.ts');

    await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('index.ts', {
      timeout: TEST_TIMEOUTS.TAB_SWITCH,
    });

    // Wait for Monaco to fully load
    await page.waitForSelector('.monaco-editor', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
    await page.waitForTimeout(500);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-typescript-monaco.png`,
      fullPage: true,
    });
  });

  test('04 - Open CSV file in spreadsheet editor', async () => {
    await openFileFromTree(page, 'data.csv');

    await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('data.csv', {
      timeout: TEST_TIMEOUTS.TAB_SWITCH,
    });

    // Wait for RevoGrid to render
    await page.waitForSelector('revo-grid', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
    await page.waitForTimeout(500);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-csv-spreadsheet.png`,
      fullPage: true,
    });
  });

  test('05 - Switch to Agent mode', async () => {
    await switchToAgentMode(page);

    // Verify agent mode UI
    const sessionHistory = page.locator(SELECTORS.sessionHistory);
    await expect(sessionHistory).toBeVisible({ timeout: 5000 });

    await page.waitForTimeout(500);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/05-agent-mode.png`,
      fullPage: true,
    });
  });

  test('06 - Verify Agent mode session interface', async () => {
    // Verify session history is visible (the main agent mode UI component)
    const sessionHistory = page.locator(SELECTORS.sessionHistory);
    await expect(sessionHistory).toBeVisible({ timeout: 3000 });

    // Take screenshot of agent mode with session history
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/06-agent-session-ui.png`,
      fullPage: true,
    });
  });

  test('07 - Switch back to Files mode', async () => {
    await switchToFilesMode(page);

    // Verify we're back in files mode with tabs visible
    const fileTabsContainer = page.locator(SELECTORS.fileTabsContainer);
    await expect(fileTabsContainer).toBeVisible({ timeout: 5000 });

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/07-files-mode-return.png`,
      fullPage: true,
    });
  });

  test('08 - Open Settings view', async () => {
    // Open settings via test helper
    await page.evaluate(() => {
      (window as any).__testHelpers?.setActiveMode('settings');
    });

    // Wait for settings view to render
    await page.waitForTimeout(500);

    // Wait for settings view
    const settingsView = page.locator(SELECTORS.settingsView);
    await expect(settingsView).toBeVisible({ timeout: 5000 });

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/08-settings-view.png`,
      fullPage: true,
    });
  });

  test('09 - Navigate to AI settings', async () => {
    // Click on AI-related settings category
    const aiSettingsItem = page.locator(SELECTORS.settingsSidebarItem, { hasText: 'AI' }).first();
    if (await aiSettingsItem.isVisible()) {
      await aiSettingsItem.click();
      await page.waitForTimeout(500);
    }

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/09-settings-ai.png`,
      fullPage: true,
    });
  });

  test('10 - Close settings and verify app state', async () => {
    // Switch back to files mode via test helper
    await switchToFilesMode(page);

    // Verify we're back to normal view
    const settingsView = page.locator(SELECTORS.settingsView);
    await expect(settingsView).not.toBeVisible({ timeout: 3000 });

    // Verify file tree is still visible
    const sidebar = page.locator(SELECTORS.workspaceSidebar);
    await expect(sidebar).toBeVisible();

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/10-final-state.png`,
      fullPage: true,
    });
  });
});
