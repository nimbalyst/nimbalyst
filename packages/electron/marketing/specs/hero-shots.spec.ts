/**
 * Hero Screenshots
 *
 * Primary marketing screenshots showing the full app experience.
 * Each is captured in both dark and light themes.
 */

import { test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  launchMarketingApp,
  captureScreenshotBothThemes,
  openFile,
  switchToAgentMode,
  switchToFilesMode,
  openAIChatSidebar,
  pause,
} from '../utils/helpers';
import { populateMarketingSessions } from '../utils/sessionData';
import * as fs from 'fs/promises';

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

test.beforeAll(async () => {
  const result = await launchMarketingApp();
  electronApp = result.app;
  page = result.page;
  workspaceDir = result.workspaceDir;
});

test.afterAll(async () => {
  await electronApp?.close();
  await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

test('hero-files-mode - Full app with file tree, document, and AI chat', async () => {
  // Open the README to show rich markdown content
  await openFile(page, 'README.md');
  await pause(page, 1000);

  // Open the AI chat sidebar
  await openAIChatSidebar(page);
  await pause(page, 500);

  await captureScreenshotBothThemes(electronApp, page, 'hero-files-mode');
});

test('hero-agent-mode - Agent mode with session history and transcript', async () => {
  // Populate sessions for the agent mode view
  await populateMarketingSessions(page, workspaceDir);

  // Switch to agent mode
  await switchToAgentMode(page);
  await pause(page, 1000);

  // Click on the primary session to show transcript
  const sessionItem = page.locator('.session-list-item').first();
  const isVisible = await sessionItem.isVisible().catch(() => false);
  if (isVisible) {
    await sessionItem.click();
    await pause(page, 1000);
  }

  await captureScreenshotBothThemes(electronApp, page, 'hero-agent-mode');
});

test('hero-multi-editor - Multiple editor types open in tabs', async () => {
  // Switch back to files mode
  await switchToFilesMode(page);
  await pause(page, 500);

  // Open multiple file types to populate the tab bar
  await openFile(page, 'README.md');
  await openFile(page, 'index.ts');
  await openFile(page, 'users.csv');
  await openFile(page, 'config.json');

  // Switch back to the TypeScript file for a code-centric screenshot
  await page.locator('.tab', { hasText: 'index.ts' }).click();
  await pause(page, 500);

  await captureScreenshotBothThemes(electronApp, page, 'hero-multi-editor');
});
