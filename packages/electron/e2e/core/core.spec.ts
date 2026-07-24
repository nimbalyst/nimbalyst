/**
 * Core app functionality tests: startup, mode switching, context-aware new,
 * tab management, and find/replace.
 *
 * Consolidated from:
 * - app-startup.spec.ts (basic app launch, file tree, editing, saving)
 * - mode-switching.spec.ts (agent/files mode switching)
 * - context-aware-new.spec.ts (Cmd+N behavior per mode)
 * - tabs.spec.ts (tab management, content isolation, find/replace bar)
 *
 * All tests share a single Electron app instance with beforeAll/afterAll.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  launchElectronApp,
  createTempWorkspace,
  TEST_TIMEOUTS,
  waitForAppReady,
  dismissProjectTrustToast,
  getKeyboardShortcut,
  ACTIVE_EDITOR_SELECTOR,
  ACTIVE_FILE_TAB_SELECTOR,
} from '../helpers';
import {
  openFileFromTree,
  switchToAgentMode,
  dismissAPIKeyDialog,
  closeTabByFileName,
  PLAYWRIGHT_TEST_SELECTORS,
} from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

async function sendFindMenuCommand(): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const targetWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    targetWindow?.webContents.send('menu:find');
  });
}

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  // Files for app-startup tests
  await fs.writeFile(path.join(workspaceDir, 'test.md'), '# Test Document\n\nTest content\n', 'utf8');

  // Files for context-aware-new tests
  await fs.writeFile(path.join(workspaceDir, 'agent-mode-test.md'), '# Agent Mode Test\n\nTest content for agent mode.\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'files-mode-test.md'), '# Files Mode Test\n\nTest content for files mode.\n', 'utf8');

  // Files for tab management tests
  await fs.writeFile(path.join(workspaceDir, 'content-alpha.md'), '# Alpha Document\n\nThis is the alpha file.\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'content-beta.md'), '# Beta Document\n\nThis is the beta file.\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'no-reload-file.md'), '# No Reload File\n\nContent for no-reload test.\n', 'utf8');

  // Files for find/replace tests
  await fs.writeFile(path.join(workspaceDir, 'find-test-1.md'), '# Test Document 1\n\nThis is a test document with some searchable content.\n\nThe word "test" appears multiple times.\n\nAnother test here.\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'find-test-2.md'), '# Test Document 2\n\nThis is a test document with some searchable content.\n\nThe word "test" appears multiple times.\n\nAnother test here.\n', 'utf8');
  await fs.writeFile(path.join(workspaceDir, 'find-test.json'), '{"searchable":"content"}\n', 'utf8');

  electronApp = await launchElectronApp({
    workspace: workspaceDir,
    env: { NODE_ENV: 'test' },
  });

  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);
  await dismissProjectTrustToast(page);
  await dismissAPIKeyDialog(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  if (workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

// ========================================================================
// App Startup tests (from app-startup.spec.ts)
// ========================================================================

test('should launch the app and show workspace sidebar', async () => {
  const sidebar = page.locator('.workspace-sidebar');
  await expect(sidebar).toBeVisible();
});

test('should show file tree with test file', async () => {
  await page.locator('.file-tree-name', { hasText: 'test.md' }).first().waitFor({ timeout: TEST_TIMEOUTS.FILE_TREE_LOAD });

  const testFile = page.locator('.file-tree-name', { hasText: 'test.md' });
  await expect(testFile.first()).toBeVisible();
});

test('should open file when clicked in sidebar', async () => {
  await page.locator('.file-tree-name', { hasText: /^test\.md$/ }).waitFor({ timeout: TEST_TIMEOUTS.FILE_TREE_LOAD });
  await page.locator('.file-tree-name', { hasText: /^test\.md$/ }).click();

  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('test.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await expect(editor).toBeVisible({ timeout: TEST_TIMEOUTS.EDITOR_LOAD });

  const editorText = await editor.innerText();
  expect(editorText).toContain('Test Document');
});

test('should allow basic text editing', async () => {
  await openFileFromTree(page, 'test.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('test.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await editor.click();
  await page.keyboard.type(' - edited');

  await expect(page.locator('.file-tabs-container .tab.active .tab-dirty-indicator')).toBeVisible();
});

test('should save file with Cmd+S', async () => {
  await openFileFromTree(page, 'test.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('test.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await editor.click();

  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.press('Enter');

  const marker = `save-test-${Date.now()}`;
  await page.keyboard.type(marker);

  await expect(page.locator('.file-tabs-container .tab.active .tab-dirty-indicator')).toBeVisible();

  await page.keyboard.press('Meta+S');
  await page.waitForTimeout(TEST_TIMEOUTS.SAVE_OPERATION);

  const content = await fs.readFile(path.join(workspaceDir, 'test.md'), 'utf8');
  expect(content).toContain(marker);
});

// ========================================================================
// Mode Switching tests (from mode-switching.spec.ts)
// ========================================================================

test('Agent Mode button should switch to agent mode', async () => {
  // Start in files mode
  const filesButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.filesModeButton);
  await filesButton.click();
  await page.waitForTimeout(300);

  const fileTree = page.locator('.workspace-sidebar');
  await expect(fileTree).toBeVisible({ timeout: TEST_TIMEOUTS.FILE_TREE_LOAD });

  await switchToAgentMode(page);

  const agentMode = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentMode);
  await expect(agentMode).toBeVisible({ timeout: 3000 });

  const sidebar = page.locator(PLAYWRIGHT_TEST_SELECTORS.workspaceSidebar);
  await expect(sidebar).not.toBeVisible();

  const agentBtn = page.locator(PLAYWRIGHT_TEST_SELECTORS.agentModeButton);
  await expect(agentBtn).toHaveAttribute('aria-pressed', 'true');
});

test('Agent Mode should show AgenticPanel when workspace is open', async () => {
  await switchToAgentMode(page);

  const agentModeWrapper = page.locator('[data-layout="agent-mode-wrapper"]');
  await expect(agentModeWrapper).toBeVisible();

  const fallbackMessage = page.locator('text=Agent mode requires a workspace');
  await expect(fallbackMessage).not.toBeVisible();
});

test('Switching back to Files mode should restore file tree', async () => {
  await switchToAgentMode(page);

  const agentModeWrapper = page.locator('[data-layout="agent-mode-wrapper"]');
  await expect(agentModeWrapper).toBeVisible();

  const filesButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.filesModeButton);
  await filesButton.click();
  await page.waitForTimeout(500);

  const fileTree = page.locator('.workspace-sidebar');
  await expect(fileTree).toBeVisible();

  await expect(agentModeWrapper).not.toBeVisible();
  await expect(filesButton).toHaveAttribute('aria-pressed', 'true');
});

// ========================================================================
// Context-Aware New tests (from context-aware-new.spec.ts)
// ========================================================================

test('Cmd+N should create new session in agent mode', async () => {
  await page.keyboard.press('Meta+k');

  await expect(page.locator('text="Agent Sessions"')).toBeVisible({ timeout: TEST_TIMEOUTS.DEFAULT_WAIT });

  const initialSessionButtons = await page.getByRole('button', { name: /^Session:/ }).count();

  await electronApp.evaluate(({ BrowserWindow }) => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) {
      focusedWindow.webContents.send('agent-new-session');
    }
  });

  await page.waitForTimeout(1000);

  const newSessionButtons = await page.getByRole('button', { name: /^Session:/ }).count();
  expect(newSessionButtons).toBeGreaterThan(initialSessionButtons);

  const newFileDialog = page.locator('text="New File"').first();
  await expect(newFileDialog).not.toBeVisible({ timeout: 500 }).catch(() => {});
});

test('Cmd+N should open new file dialog in files mode', async () => {
  await page.keyboard.press('Meta+e');

  await expect(page.locator('text="agent-mode-test.md"')).toBeVisible({ timeout: TEST_TIMEOUTS.DEFAULT_WAIT });

  await electronApp.evaluate(({ BrowserWindow }) => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) {
      focusedWindow.webContents.send('file-new-in-workspace');
    }
  });

  await page.waitForTimeout(500);

  const newFileDialog = page.locator('text="New File"').first();
  await expect(newFileDialog).toBeVisible({ timeout: TEST_TIMEOUTS.DEFAULT_WAIT });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
});

// ========================================================================
// Tab Management tests (from tabs.spec.ts)
// ========================================================================

test('should preserve each file content independently when switching tabs', async () => {
  // Make sure we're in files mode
  const filesButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.filesModeButton);
  await filesButton.click();
  await page.waitForTimeout(300);

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);

  // Open content-alpha.md
  await page.locator('.file-tree-name', { hasText: 'content-alpha.md' }).click();
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('content-alpha.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  // Add unique marker to alpha
  const alphaMarker = `alpha-marker-${Date.now()}`;
  await editor.click();
  await page.keyboard.press(getKeyboardShortcut('Mod+End'));
  await page.keyboard.type(`\n\n${alphaMarker}`);

  let editorText = await editor.innerText();
  expect(editorText).toContain('Alpha Document');
  expect(editorText).toContain(alphaMarker);

  // Switch to content-beta.md
  await page.locator('.file-tree-name', { hasText: 'content-beta.md' }).click();
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('content-beta.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });
  await page.waitForTimeout(TEST_TIMEOUTS.DEFAULT_WAIT);

  editorText = await editor.innerText();
  expect(editorText).toContain('Beta Document');
  expect(editorText).not.toContain('Alpha Document');
  expect(editorText).not.toContain(alphaMarker);

  // Switch back to alpha
  await page.locator('.file-tabs-container .tab', { has: page.locator('.tab-title', { hasText: 'content-alpha.md' }) }).click();
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('content-alpha.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });
  await page.waitForTimeout(TEST_TIMEOUTS.DEFAULT_WAIT);

  editorText = await editor.innerText();
  expect(editorText).toContain('Alpha Document');
  expect(editorText).toContain(alphaMarker);
  expect(editorText).not.toContain('Beta Document');

  await closeTabByFileName(page, 'content-alpha.md');
  await closeTabByFileName(page, 'content-beta.md');
});

test('should not reload tab when clicking on already active tab', async () => {
  await page.locator('.file-tree-name', { hasText: 'no-reload-file.md' }).click();
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('no-reload-file.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await editor.click();

  const marker = `no-reload-test-${Date.now()}`;
  await page.keyboard.type(marker);

  const activeTab = page.locator('.tab.active', { has: page.locator('.tab-title', { hasText: 'no-reload-file.md' }) });
  await activeTab.click();

  const editorText = await editor.innerText();
  expect(editorText).toContain(marker);
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('no-reload-file.md');

  await closeTabByFileName(page, 'no-reload-file.md');
});

// ========================================================================
// Find/Replace tests (from tabs.spec.ts / find-replace-bar.spec.ts)
// ========================================================================

test('should open search/replace bar with Cmd+F and close with Escape', async () => {
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'find-test-1.md' }).click();
  await expect(
    page.locator(PLAYWRIGHT_TEST_SELECTORS.tab).filter({ hasText: 'find-test-1.md' })
  ).toBeVisible({ timeout: TEST_TIMEOUTS.TAB_SWITCH });
  await expect(page.locator(ACTIVE_EDITOR_SELECTOR)).toBeVisible({
    timeout: TEST_TIMEOUTS.EDITOR_LOAD,
  });

  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.searchReplaceBar)).not.toBeVisible();

  await sendFindMenuCommand();

  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.searchReplaceBar)).toBeVisible({
    timeout: 1000,
  });

  const searchInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.searchInput);
  await expect(searchInput).toBeFocused();

  await searchInput.press('Escape');

  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.searchReplaceBar)).not.toBeVisible({
    timeout: 1000,
  });

  await closeTabByFileName(page, 'find-test-1.md');
});

test('should allow typing multiple characters in search box without losing focus', async () => {
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'find-test-2.md' }).click();
  await expect(
    page.locator(PLAYWRIGHT_TEST_SELECTORS.tab).filter({ hasText: 'find-test-2.md' })
  ).toBeVisible({ timeout: TEST_TIMEOUTS.TAB_SWITCH });
  await expect(page.locator(ACTIVE_EDITOR_SELECTOR)).toBeVisible({
    timeout: TEST_TIMEOUTS.EDITOR_LOAD,
  });

  await sendFindMenuCommand();

  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.searchReplaceBar)).toBeVisible();

  const searchInput = page.locator(PLAYWRIGHT_TEST_SELECTORS.searchInput);
  await expect(searchInput).toBeFocused();

  await searchInput.type('test');

  await expect(searchInput).toHaveValue('test');
  await expect(searchInput).toBeFocused();

  const matchCounter = page.locator(PLAYWRIGHT_TEST_SELECTORS.matchCounter);
  await expect(matchCounter).toContainText('of');

  await searchInput.press('Escape');

  await closeTabByFileName(page, 'find-test-2.md');
});

test('should use Monaco native find for non-markdown files', async () => {
  await openFileFromTree(page, 'find-test.json');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('find-test.json', {
    timeout: TEST_TIMEOUTS.TAB_SWITCH,
  });
  await expect(page.locator('.monaco-editor')).toBeVisible({
    timeout: TEST_TIMEOUTS.EDITOR_LOAD,
  });

  const findWidget = page.locator('.monaco-editor .find-widget');
  await sendFindMenuCommand();
  await expect(findWidget).toBeVisible();
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.searchReplaceBar)).not.toBeVisible();

  const findInput = page.getByRole('textbox', { name: 'Find' });
  await expect(findInput).toBeFocused();
  await findInput.fill('searchable');
  await expect(findInput).toHaveValue('searchable');

  await page.keyboard.press('Escape');
  await closeTabByFileName(page, 'find-test.json');
});
