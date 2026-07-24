/**
 * Settings & Special Feature Screenshots
 *
 * Settings panels, history dialog, search/replace, tracker, etc.
 * Each is captured in both dark and light themes.
 */

import { test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  launchMarketingApp,
  captureScreenshotBothThemes,
  openFile,
  switchToFilesMode,
  switchToSettings,
  openSettingsCategory,
  pause,
} from '../utils/helpers';
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

// --- Settings ---

test('settings-general - General settings panel', async () => {
  await switchToSettings(page);
  await pause(page, 500);

  await captureScreenshotBothThemes(electronApp, page, 'settings-general');
});

test('settings-ai - AI configuration panel', async () => {
  await switchToSettings(page);
  await openSettingsCategory(page, 'AI');
  await pause(page, 500);

  await captureScreenshotBothThemes(electronApp, page, 'settings-ai');
});

test('settings-permissions - Agent Permissions panel', async () => {
  await switchToSettings(page);
  await openSettingsCategory(page, 'Agent Permissions');
  await pause(page, 500);

  await captureScreenshotBothThemes(electronApp, page, 'settings-permissions');
});

test('settings-appearance - Appearance/Theme panel', async () => {
  await switchToSettings(page);
  await openSettingsCategory(page, 'Appearance');
  await pause(page, 500);

  await captureScreenshotBothThemes(electronApp, page, 'settings-appearance');
});

// --- Special Features ---

test('feature-tracker-header - Document with status/tracker bar', async () => {
  await switchToFilesMode(page);
  await openFile(page, 'v2-migration.md');

  // Wait for the tracker/status bar to render
  await pause(page, 1500);

  await captureScreenshotBothThemes(electronApp, page, 'feature-tracker-header');
});

test('feature-search-replace - Find & Replace bar active', async () => {
  await switchToFilesMode(page);
  await openFile(page, 'README.md');
  await pause(page, 500);

  // Open search bar
  const isMac = process.platform === 'darwin';
  await page.keyboard.press(isMac ? 'Meta+f' : 'Control+f');
  await pause(page, 500);

  // Type a search term
  const searchInput = page.locator('[data-testid="search-input"]');
  const isSearchVisible = await searchInput.isVisible().catch(() => false);
  if (isSearchVisible) {
    await searchInput.fill('API');
    await pause(page, 500);
  }

  await captureScreenshotBothThemes(electronApp, page, 'feature-search-replace');

  // Close search bar
  await page.keyboard.press('Escape');
});

test('feature-workspace-file-tree - Rich project file tree', async () => {
  await switchToFilesMode(page);

  // Expand the src folder by clicking on it
  const srcFolder = page.locator('.file-tree-name', { hasText: 'src' }).first();
  const isSrcVisible = await srcFolder.isVisible().catch(() => false);
  if (isSrcVisible) {
    await srcFolder.click();
    await pause(page, 300);
  }

  // Expand the auth subfolder
  const authFolder = page.locator('.file-tree-name', { hasText: 'auth' }).first();
  const isAuthVisible = await authFolder.isVisible().catch(() => false);
  if (isAuthVisible) {
    await authFolder.click();
    await pause(page, 300);
  }

  // Expand the api subfolder
  const apiFolder = page.locator('.file-tree-name', { hasText: 'api' }).first();
  const isApiVisible = await apiFolder.isVisible().catch(() => false);
  if (isApiVisible) {
    await apiFolder.click();
    await pause(page, 300);
  }

  // Open a file so the editor area isn't empty
  await openFile(page, 'README.md');
  await pause(page, 500);

  await captureScreenshotBothThemes(electronApp, page, 'feature-workspace-file-tree');
});

test('feature-multiple-tabs - Tab bar with several open files', async () => {
  await switchToFilesMode(page);

  // Open a variety of files
  await openFile(page, 'README.md');
  await openFile(page, 'middleware.ts');
  await openFile(page, 'handlers.ts');
  await openFile(page, 'users.csv');
  await openFile(page, 'config.json');
  await openFile(page, 'api-spec.md');

  // Keep focus on one of the middle tabs
  await page.locator('.tab', { hasText: 'handlers.ts' }).click();
  await pause(page, 500);

  await captureScreenshotBothThemes(electronApp, page, 'feature-multiple-tabs');
});
