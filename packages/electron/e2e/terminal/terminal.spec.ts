/**
 * Terminal E2E Tests
 *
 * Consolidated from:
 * - terminal-session.spec.ts (Terminal creation, commands, session list)
 * - terminal-reopen.spec.ts (Terminal close/reopen, cursor position after scrollback)
 *
 * All tests share a single Electron app instance for performance.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  TEST_TIMEOUTS
} from '../helpers';
import {
  switchToFilesMode
} from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspacePath: string;

test.beforeAll(async () => {
  workspacePath = await createTempWorkspace();
  electronApp = await launchElectronApp({ workspace: workspacePath });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
});

test.afterAll(async () => {
  if (electronApp) {
    await electronApp.close();
  }
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
});

async function openTerminalPanel(page: Page): Promise<void> {
  await switchToFilesMode(page);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('terminal:show')));
  await expect(page.locator('.terminal-bottom-panel-container')).toBeVisible({ timeout: 5000 });
}

function activeTerminalInput(page: Page) {
  return page.locator('.terminal-bottom-panel-terminal:visible [data-testid="terminal-container"]');
}

async function ensureTerminalReady(page: Page): Promise<void> {
  const terminalContainer = activeTerminalInput(page);
  if (await terminalContainer.isVisible().catch(() => false)) {
    await expect(page.locator('.terminal-bottom-panel-terminal:visible .terminal-container')).toBeVisible({ timeout: 5000 });
    return;
  }

  const emptyButton = page.locator('.terminal-bottom-panel-empty button');
  if (await emptyButton.isVisible().catch(() => false)) {
    await emptyButton.click();
  } else {
    await page.locator('.terminal-bottom-panel-new-tab').click();
  }

  await expect(terminalContainer).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.terminal-bottom-panel-terminal:visible .terminal-container')).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(1500);
}

async function sendCommandToActiveTerminal(page: Page, workspacePath: string, command: string): Promise<void> {
  await page.evaluate(async ({ workspacePath, command }) => {
    const activeTerminalId = await window.electronAPI.terminal.getActive(workspacePath);
    if (!activeTerminalId) {
      throw new Error('No active terminal found');
    }

    await window.electronAPI.terminal.write(activeTerminalId, `${command}\r`);
  }, { workspacePath, command });
}

// --- Terminal Session tests (from terminal-session.spec.ts) ---

test.describe('Terminal Bottom Panel Sessions', () => {
  test('should create a bottom-panel terminal and execute pwd command', async () => {
    test.setTimeout(TEST_TIMEOUTS.VERY_LONG);

    await openTerminalPanel(page);
    await ensureTerminalReady(page);

    // Find the xterm container
    const xtermContainer = page.locator('.terminal-container');
    await expect(xtermContainer).toBeVisible({ timeout: 5000 });

    const pwdOutputFile = path.join(workspacePath, 'pwd-output.txt');
    await sendCommandToActiveTerminal(page, workspacePath, `pwd > "${pwdOutputFile}"`);
    await page.waitForTimeout(1000);

    const pwdOutput = await fs.readFile(pwdOutputFile, 'utf8');
    expect(pwdOutput.trim()).toBe(workspacePath);
  });

  test('should render a terminal tab in the bottom panel', async () => {
    await openTerminalPanel(page);
    await ensureTerminalReady(page);

    const terminalTab = page.locator('.terminal-tab');
    await expect(terminalTab.first()).toBeVisible({ timeout: 5000 });
  });

  test('should allow creating multiple bottom-panel terminals', async () => {
    test.setTimeout(TEST_TIMEOUTS.VERY_LONG);

    await openTerminalPanel(page);
    await ensureTerminalReady(page);

    const terminalTabs = page.locator('.terminal-tab');
    const countBefore = await terminalTabs.count();

    await page.locator('.terminal-bottom-panel-new-tab').click();
    await page.waitForTimeout(1500);

    await expect(terminalTabs).toHaveCount(countBefore + 1, { timeout: 10000 });
  });
});

// --- Terminal Close/Reopen tests (from terminal-reopen.spec.ts) ---

test.describe('Terminal Panel - Close and Reopen', () => {
  test('terminal should function correctly after page reload with panel open', async () => {
    test.setTimeout(TEST_TIMEOUTS.VERY_LONG);

    await openTerminalPanel(page);
    const panelContainer = page.locator('.terminal-bottom-panel-container');

    await ensureTerminalReady(page);
    const terminalContainer = activeTerminalInput(page);

    const testFileBefore = path.join(workspacePath, 'reload-before.txt');
    await sendCommandToActiveTerminal(page, workspacePath, `echo BEFORE_RELOAD > "${testFileBefore}"`);
    await page.waitForTimeout(1000);

    const beforeContent = await fs.readFile(testFileBefore, 'utf8').catch(() => '');
    expect(beforeContent.trim()).toBe('BEFORE_RELOAD');

    await page.reload();
    await waitForAppReady(page);
    await page.waitForTimeout(1000);

    await expect(panelContainer).toBeVisible({ timeout: 5000 });
    await expect(terminalContainer).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const testFileAfter = path.join(workspacePath, 'reload-after.txt');
    await sendCommandToActiveTerminal(page, workspacePath, `echo AFTER_RELOAD > "${testFileAfter}"`);
    await page.waitForTimeout(1000);

    const afterContent = await fs.readFile(testFileAfter, 'utf8').catch(() => '');
    expect(afterContent.trim()).toBe('AFTER_RELOAD');
  });

  test('terminal should function correctly after page reload while panel is hidden', async () => {
    test.setTimeout(TEST_TIMEOUTS.VERY_LONG);

    await openTerminalPanel(page);
    const panelContainer = page.locator('.terminal-bottom-panel-container');

    await ensureTerminalReady(page);
    const terminalContainer = activeTerminalInput(page);

    const testFileBefore = path.join(workspacePath, 'hidden-before.txt');
    await sendCommandToActiveTerminal(page, workspacePath, `echo BEFORE_HIDDEN_RELOAD > "${testFileBefore}"`);
    await page.waitForTimeout(1000);

    const beforeContent = await fs.readFile(testFileBefore, 'utf8').catch(() => '');
    expect(beforeContent.trim()).toBe('BEFORE_HIDDEN_RELOAD');

    const closeButton = page.locator('.terminal-bottom-panel-close');
    await closeButton.click();
    await page.waitForTimeout(500);
    await expect(panelContainer).not.toBeVisible();

    await page.reload();
    await waitForAppReady(page);
    await page.waitForTimeout(1000);
    await expect(panelContainer).not.toBeVisible();

    await page.evaluate(() => window.dispatchEvent(new CustomEvent('terminal:show')));
    await page.waitForTimeout(500);

    await expect(panelContainer).toBeVisible({ timeout: 5000 });
    await expect(terminalContainer).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const testFileAfter = path.join(workspacePath, 'hidden-after.txt');
    await sendCommandToActiveTerminal(page, workspacePath, `echo AFTER_HIDDEN_RELOAD > "${testFileAfter}"`);
    await page.waitForTimeout(1000);

    const afterContent = await fs.readFile(testFileAfter, 'utf8').catch(() => '');
    expect(afterContent.trim()).toBe('AFTER_HIDDEN_RELOAD');
  });

  test('terminal should function correctly after close and reopen', async () => {
    test.setTimeout(TEST_TIMEOUTS.VERY_LONG);

    await openTerminalPanel(page);
    const panelContainer = page.locator('.terminal-bottom-panel-container');

    await ensureTerminalReady(page);
    const terminalContainer = activeTerminalInput(page);

    // Focus the terminal
    // Run a command that produces a file
    const testFileBefore = path.join(workspacePath, 'before.txt');
    await sendCommandToActiveTerminal(page, workspacePath, `echo BEFORE_CLOSE > "${testFileBefore}"`);
    await page.waitForTimeout(1000);

    // Verify the first command worked
    const beforeContent = await fs.readFile(testFileBefore, 'utf8').catch(() => '');
    expect(beforeContent.trim()).toBe('BEFORE_CLOSE');

    // Close the terminal panel via the X button
    const closeButton = page.locator('.terminal-bottom-panel-close');
    await closeButton.click();
    await page.waitForTimeout(500);

    // Verify panel is hidden
    await expect(panelContainer).not.toBeVisible();

    // Reopen the terminal panel
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('terminal:show')));
    await page.waitForTimeout(500);

    // The terminal should still exist with scrollback restored
    await expect(terminalContainer).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    // Focus the terminal again
    // Run a command after reopening
    const testFileAfter = path.join(workspacePath, 'after.txt');
    await sendCommandToActiveTerminal(page, workspacePath, `echo AFTER_REOPEN > "${testFileAfter}"`);
    await page.waitForTimeout(1000);

    // Verify the file was created (proves cursor was at prompt, not at 0,0)
    const afterContent = await fs.readFile(testFileAfter, 'utf8').catch(() => '');
    expect(afterContent.trim()).toBe('AFTER_REOPEN');
  });
});
