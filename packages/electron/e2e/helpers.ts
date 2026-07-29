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

/**
 * Remove a directory, but only when it lives under the system temp dir.
 *
 * The guard is the point: this helper deletes state on every launch, and a
 * `NIMBALYST_USER_DATA_DIR` that accidentally pointed at the developer's real
 * `Application Support` directory would otherwise be wiped by running the
 * suite.
 */
async function removeTempDir(dir: string): Promise<void> {
  const resolved = path.resolve(dir);
  const tmp = path.resolve(os.tmpdir());
  if (resolved === tmp || !resolved.startsWith(tmp + path.sep)) {
    return;
  }
  try {
    await fs.rm(resolved, { recursive: true, force: true });
  } catch {
    // Ignore errors - directory might not exist
  }
}

/**
 * Clear the state a previous launch persisted: the test database AND the test
 * `userData` directory.
 *
 * The database was cleared from the start; `userData` was not, so every spec
 * inherited the settings, workspace state and Stytch credentials written by
 * whichever spec ran before it (`playwright.config.ts` is serial, so specs do
 * not race, but they do accumulate). Two independent Playwright invocations on
 * one machine also share the fixed path.
 *
 * `preserveTestDatabase` skips both, because the specs that set it are the ones
 * that relaunch the app and need the earlier launch's state to survive.
 */
async function clearTestState(options?: {
  preserveTestDatabase?: boolean;
  userDataDir?: string;
}): Promise<void> {
  if (options?.preserveTestDatabase) {
    return;
  }
  await removeTempDir(path.join(os.tmpdir(), 'nimbalyst-test-db'));
  await removeTempDir(options?.userDataDir ?? TEST_USER_DATA_DIR);
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

/**
 * Where E2E runs are allowed to keep `userData`.
 *
 * `PLAYWRIGHT=1` only redirects the database and the extensions folder --
 * `app.getPath('userData')` itself is only moved by `NIMBALYST_USER_DATA_DIR`
 * (see `src/main/bootstrap.ts`). Without this, every test run reads and writes
 * the developer's real `app-settings.json`, `workspace-settings.json`,
 * `ai-settings.json` and `stytch-*.enc`, concurrently with their running dev
 * instance (`allowMultipleInstances` is true under `PLAYWRIGHT`). Two
 * electron-store instances doing read-modify-write on the same file is how a
 * test run silently rewrites real settings.
 *
 * Fixed rather than random so a spec that relaunches the app can still see the
 * state its earlier launch persisted -- same convention as `nimbalyst-test-db`,
 * and cleared on the same terms: `launchElectronApp` wipes it unless the spec
 * passes `preserveTestDatabase: true`. A per-spec directory would isolate
 * concurrent Playwright invocations too, but it would break the
 * relaunch-and-restore specs, which depend on a path that is stable across two
 * launches; that trade is not taken here.
 */
export const TEST_USER_DATA_DIR = path.join(os.tmpdir(), 'nimbalyst-test-user-data');

/**
 * `process.env` is typed `string | undefined` per key, but Playwright's `env`
 * option and `child_process.spawn` both want `Record<string, string>`. Drop the
 * undefined-valued keys at this boundary rather than casting: an explicit
 * `undefined` in a spawn env is not the same as an absent key, and the cast
 * would hide that.
 */
function definedEnvEntries(env: NodeJS.ProcessEnv): Record<string, string> {
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) defined[key] = value;
  }
  return defined;
}

export function buildTestEnv(
  devServerUrl: string,
  options?: {
    env?: Record<string, string>;
    permissionMode?: TestPermissionMode;
  }
): Record<string, string> {
  const { ELECTRON_RUN_AS_NODE, ELECTRON_NO_ATTACH_CONSOLE, NODE_PATH, ...cleanEnv } = process.env;
  const testEnv: Record<string, string> = {
    ...definedEnvEntries(cleanEnv),
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'playwright-test-key',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    ELECTRON_RENDERER_URL: devServerUrl,
    PLAYWRIGHT: '1',
    NIMBALYST_CDP_PORT: '9333',
    // After the `cleanEnv` spread so an inherited value (a worktree dev shell
    // exports one) can't drag the run back onto real user data, and before
    // `options.env` so a spec can still pick its own directory.
    NIMBALYST_USER_DATA_DIR: TEST_USER_DATA_DIR,
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

  // Clear the test database and userData directories to prevent corruption and
  // leaked settings/credentials from previous runs. Both live in the system temp
  // directory under fixed names.
  await clearTestState({
    preserveTestDatabase: options?.preserveTestDatabase,
    userDataDir: options?.env?.NIMBALYST_USER_DATA_DIR,
  });
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

  await clearTestState({
    preserveTestDatabase: options?.preserveTestDatabase,
    userDataDir: options?.env?.NIMBALYST_USER_DATA_DIR,
  });
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
