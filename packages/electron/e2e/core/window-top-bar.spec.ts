import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import {
  createTempWorkspace,
  getKeyboardShortcut,
  launchElectronApp,
  TEST_TIMEOUTS,
  waitForAppReady,
} from '../helpers';
import {
  getProjectRailItemByPath,
  PLAYWRIGHT_TEST_SELECTORS,
} from '../utils/testHelpers';

const execFileAsync = promisify(execFile);

async function initializeGitWorkspace(workspacePath: string, branch: string): Promise<void> {
  await execFileAsync('git', ['init', '-b', branch], { cwd: workspacePath });
  await execFileAsync('git', ['config', 'user.email', 'e2e@nimbalyst.test'], { cwd: workspacePath });
  await execFileAsync('git', ['config', 'user.name', 'Nimbalyst E2E'], { cwd: workspacePath });
  await fs.writeFile(path.join(workspacePath, 'README.md'), `# ${branch}\n`, 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: workspacePath });
  await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: workspacePath });
}

async function sendMenuCommand(channel: string): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, command) => {
    BrowserWindow.getFocusedWindow()?.webContents.send(command);
  }, channel);
}

let electronApp: ElectronApplication;
let page: Page;
let workspaceA: string;
let workspaceB: string;

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(30_000);
  workspaceA = await createTempWorkspace();
  workspaceB = await createTempWorkspace();
  await initializeGitWorkspace(workspaceA, 'main');
  await initializeGitWorkspace(workspaceB, 'second-branch');

  electronApp = await launchElectronApp({
    workspace: workspaceA,
    env: {
      NODE_ENV: 'test',
      ELECTRON_RENDERER_URL: 'http://127.0.0.1:5274',
    },
  });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  await Promise.all([
    fs.rm(workspaceA, { recursive: true, force: true }).catch(() => undefined),
    fs.rm(workspaceB, { recursive: true, force: true }).catch(() => undefined),
  ]);
});

test('main project window chrome follows layout, pane, git, and project state', async () => {
    test.setTimeout(60_000);
    const topBar = page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBar);
    const workspaceRow = page.locator(PLAYWRIGHT_TEST_SELECTORS.workspaceRow);
    const gutter = page.locator(PLAYWRIGHT_TEST_SELECTORS.navigationGutter);

    await expect(topBar).toBeVisible();
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarModeLabel)).toHaveText('Files');
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarWorkspaceName)).toHaveText(path.basename(workspaceA));

    const nativeChrome = await electronApp.evaluate(({ Menu }) => {
      return {
        applicationMenuInstalled: Menu.getApplicationMenu() !== null,
        platform: process.platform,
      };
    });
    expect(nativeChrome.applicationMenuInstalled).toBe(true);
    expect(nativeChrome.platform).toBe(process.platform);

    const [barBox, rowBox, gutterBox, sidebarBox, viewportHeight] = await Promise.all([
      topBar.boundingBox(),
      workspaceRow.boundingBox(),
      gutter.boundingBox(),
      page.locator(PLAYWRIGHT_TEST_SELECTORS.workspaceSidebar).boundingBox(),
      page.evaluate(() => window.innerHeight),
    ]);
    expect(barBox).toMatchObject({ y: 0, height: 38 });
    expect(rowBox?.y).toBe(38);
    expect(rowBox ? rowBox.y + rowBox.height : null).toBe(viewportHeight);
    expect(gutterBox?.y).toBe(38);
    expect(gutterBox ? gutterBox.y + gutterBox.height : null).toBe(viewportHeight);
    expect(sidebarBox?.y).toBeGreaterThanOrEqual(38);
    await expect(workspaceRow).toBeVisible();

    const leftPaneButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarLeftPane);
    const rightPaneButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarRightPane);
    await expect(leftPaneButton).toHaveAttribute('data-collapsed', 'false');
    await expect(rightPaneButton).toHaveAttribute('data-collapsed', 'false');

    await leftPaneButton.click();
    await expect(leftPaneButton).toHaveAttribute('data-collapsed', 'true');
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.workspaceSidebar)).toHaveCount(0);
    await page.keyboard.press(getKeyboardShortcut('Mod+b'));
    await expect(leftPaneButton).toHaveAttribute('data-collapsed', 'false');
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.workspaceSidebar)).toBeVisible();

    await sendMenuCommand('toggle-bottom-panel');
    await expect(rightPaneButton).toHaveAttribute('data-collapsed', 'false');
    await rightPaneButton.click();
    await expect(rightPaneButton).toHaveAttribute('data-collapsed', 'true');
    await sendMenuCommand('toggle-ai-chat-panel');
    await expect(rightPaneButton).toHaveAttribute('data-collapsed', 'false');

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarGitStatus)).toContainText('main', {
      timeout: TEST_TIMEOUTS.SIDEBAR_LOAD,
    });
    await page.locator(PLAYWRIGHT_TEST_SELECTORS.agentModeButton).click();
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarModeLabel)).toHaveText('Agent');
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarLeftPane)).toBeVisible();
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarRightPane)).toHaveCount(0);

    await page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarLeftPane).click();
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarLeftPane)).toHaveAttribute('data-collapsed', 'true');
    await page.locator(PLAYWRIGHT_TEST_SELECTORS.filesModeButton).click();
    await page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarGitStatus).click();

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarModeLabel)).toHaveText('Agent');
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarLeftPane)).toHaveAttribute('data-collapsed', 'false');
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.sessionHistory)).toBeVisible({
      timeout: TEST_TIMEOUTS.SIDEBAR_LOAD,
    });

    await page.locator(PLAYWRIGHT_TEST_SELECTORS.filesModeButton).click();
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarModeLabel)).toHaveText('Files');
    await page.evaluate(async (workspacePath) => {
      await window.electronAPI.invoke('workspace:update-state', workspacePath, {
        activeMode: 'files',
      });
      await window.electronAPI.invoke('app:set-multi-project-mode', true);
    }, workspaceA);
    await page.reload();
    await waitForAppReady(page);

    await page.evaluate(async ({ workspacePath, activeWorkspacePath }) => {
      const registration = await window.electronAPI.invoke('workspace:register-additional', {
        workspacePath,
      });
      if (!registration?.success) {
        throw new Error(`register-additional failed: ${JSON.stringify(registration)}`);
      }
      const projects = await window.electronAPI.invoke('app:get-open-projects');
      const next = Array.isArray(projects) ? [...projects, workspacePath] : [workspacePath];
      await window.electronAPI.invoke('app:set-open-projects', next);
      await window.electronAPI.invoke('app:set-active-project-path', activeWorkspacePath);
      await window.electronAPI.invoke('workspace:set-active', { workspacePath: activeWorkspacePath });
    }, { workspacePath: workspaceB, activeWorkspacePath: workspaceA });
    await page.reload();
    await page.waitForSelector(PLAYWRIGHT_TEST_SELECTORS.projectRail, {
      timeout: TEST_TIMEOUTS.SIDEBAR_LOAD,
    });

    const itemA = getProjectRailItemByPath(page, workspaceA);
    const itemB = getProjectRailItemByPath(page, workspaceB);
    await expect(itemA).toBeVisible();
    await expect(itemB).toBeVisible();

    await itemA.click();
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarWorkspaceName)).toHaveText(path.basename(workspaceA));
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarGitStatus)).toContainText('main', {
      timeout: TEST_TIMEOUTS.SIDEBAR_LOAD,
    });

    await itemB.click();
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarWorkspaceName)).toHaveText(path.basename(workspaceB));
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.windowTopBarGitStatus)).toContainText('second-branch', {
      timeout: TEST_TIMEOUTS.SIDEBAR_LOAD,
    });
});
