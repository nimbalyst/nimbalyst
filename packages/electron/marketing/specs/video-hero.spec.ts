/**
 * Hero Video
 *
 * Ambient background video for the nimbalyst.com landing page.
 * Shows a smooth walkthrough of the app with a visible cursor.
 *
 * Dark and light themes use separate app instances so Playwright
 * records each video into the correct theme directory.
 *
 * Run with video recording enabled:
 *   npx playwright test --config=marketing/playwright.marketing.config.ts --grep="hero-ambient"
 */

import { test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  launchMarketingApp,
  switchToFilesMode,
  pause,
  setTheme,
} from '../utils/helpers';
import { injectCursor, moveAndClick, moveTo, hideCursor } from '../utils/cursor';
import { populateMarketingSessions } from '../utils/sessionData';
import * as fs from 'fs/promises';

/**
 * Shared choreography for the hero ambient video.
 * Browses file tree, opens files, switches to agent mode, returns to files.
 */
async function heroChoreography(page: Page): Promise<void> {
  await injectCursor(page);
  await pause(page, 500);

  // === Scene 1: Browse file tree (3s) ===
  await moveTo(page, '.file-tree-name:has-text("src")', { moveDuration: 600 });
  await pause(page, 400);
  await moveAndClick(page, '.file-tree-name:has-text("src")', { moveDuration: 300 });
  await pause(page, 600);

  // Expand auth folder
  await moveAndClick(page, '.file-tree-name:has-text("auth")', { moveDuration: 400 });
  await pause(page, 400);

  // === Scene 2: Open TypeScript file (3s) ===
  await moveAndClick(page, '.file-tree-name:has-text("middleware.ts")', { moveDuration: 500 });
  await pause(page, 1500); // Let Monaco load

  // === Scene 3: Open README from root (2s) ===
  await moveAndClick(page, '.file-tree-name:has-text("README.md")', { moveDuration: 500 });
  await pause(page, 1000);

  // === Scene 4: Expand data folder and open CSV (3s) ===
  await moveAndClick(page, '.file-tree-name:has-text("data")', { moveDuration: 400 });
  await pause(page, 400);
  await moveAndClick(page, '.file-tree-name:has-text("users.csv")', { moveDuration: 500 });
  await pause(page, 1500);

  // === Scene 5: Switch back to README via tab (1s) ===
  await moveAndClick(page, '.tab:has-text("README.md")', { moveDuration: 400 });
  await pause(page, 800);

  // === Scene 6: Switch to Agent mode (4s) ===
  await moveAndClick(page, '[data-mode="agent"]', { moveDuration: 600 });
  await pause(page, 1500);

  // Click on the first session
  const sessionItem = page.locator('.session-list-item').first();
  const isVisible = await sessionItem.isVisible().catch(() => false);
  if (isVisible) {
    await moveAndClick(page, '.session-list-item:first-child', { moveDuration: 500 });
    await pause(page, 2000);
  }

  // === Scene 7: Switch back to Files mode (2s) ===
  await moveAndClick(page, '[data-mode="files"]', { moveDuration: 600 });
  await pause(page, 1000);

  // === Final: Hold on files mode for a beat ===
  await hideCursor(page);
  await pause(page, 1500);
}

// --- Dark theme video (own app instance, records to videos/dark/) ---

test.describe('Hero Video Dark', () => {
  let electronApp: ElectronApplication;
  let page: Page;
  let workspaceDir: string;

  test.beforeAll(async () => {
    const result = await launchMarketingApp({ recordVideo: true, theme: 'dark' });
    electronApp = result.app;
    page = result.page;
    workspaceDir = result.workspaceDir;
    await populateMarketingSessions(page, workspaceDir);
  });

  test.afterAll(async () => {
    await electronApp?.close();
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test('hero-ambient dark theme video', async () => {
    await setTheme(electronApp, 'dark');
    await pause(page, 500);
    await heroChoreography(page);
  });
});

// --- Light theme video (own app instance, records to videos/light/) ---

test.describe('Hero Video Light', () => {
  let electronApp: ElectronApplication;
  let page: Page;
  let workspaceDir: string;

  test.beforeAll(async () => {
    const result = await launchMarketingApp({ recordVideo: true, theme: 'light' });
    electronApp = result.app;
    page = result.page;
    workspaceDir = result.workspaceDir;
    await populateMarketingSessions(page, workspaceDir);
  });

  test.afterAll(async () => {
    await electronApp?.close();
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test('hero-ambient light theme video', async () => {
    await setTheme(electronApp, 'light');
    await pause(page, 500);
    await heroChoreography(page);
  });
});
