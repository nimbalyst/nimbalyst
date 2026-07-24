import { _electron, chromium } from '@playwright/test';
import type { Browser, ElectronApplication, Page } from 'playwright';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

// Centralized timeouts for consistent test behavior
export const TEST_TIMEOUTS = {
  APP_LAUNCH: 5000,       // App should launch quickly
  SIDEBAR_LOAD: 15000,     // Sidebar should appear fast
  FILE_TREE_LOAD: 5000,   // File tree items should load fast
  TAB_SWITCH: 3000,       // Tab switching is instant
  EDITOR_LOAD: 3000,      // Editor loads quickly
  SAVE_OPERATION: 2000,   // Saves are fast
  DEFAULT_WAIT: 500,      // Standard wait between operations
  VERY_LONG: 60000,       // For long-running operations like AI interactions
};

// Selector for the active editor (accounts for multi-editor architecture)
// Scoped to file-tabs-container to avoid matching plan or AI editors
// Note: The wrapper div (.tab-editor-wrapper) controls visibility via display:block/none
// We select the visible multi-editor-instance's contenteditable
export const ACTIVE_EDITOR_SELECTOR = '.file-tabs-container .tab-editor-wrapper:not([style*="display: none"]) .multi-editor-instance .editor [contenteditable="true"]';

// Selector for the active file tab title
// Scoped to file-tabs-container to avoid matching AI Chat tabs
export const ACTIVE_FILE_TAB_SELECTOR = '.file-tabs-container .tab.active .tab-title';

/**
 * Permission mode for testing. Use with launchElectronApp's permissionMode option.
 * - 'ask': Smart Permissions mode (requires manual approval for each tool)
 * - 'allow-all': Always Allow mode (no permission prompts) - DEFAULT
 * - 'none': Don't auto-configure (shows trust toast) - use this to test the trust toast
 */
export type TestPermissionMode = 'ask' | 'allow-all' | 'none';

export interface CdpElectronApp {
  firstWindow(): Promise<Page>;
  close(): Promise<void>;
}

async function clearTestDatabase(preserveTestDatabase?: boolean): Promise<void> {
  if (preserveTestDatabase) {
    return;
  }
  const testDbPath = path.join(os.tmpdir(), 'nimbalyst-test-db');
  try {
    await fs.rm(testDbPath, { recursive: true, force: true });
  } catch {
    // Ignore errors - directory might not exist
  }
}

async function findDevServerUrl(): Promise<string> {
  const devServerUrls = ['http://127.0.0.1:5273', 'http://[::1]:5273'];
  let lastError: Error | null = null;

  for (const url of devServerUrls) {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      if (response.ok) {
        return url;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error(
    `\n\n❌ Dev server is not running!\n\n` +
    `Playwright tests require the Vite dev server to be running on port 5273.\n` +
    `Please start it in a separate terminal:\n\n` +
    `  cd packages/electron && npm run dev\n\n` +
    `Then run the tests again.\n\n` +
    `Original error: ${lastError?.message ?? 'Unknown error'}\n`
  );
}

function buildElectronArgs(electronMain: string, workspace?: string): string[] {
  const args = [electronMain];
  if (process.platform === 'linux' && process.getuid && process.getuid() === 0) {
    args.push('--no-sandbox');
  }
  if (workspace) {
    args.push('--workspace', workspace);
  }
  return args;
}

function buildTestEnv(
  devServerUrl: string,
  options?: {
    env?: Record<string, string>;
    permissionMode?: TestPermissionMode;
  }
): Record<string, string | undefined> {
  const { ELECTRON_RUN_AS_NODE, ELECTRON_NO_ATTACH_CONSOLE, NODE_PATH, ...cleanEnv } = process.env;
  const testEnv: Record<string, string | undefined> = {
    ...cleanEnv,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'playwright-test-key',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    ELECTRON_RENDERER_URL: devServerUrl,
    PLAYWRIGHT: '1',
    NIMBALYST_CDP_PORT: '9333',
    ...options?.env,
  };

  const permissionMode = options?.permissionMode ?? 'allow-all';
  if (permissionMode !== 'none') {
    testEnv.NIMBALYST_PERMISSION_MODE = permissionMode;
  }

  if (options?.env && 'ENABLE_SESSION_RESTORE' in options.env) {
    delete testEnv.PLAYWRIGHT;
    delete testEnv.ENABLE_SESSION_RESTORE;
  }

  return testEnv;
}

async function waitForCdpEndpoint(port: string, timeoutMs = TEST_TIMEOUTS.SIDEBAR_LOAD): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`CDP endpoint returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for CDP endpoint on port ${port}: ${lastError?.message ?? 'unknown error'}`);
}

async function findMainAppPage(browser: Browser, timeoutMs = TEST_TIMEOUTS.SIDEBAR_LOAD): Promise<Page> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const url = page.url();
        if (url.startsWith('devtools://')) continue;
        if (url === 'about:blank') continue;
        return page;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error('Timed out waiting for the main Electron window page');
}

async function closeSpawnedElectron(
  browser: Browser,
  child: ChildProcess,
): Promise<void> {
  await browser.close().catch(() => undefined);
  if (child.exitCode !== null || child.killed) {
    return;
  }
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function launchElectronApp(options?: {
  workspace?: string;
  env?: Record<string, string>;
  /** Permission mode. Defaults to 'allow-all' to skip trust toast. Use 'none' to show the toast. */
  permissionMode?: TestPermissionMode;
  /** Skip clearing the test database. Default false - database is cleared on each launch to prevent corruption issues. */
  preserveTestDatabase?: boolean;
  /** Video recording config. Defaults to e2e_test_output/videos. Pass false to disable. */
  recordVideo?: { dir: string } | false;
}): Promise<ElectronApplication> {
  const electronMain = path.resolve(__dirname, '../out/main/index.js');
  const electronCwd = path.resolve(__dirname, '../../../');

  // Default video recording to e2e_test_output/videos (opt-out with recordVideo: false)
  const defaultVideoDir = path.resolve(__dirname, '../../../e2e_test_output/videos');
  const recordVideoConfig = options?.recordVideo === false
    ? undefined
    : (options?.recordVideo ?? { dir: defaultVideoDir });

  // Clear the test database directory to prevent corruption issues from previous runs
  // The test database is stored in the system temp directory with a fixed name
  await clearTestDatabase(options?.preserveTestDatabase);
  const devServerUrl = await findDevServerUrl();
  const args = buildElectronArgs(electronMain, options?.workspace);
  const testEnv = buildTestEnv(devServerUrl, {
    env: options?.env,
    permissionMode: options?.permissionMode,
  });

  const app = await _electron.launch({
    ...(recordVideoConfig ? { recordVideo: recordVideoConfig } : {}),
    args,
    cwd: electronCwd,
    env: testEnv
  });

  // Automatically setup console logging for the first window
  app.on('window', async (page) => {
    await setupPageWithLogging(page);
  });

  return app;
}

export async function launchElectronAppViaCdp(options?: {
  workspace?: string;
  env?: Record<string, string>;
  permissionMode?: TestPermissionMode;
  preserveTestDatabase?: boolean;
}): Promise<CdpElectronApp> {
  const electronMain = path.resolve(__dirname, '../out/main/index.js');
  const electronCwd = path.resolve(__dirname, '../../../');
  const cdpPort = options?.env?.NIMBALYST_CDP_PORT ?? '9333';

  await clearTestDatabase(options?.preserveTestDatabase);
  const devServerUrl = await findDevServerUrl();
  const args = buildElectronArgs(electronMain, options?.workspace);
  const testEnv = buildTestEnv(devServerUrl, {
    env: options?.env,
    permissionMode: options?.permissionMode,
  });

  const electronBinary = (await import('electron')).default as unknown as string;
  const child = spawn(electronBinary, args, {
    cwd: electronCwd,
    env: testEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk) => {
    process.stdout.write(String(chunk));
  });
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(String(chunk));
  });

  await waitForCdpEndpoint(cdpPort);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);

  let mainPage: Page | null = null;

  return {
    async firstWindow(): Promise<Page> {
      if (mainPage && !mainPage.isClosed()) {
        return mainPage;
      }
      mainPage = await findMainAppPage(browser);
      await setupPageWithLogging(mainPage);
      return mainPage;
    },
    async close(): Promise<void> {
      await closeSpawnedElectron(browser, child);
    },
  };
}

export async function createTempWorkspace(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'nimbalyst-test-'));
}

/**
 * Setup page with console log capturing for debugging
 * Call this after getting the page from electronApp
 */
export async function setupPageWithLogging(page: Page): Promise<void> {
  // Capture console messages from the renderer process
  page.on('console', msg => {
    const type = msg.type();
    const text = msg.text();

    // Filter out noisy messages
    if (text.includes('Download the React DevTools')) return;
    if (text.includes('Lit is in dev mode')) return;

    // Format the console message with color
    const prefix = type === 'error' ? '❌' : type === 'warning' ? '⚠️' : '🔍';
    console.log(`${prefix} [Browser ${type}]`, text);
  });

  // Capture page errors
  page.on('pageerror', error => {
    console.error('❌ [Browser Error]', error.message);
  });
}

export async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.workspace-sidebar', { timeout: TEST_TIMEOUTS.SIDEBAR_LOAD });
}

/**
 * Dismiss the project trust toast if it appears.
 * Clicks "Allow Edits" (the recommended option) to trust the project.
 * Safe to call even if the toast doesn't appear - will just return after timeout.
 *
 * @param page The Playwright page
 * @param timeout How long to wait for the toast (default 2000ms)
 */
export async function dismissProjectTrustToast(page: Page, timeout = 2000): Promise<void> {
  try {
    // Wait for the trust toast to appear - new UI has a heading with "Trust" in it
    const toast = page.getByRole('heading', { name: /^Trust .+\?$/ });
    await toast.waitFor({ state: 'visible', timeout });

    // Click the "Allow Edits" button (recommended option in new UI)
    const allowEditsBtn = page.getByRole('button', { name: /Allow Edits/ });
    await allowEditsBtn.click();

    // Click Save to confirm
    const saveButton = page.getByRole('button', { name: 'Save' });
    await saveButton.click();

    // Wait for the toast to disappear
    await toast.waitFor({ state: 'hidden', timeout: 2000 });
  } catch {
    // Toast didn't appear or was already dismissed - that's fine
  }
}

export async function waitForEditor(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-testid="editor"]', { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
}

/**
 * Set the release channel for the app.
 * Useful for tests that need to use alpha-only extensions.
 *
 * @param page The Playwright page
 * @param channel The release channel ('stable' or 'alpha')
 */
export async function setReleaseChannel(page: Page, channel: 'stable' | 'alpha'): Promise<void> {
  await page.evaluate(async (ch) => {
    await window.electronAPI.invoke('release-channel:set', ch);
  }, channel);
  // Wait for the setting to propagate
  await page.waitForTimeout(100);
}

export function getKeyboardShortcut(key: string): string {
  const isMac = process.platform === 'darwin';
  return key.replace('Mod', isMac ? 'Meta' : 'Control');
}

/**
 * Dispatch a keyboard shortcut using native KeyboardEvent
 * This is necessary because page.keyboard.press() doesn't work reliably in Electron
 * @param page The Playwright page
 * @param shortcut The shortcut string (e.g., 'Mod+Y', 'Mod+S')
 */
export async function pressKeyboardShortcut(page: Page, shortcut: string): Promise<void> {
  // Parse the shortcut string
  const parts = shortcut.split('+');
  const modifiers = parts.slice(0, -1);
  const key = parts[parts.length - 1].toLowerCase();

  await page.evaluate(({ key: keyChar, modifiers: mods }) => {
    const isMac = navigator.platform.includes('Mac');
    const event = new KeyboardEvent('keydown', {
      key: keyChar,
      code: `Key${keyChar.toUpperCase()}`,
      metaKey: mods.includes('Mod') ? isMac : mods.includes('Meta'),
      ctrlKey: mods.includes('Mod') ? !isMac : mods.includes('Control') || mods.includes('Ctrl'),
      shiftKey: mods.includes('Shift'),
      altKey: mods.includes('Alt') || mods.includes('Option'),
      bubbles: true,
      cancelable: true
    });
    document.dispatchEvent(event);
  }, { key, modifiers });
}
