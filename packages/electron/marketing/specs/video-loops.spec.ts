/**
 * Short Loop Videos (5-10s)
 *
 * Single-feature demonstrations for inline embedding on marketing pages.
 * Each loop is a self-contained demo of one feature.
 */

import { test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  launchMarketingApp,
  openFile,
  switchToFilesMode,
  setTheme,
  pause,
} from '../utils/helpers';
import { injectCursor, moveAndClick, moveTo } from '../utils/cursor';
import * as fs from 'fs/promises';

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

test.describe('Short Loop Videos', () => {
  test.beforeAll(async () => {
    const result = await launchMarketingApp({ recordVideo: true, theme: 'dark' });
    electronApp = result.app;
    page = result.page;
    workspaceDir = result.workspaceDir;
  });

  test.afterAll(async () => {
    await electronApp?.close();
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  });

  test('loop-open-file - Click file in tree, editor loads', async () => {
    await setTheme(electronApp, 'dark');
    await switchToFilesMode(page);
    await injectCursor(page);
    await pause(page, 300);

    // Expand src folder
    await moveAndClick(page, '.file-tree-name:has-text("src")', { moveDuration: 400 });
    await pause(page, 400);

    // Expand auth folder
    await moveAndClick(page, '.file-tree-name:has-text("auth")', { moveDuration: 400 });
    await pause(page, 400);

    // Click middleware.ts to open it
    await moveAndClick(page, '.file-tree-name:has-text("middleware.ts")', { moveDuration: 500 });
    await pause(page, 2000); // Let editor load and render

    // Hold for a moment
    await pause(page, 1000);
  });

  test('loop-tab-switch - Click through different editor tabs', async () => {
    await setTheme(electronApp, 'dark');
    await switchToFilesMode(page);

    // Pre-open several files
    await openFile(page, 'README.md');
    await openFile(page, 'middleware.ts');
    await openFile(page, 'users.csv');
    await openFile(page, 'config.json');

    await injectCursor(page);
    await pause(page, 300);

    // Switch between tabs with cursor
    await moveAndClick(page, '.tab:has-text("README.md")', { moveDuration: 400 });
    await pause(page, 800);

    await moveAndClick(page, '.tab:has-text("middleware.ts")', { moveDuration: 400 });
    await pause(page, 800);

    await moveAndClick(page, '.tab:has-text("users.csv")', { moveDuration: 400 });
    await pause(page, 800);

    await moveAndClick(page, '.tab:has-text("config.json")', { moveDuration: 400 });
    await pause(page, 800);

    // Back to README
    await moveAndClick(page, '.tab:has-text("README.md")', { moveDuration: 400 });
    await pause(page, 1000);
  });

  test('loop-ai-diff - AI edits appear and user accepts', async () => {
    await setTheme(electronApp, 'dark');
    await switchToFilesMode(page);
    await openFile(page, 'middleware.ts');
    await pause(page, 1000);

    await injectCursor(page);

    // Try to apply a diff
    try {
      await page.evaluate(async () => {
        const editorRegistry = (window as any).__editorRegistry;
        if (!editorRegistry) return;

        const filePath = editorRegistry.getActiveFilePath();
        if (!filePath) return;

        await editorRegistry.applyReplacements(filePath, [
          {
            oldText: "const header = req.headers.authorization;",
            newText: "const header = req.headers.authorization ?? req.headers['x-auth-token'];",
          },
        ]);
      });

      await pause(page, 1500);

      // Move cursor to "Keep All" button and click
      const keepAllButton = page.locator('[data-testid="diff-keep-all"]');
      const isKeepVisible = await keepAllButton.isVisible().catch(() => false);
      if (isKeepVisible) {
        await moveAndClick(page, '[data-testid="diff-keep-all"]', { moveDuration: 500 });
        await pause(page, 1000);
      }
    } catch {
      // If editor registry isn't available, still capture something
      await pause(page, 2000);
    }
  });
});
