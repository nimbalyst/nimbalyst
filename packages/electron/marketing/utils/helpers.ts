/**
 * Marketing Screenshot & Video Helpers
 *
 * Utilities for capturing marketing screenshots in both dark and light themes,
 * launching the app with a fixture workspace, and common setup operations.
 */

import { _electron } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

// Fixed viewport for consistent marketing screenshots
export const MARKETING_VIEWPORT = { width: 1440, height: 900 };

// Output directories
export const SCREENSHOT_DIR = path.resolve(__dirname, '../screenshots');
export const VIDEO_DIR = path.resolve(__dirname, '../videos');

// Fixture workspace source (copied to temp dir for each run)
export const FIXTURE_WORKSPACE_SRC = path.resolve(__dirname, '../fixtures/workspace');

export type Theme = 'dark' | 'light';

/**
 * Launch the Electron app configured for marketing capture.
 * Uses a temp copy of the fixture workspace to avoid mutations.
 *
 * Requires the dev server running on port 5273 (npm run dev).
 */
export async function launchMarketingApp(options?: {
  workspace?: string;
  recordVideo?: boolean;
  theme?: Theme;
}): Promise<{ app: ElectronApplication; page: Page; workspaceDir: string }> {
  const electronMain = path.resolve(__dirname, '../../out/main/index.js');
  const electronCwd = path.resolve(__dirname, '../../../../');

  // Create temp workspace from fixtures
  const workspaceDir = options?.workspace ?? (await createTempWorkspace());

  // Clear test database
  const testDbPath = path.join(os.tmpdir(), 'nimbalyst-test-db');
  try {
    await fs.rm(testDbPath, { recursive: true, force: true });
  } catch {
    // Ignore
  }

  // Check dev server
  const devServerUrl = await findDevServer();

  const args = [electronMain, '--workspace', workspaceDir];

  const videoConfig = options?.recordVideo
    ? { dir: path.join(VIDEO_DIR, options?.theme ?? 'dark') }
    : undefined;

  // Build env, stripping vars that interfere with Electron launch.
  // ELECTRON_RUN_AS_NODE makes Electron act as plain Node.js (set when running inside packaged Nimbalyst).
  // These must be removed so the launched Electron process runs as a real Electron app.
  const { ELECTRON_RUN_AS_NODE, ELECTRON_NO_ATTACH_CONSOLE, NODE_PATH, ...cleanEnv } = process.env;
  const app = await _electron.launch({
    ...(videoConfig ? { recordVideo: videoConfig } : {}),
    args,
    cwd: electronCwd,
    env: {
      ...cleanEnv as Record<string, string>,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'marketing-capture-key',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      ELECTRON_RENDERER_URL: devServerUrl,
      PLAYWRIGHT: '1',
      NIMBALYST_PERMISSION_MODE: 'allow-all',
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  // Wait for workspace sidebar to be visible
  await page.waitForSelector('.workspace-sidebar', { timeout: 15000 });

  // Wait for renderer to fully stabilize (avoids context destruction during navigation)
  await page.waitForTimeout(1000);

  // Set initial theme
  const theme = options?.theme ?? 'dark';
  await setTheme(app, theme);

  // Wait for theme to apply
  await page.waitForTimeout(500);

  return { app, page, workspaceDir };
}

/**
 * Create a temporary workspace by copying the fixture workspace.
 */
export async function createTempWorkspace(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nimbalyst-marketing-'));
  await copyDir(FIXTURE_WORKSPACE_SRC, tempDir);
  return tempDir;
}

/**
 * Recursively copy a directory.
 */
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Switch the app theme via IPC.
 * Retries on context destruction (can happen during initial page load/navigation).
 */
export async function setTheme(app: ElectronApplication, theme: Theme): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await app.evaluate(({ BrowserWindow }, t) => {
        BrowserWindow.getAllWindows().forEach(window => {
          window.webContents.send('theme-change', t);
        });
      }, theme);
      return;
    } catch (err: any) {
      if (attempt < 2 && err.message?.includes('Execution context was destroyed')) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Capture a screenshot in both dark and light themes.
 * Saves to screenshots/dark/{name}.png and screenshots/light/{name}.png.
 */
export async function captureScreenshotBothThemes(
  app: ElectronApplication,
  page: Page,
  name: string,
  options?: { fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } }
): Promise<void> {
  for (const theme of ['dark', 'light'] as Theme[]) {
    await setTheme(app, theme);
    await page.waitForTimeout(600); // Let theme transition complete

    const dir = path.join(SCREENSHOT_DIR, theme);
    await fs.mkdir(dir, { recursive: true });

    await page.screenshot({
      path: path.join(dir, `${name}.png`),
      fullPage: options?.fullPage,
      clip: options?.clip,
    });
  }
}

/**
 * Capture a screenshot for a single theme.
 */
export async function captureScreenshot(
  page: Page,
  name: string,
  theme: Theme,
  options?: { fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } }
): Promise<void> {
  const dir = path.join(SCREENSHOT_DIR, theme);
  await fs.mkdir(dir, { recursive: true });

  await page.screenshot({
    path: path.join(dir, `${name}.png`),
    fullPage: options?.fullPage,
    clip: options?.clip,
  });
}

/**
 * Expand a folder in the file tree by clicking its name.
 * Waits for children to become visible.
 */
export async function expandFolder(page: Page, folderName: string): Promise<void> {
  const folder = page.locator('.file-tree-directory .file-tree-name', { hasText: folderName }).first();
  await folder.waitFor({ state: 'visible', timeout: 5000 });
  // Check if already expanded via aria-expanded on parent
  const dir = page.locator('.file-tree-directory', { hasText: folderName }).first();
  const expanded = await dir.getAttribute('aria-expanded');
  if (expanded !== 'true') {
    await folder.click();
    await page.waitForTimeout(400);
  }
}

/**
 * Open a file from the file tree by clicking its name.
 * If the file is not visible, expands all collapsed directories until found.
 */
export async function openFile(page: Page, fileName: string): Promise<void> {
  const fileItem = page.locator('.file-tree-file .file-tree-name', { hasText: fileName }).first();

  // Keep expanding collapsed directories until the file appears
  for (let round = 0; round < 5; round++) {
    if (await fileItem.isVisible().catch(() => false)) break;
    // Find all collapsed directories and expand them
    const collapsed = page.locator('.file-tree-directory[aria-expanded="false"]');
    const count = await collapsed.count();
    if (count === 0) break;
    for (let i = 0; i < count; i++) {
      const dir = collapsed.nth(i);
      if (await dir.isVisible().catch(() => false)) {
        await dir.locator('.file-tree-name').click();
        await page.waitForTimeout(300);
        if (await fileItem.isVisible().catch(() => false)) break;
      }
    }
  }

  await fileItem.waitFor({ state: 'visible', timeout: 5000 });
  await fileItem.click();
  // Wait for tab to appear
  await page.locator('.tab', { hasText: fileName }).waitFor({ state: 'visible', timeout: 3000 });
  await page.waitForTimeout(500); // Let editor fully render
}

/**
 * Switch to Agent mode.
 */
export async function switchToAgentMode(page: Page): Promise<void> {
  const agentMode = page.locator('.agent-mode');
  const isVisible = await agentMode.isVisible().catch(() => false);
  if (!isVisible) {
    await page.locator('[data-mode="agent"]').click();
    await page.waitForTimeout(1500);
  }
}

/**
 * Switch to Files mode.
 */
export async function switchToFilesMode(page: Page): Promise<void> {
  const sidebar = page.locator('.workspace-sidebar');
  const isVisible = await sidebar.isVisible().catch(() => false);
  if (!isVisible) {
    await page.locator('[data-mode="files"]').click();
    await page.waitForTimeout(500);
    await page.waitForSelector('.workspace-sidebar', { timeout: 5000 });
  }
}

/**
 * Switch to Settings mode.
 */
export async function switchToSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__testHelpers?.setActiveMode('settings');
  });
  await page.waitForSelector('.settings-view', { timeout: 5000 });
  await page.waitForTimeout(500);
}

/**
 * Click a settings category item.
 */
export async function openSettingsCategory(page: Page, categoryText: string): Promise<void> {
  const item = page.locator('.settings-category-item', { hasText: categoryText }).first();
  if (await item.isVisible()) {
    await item.click();
    await page.waitForTimeout(500);
  }
}

/**
 * Open the AI Chat sidebar panel.
 */
export async function openAIChatSidebar(page: Page): Promise<void> {
  const chatPanel = page.locator('[data-testid="chat-sidebar-panel"]');
  const isVisible = await chatPanel.isVisible().catch(() => false);
  if (!isVisible) {
    await page.keyboard.press('Meta+Shift+A');
    await page.waitForTimeout(500);
  }
}

/**
 * Wait for a short pause (for video choreography).
 */
export async function pause(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}

/**
 * Find the dev server URL.
 */
async function findDevServer(): Promise<string> {
  const urls = ['http://127.0.0.1:5273', 'http://[::1]:5273'];
  for (const url of urls) {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      if (response.ok) return url;
    } catch {
      // Try next
    }
  }

  // Detect if running inside packaged Nimbalyst (ELECTRON_RUN_AS_NODE is set by the app)
  const isPackagedBuild = !!process.env.ELECTRON_RUN_AS_NODE;
  if (isPackagedBuild) {
    throw new Error(
      '\n\nMarketing screenshots cannot be captured from the packaged Nimbalyst app.\n\n' +
      'You need to switch to dev mode first:\n\n' +
      '  1. Quit the packaged Nimbalyst app\n' +
      '  2. Open a terminal and cd to the repo: cd ~/sources/nimbalyst\n' +
      '  3. Pull latest and install: git pull && npm install\n' +
      '  4. Start the dev server: cd packages/electron && npm run dev\n' +
      '  5. Ask the agent in dev-mode Nimbalyst to capture the screenshots\n\n' +
      'See docs/MARKETING_SCREENSHOTS.md for the full guide.\n'
    );
  }

  throw new Error(
    'Dev server not running on port 5273. Start it with: cd packages/electron && npm run dev'
  );
}
