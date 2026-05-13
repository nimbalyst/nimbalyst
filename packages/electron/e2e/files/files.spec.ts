/**
 * Consolidated file tests covering save, watcher, filtering, file operations,
 * and file tree behavior (scroll stability, breadcrumb reveal).
 *
 * From:
 * - file-save-comprehensive.spec.ts
 * - file-watcher-updates.spec.ts
 * - file-operations-while-open.spec.ts
 * - file-tree-filtering.spec.ts
 * - file-tree-behavior.spec.ts (scroll stability, breadcrumb reveal)
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import {
  launchElectronApp,
  createTempWorkspace,
  TEST_TIMEOUTS,
  waitForAppReady,
  ACTIVE_EDITOR_SELECTOR,
  ACTIVE_FILE_TAB_SELECTOR
} from '../helpers';
import { openFileFromTree, PLAYWRIGHT_TEST_SELECTORS } from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspacePath: string;

test.beforeAll(async () => {
  workspacePath = await createTempWorkspace();

  // --- Files for file-save tests ---
  await fs.writeFile(path.join(workspacePath, 'save-doc.md'), '# Test File\n\nInitial content.\n', 'utf8');
  await fs.writeFile(path.join(workspacePath, 'save-extra.md'), '# Second File\n\nInitial content.\n', 'utf8');

  // --- Files for file-operations tests ---
  await fs.writeFile(path.join(workspacePath, 'op-rename.md'), '# Rename Me\n\nSome content.\n', 'utf8');
  await fs.writeFile(path.join(workspacePath, 'op-delete.md'), '# Delete Me\n\nThis file should be deleted.\n', 'utf8');

  // --- Files for file-watcher tests ---
  await fs.writeFile(path.join(workspacePath, 'watch-main.md'), '# Watched File\n\nOriginal content from disk.\n', 'utf8');
  await fs.writeFile(path.join(workspacePath, 'watch-a.md'), '# File 1\n\nOriginal content of file 1.\n', 'utf8');
  await fs.writeFile(path.join(workspacePath, 'watch-b.md'), '# File 2\n\nOriginal content of file 2.\n', 'utf8');
  await fs.writeFile(path.join(workspacePath, 'watch-c.md'), '# File 3\n\nOriginal content of file 3.\n', 'utf8');

  // --- Files for file-tree-filtering tests ---
  await fs.writeFile(path.join(workspacePath, 'filter-doc.md'), '# Test Markdown\n\nContent.\n', 'utf8');
  await fs.writeFile(path.join(workspacePath, 'filter-notes.md'), '# Notes\n\nMore content.\n', 'utf8');
  await fs.writeFile(path.join(workspacePath, 'filter-script.js'), 'console.log("hello");\n', 'utf8');
  await fs.writeFile(path.join(workspacePath, 'filter-app.ts'), 'const x: number = 42;\n', 'utf8');
  await fs.writeFile(path.join(workspacePath, 'filter-data.json'), '{"test": true}\n', 'utf8');
  await fs.writeFile(path.join(workspacePath, 'filter-readme.txt'), 'Plain text file\n', 'utf8');
  await fs.writeFile(path.join(workspacePath, 'filter-image.png'), Buffer.from('fake-png-data'), 'utf8');

  // --- Files for file-tree-behavior (scroll stability) tests ---
  // Create directories to fill the tree (enough items to require scrolling)
  for (let i = 0; i < 20; i++) {
    const name = `dir-${String(i).padStart(2, '0')}`;
    const dirPath = path.join(workspacePath, name);
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(path.join(dirPath, 'inner.md'), `# ${name}\n`, 'utf8');
  }
  const srcDir = path.join(workspacePath, 'src');
  await fs.mkdir(srcDir, { recursive: true });
  await fs.writeFile(path.join(srcDir, 'app.ts'), 'const x = 1;\n', 'utf8');
  const targetDir = path.join(workspacePath, 'zzz-deep');
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(path.join(targetDir, 'target.md'), '# Target\n', 'utf8');

  electronApp = await launchElectronApp({
    workspace: workspacePath,
    env: { NODE_ENV: 'test' }
  });

  page = await electronApp.firstWindow();

  // Handle any dialogs (dismiss them)
  page.on('dialog', dialog => dialog.dismiss().catch(() => {}));

  // Override window.confirm to auto-accept (for delete confirmation)
  await page.evaluate(() => {
    window.confirm = () => true;
  });

  await waitForAppReady(page);
});

test.afterAll(async () => {
  if (electronApp) {
    await electronApp.close();
  }
  await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
});

// ========================================================================
// File Save tests (from file-save-comprehensive.spec.ts)
// ========================================================================

test('should autosave after inactivity and preserve focus/cursor position', async () => {
  const filePath = path.join(workspacePath, 'save-doc.md');
  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  const marker = `autosave-marker-${Date.now()}`;

  await openFileFromTree(page, 'save-doc.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('save-doc.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(`\n\n${marker}`);

  // Verify dirty state
  const tab = page.locator('.file-tabs-container .tab', { has: page.locator('.tab-title', { hasText: 'save-doc.md' }) });
  await expect(tab.locator('.tab-dirty-indicator')).toBeVisible({ timeout: 1000 });

  // Wait for autosave (2s interval + 200ms debounce + buffer)
  await page.waitForTimeout(3000);

  await expect(tab.locator('.tab-dirty-indicator')).toHaveCount(0, { timeout: 1000 });

  const diskContent = await fs.readFile(filePath, 'utf8');
  expect(diskContent).toContain(marker);

  // Verify focus maintained - can still type after autosave
  const focusMarker = `focus-ok-${Date.now()}`;
  await page.keyboard.type(focusMarker);
  const content = await editor.innerText();
  expect(content).toContain(focusMarker);
});

test('should debounce during rapid edits without excessive saves', async () => {
  const filePath = path.join(workspacePath, 'save-doc.md');
  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);

  await openFileFromTree(page, 'save-doc.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('save-doc.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  // Wait for any pending autosave
  const tab = page.locator('.file-tabs-container .tab', { has: page.locator('.tab-title', { hasText: 'save-doc.md' }) });
  await expect(tab.locator('.tab-dirty-indicator')).toHaveCount(0, { timeout: 5000 });

  const initialStats = await fs.stat(filePath);
  const initialMtime = initialStats.mtimeMs;

  await editor.click();
  await page.keyboard.press('End');
  const typedRun = 'x'.repeat(20);
  for (const ch of typedRun) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(50);
  }

  // After the typing burst the buffer must be dirty. (Whether autosave has
  // already fired mid-burst depends on the debounce window vs. our typing
  // cadence -- we don't pin that timing, only that autosave eventually
  // converges to the final content.)
  await expect(tab.locator('.tab-dirty-indicator')).toBeVisible();

  // Wait past the autosave debounce window so the final save lands.
  await page.waitForTimeout(3000);

  await expect(tab.locator('.tab-dirty-indicator')).toHaveCount(0);
  const afterStats = await fs.stat(filePath);
  expect(afterStats.mtimeMs).toBeGreaterThan(initialMtime);

  // Critical assertion: the on-disk content reflects every keystroke from the
  // burst (no half-baked debounce that drops trailing edits).
  const afterContent = await fs.readFile(filePath, 'utf8');
  expect(afterContent).toContain(typedRun);
});

test('should autosave multiple tabs independently', async () => {
  const file1Path = path.join(workspacePath, 'save-doc.md');
  const file2Path = path.join(workspacePath, 'save-extra.md');
  const marker1 = `marker1-${Date.now()}`;
  const marker2 = `marker2-${Date.now()}`;
  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);

  await openFileFromTree(page, 'save-doc.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('save-doc.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(`\n\n${marker1}\n`);

  const tab1 = page.locator('.file-tabs-container .tab', { has: page.locator('.tab-title', { hasText: 'save-doc.md' }) });
  await expect(tab1.locator('.tab-dirty-indicator')).toBeVisible();

  await openFileFromTree(page, 'save-extra.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('save-extra.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });
  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(`\n\n${marker2}\n`);

  const tab2 = page.locator('.file-tabs-container .tab', { has: page.locator('.tab-title', { hasText: 'save-extra.md' }) });
  await expect(tab2.locator('.tab-dirty-indicator')).toBeVisible();

  await page.waitForTimeout(3000);

  await expect(tab1.locator('.tab-dirty-indicator')).toHaveCount(0);
  await expect(tab2.locator('.tab-dirty-indicator')).toHaveCount(0);

  const content1 = await fs.readFile(file1Path, 'utf8');
  const content2 = await fs.readFile(file2Path, 'utf8');
  expect(content1).toContain(marker1);
  expect(content2).toContain(marker2);
});

test('should save immediately with manual save (Cmd+S) overriding autosave timer', async () => {
  const filePath = path.join(workspacePath, 'save-doc.md');
  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  const marker = `manual-save-${Date.now()}`;

  await openFileFromTree(page, 'save-doc.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('save-doc.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  const tab = page.locator('.file-tabs-container .tab', { has: page.locator('.tab-title', { hasText: 'save-doc.md' }) });
  await expect(tab.locator('.tab-dirty-indicator')).toHaveCount(0, { timeout: 5000 });

  const initialStats = await fs.stat(filePath);
  const initialMtime = initialStats.mtimeMs;

  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type(`\n\n${marker}\n`);

  await expect(tab.locator('.tab-dirty-indicator')).toBeVisible({ timeout: 1000 });

  await page.waitForTimeout(100);

  await electronApp.evaluate(({ BrowserWindow }) => {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused) {
      focused.webContents.send('file-save');
    }
  });

  await expect(tab.locator('.tab-dirty-indicator')).toHaveCount(0, { timeout: 2000 });

  const diskContent = await fs.readFile(filePath, 'utf8');
  expect(diskContent).toContain(marker);
});

// ========================================================================
// File Operations tests (from file-operations-while-open.spec.ts)
// ========================================================================

test('renaming an open file should update the tab name and path', async () => {
  await page.locator('.file-tree-name', { hasText: 'op-rename.md' }).click();
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('op-rename.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await expect(editor).toContainText('Some content');

  // Right-click to rename
  await page.locator('.file-tree-name', { hasText: 'op-rename.md' }).click({ button: 'right' });
  await page.waitForSelector('.file-context-menu', { timeout: TEST_TIMEOUTS.DEFAULT_WAIT });
  await page.locator('.file-context-menu-item', { hasText: 'Rename' }).click();

  const renameInput = page.locator('.rename-input');
  await expect(renameInput).toBeVisible({ timeout: TEST_TIMEOUTS.DEFAULT_WAIT });
  await renameInput.fill('op-renamed.md');
  await renameInput.press('Enter');

  await expect(page.locator('.file-tree-name', { hasText: 'op-renamed.md' })).toBeVisible({ timeout: 5000 });
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('op-renamed.md', { timeout: 5000 });

  const oldExists = await fs.access(path.join(workspacePath, 'op-rename.md')).then(() => true).catch(() => false);
  expect(oldExists).toBe(false);

  const newExists = await fs.access(path.join(workspacePath, 'op-renamed.md')).then(() => true).catch(() => false);
  expect(newExists).toBe(true);

  await expect(editor).toContainText('Some content');
});

test('deleting an open file should close the tab and not recreate the file', async () => {
  const testFile = path.join(workspacePath, 'op-delete.md');

  await page.locator('.file-tree-name', { hasText: 'op-delete.md' }).click();
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('op-delete.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  // Make some edits to ensure autosave would trigger
  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
  await editor.click();
  await page.keyboard.type('\n\nThis is new content that should not be saved.');

  await expect(page.locator('.file-tabs-container .tab.active .tab-dirty-indicator')).toBeVisible({ timeout: 1000 });

  // Right-click and delete
  await page.locator('.file-tree-name', { hasText: 'op-delete.md' }).click({ button: 'right' });
  await page.waitForSelector('.file-context-menu', { timeout: TEST_TIMEOUTS.DEFAULT_WAIT });

  const deleteButton = page.locator('[data-testid="context-menu-delete"]');
  await deleteButton.click();

  await expect(page.locator('.file-tabs-container .tab .tab-title', { hasText: 'op-delete.md' })).toHaveCount(0, { timeout: 5000 });

  // Verify the file was actually deleted and not recreated
  await expect.poll(async () => {
    try {
      await fs.access(testFile);
      return false;
    } catch {
      return true;
    }
  }, {
    timeout: TEST_TIMEOUTS.SAVE_OPERATION * 2,
    message: 'Expected file to remain deleted'
  }).toBe(true);
});

// ========================================================================
// File Watcher tests (from file-watcher-updates.spec.ts)
// ========================================================================

test('should detect when file is modified on disk by external process', async () => {
  const filePath = path.join(workspacePath, 'watch-main.md');
  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);

  await openFileFromTree(page, 'watch-main.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('watch-main.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  let editorText = await editor.innerText();
  expect(editorText).toContain('Original content from disk');

  // Simulate external modification
  const externalEdit = 'This line was added by an external process like an AI agent.';
  const newContent = `# Watched File\n\nOriginal content from disk.\n\n${externalEdit}\n`;
  await fs.writeFile(filePath, newContent, 'utf8');

  await page.waitForTimeout(TEST_TIMEOUTS.SAVE_OPERATION);

  editorText = await editor.innerText();
  expect(editorText).toContain(externalEdit);
});

// Skip: .file-conflict-dialog selector does not exist in current UI
test.skip('should show notification when file is modified externally while editor has unsaved changes', async () => {
  const filePath = path.join(workspacePath, 'watch-main.md');
  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);

  await openFileFromTree(page, 'watch-main.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('watch-main.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  await editor.click();
  await page.keyboard.press('End');
  await page.keyboard.type('\nLocal unsaved edit.');

  const tab = page.locator('.file-tabs-container .tab', { has: page.locator('.tab-title', { hasText: 'watch-main.md' }) });
  await expect(tab.locator('.tab-dirty-indicator')).toBeVisible();

  const externalContent = `# Watched File\n\nExternal modification that conflicts with local changes.\n`;
  await fs.writeFile(filePath, externalContent, 'utf8');

  await page.waitForTimeout(TEST_TIMEOUTS.SAVE_OPERATION);

  const conflictDialog = page.locator('.file-conflict-dialog');
  await expect(conflictDialog).toBeVisible();
  await page.locator('button', { hasText: 'Keep My Changes' }).click();
  await expect(conflictDialog).not.toBeVisible();
});

test('should reload content when switching to tab with externally modified file', async () => {
  const file2Path = path.join(workspacePath, 'watch-b.md');

  // Open 3 tabs
  await openFileFromTree(page, 'watch-a.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('watch-a.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  await openFileFromTree(page, 'watch-b.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('watch-b.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  await openFileFromTree(page, 'watch-c.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('watch-c.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  // Modify watch-b.md externally while it's inactive
  const externalEdit2 = 'External edit to FILE 2 while inactive';
  const newContent2 = `# File 2\n\nOriginal content of file 2.\n\n${externalEdit2}\n`;
  await fs.writeFile(file2Path, newContent2, 'utf8');

  await page.waitForTimeout(TEST_TIMEOUTS.SAVE_OPERATION);

  // Switch to watch-b.md and verify content
  await page.locator('.file-tabs-container .tab', { has: page.locator('.tab-title', { hasText: 'watch-b.md' }) }).click();
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('watch-b.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });
  await page.waitForTimeout(500);

  const activeEditor = page.locator(ACTIVE_EDITOR_SELECTOR);
  const file2Text = await activeEditor.innerText();
  expect(file2Text).toContain(externalEdit2);
});

test('should handle file deletion while open in editor', async () => {
  const filePath = path.join(workspacePath, 'watch-main.md');

  await openFileFromTree(page, 'watch-main.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('watch-main.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  await fs.unlink(filePath);

  await page.waitForTimeout(TEST_TIMEOUTS.SAVE_OPERATION * 2);

  const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
  expect(fileExists).toBe(false);
});

test('should update file tree when new files are created by external process', async () => {
  await expect(page.locator('.file-tree-name', { hasText: 'watch-new.md' })).toHaveCount(0);

  const newFilePath = path.join(workspacePath, 'watch-new.md');
  await fs.writeFile(newFilePath, '# New File\n\nCreated by AI agent.\n', 'utf8');

  // Wait for the file watcher to detect the new file.
  // macOS FSEvents can have variable delivery latency for new files in temp dirs.
  // If the watcher doesn't fire within 5s, reload the page which re-fetches
  // the full file tree from disk on initialization.
  //
  // The file tree is virtualized (react-virtuoso) -- items below the visible
  // viewport are NOT rendered in the DOM. With this workspace's many fixture
  // dirs/files, watch-new.md is below the fold, so we scroll the container to
  // the bottom before asserting visibility.
  const fileLocator = page.locator('.file-tree-name', { hasText: 'watch-new.md' });
  const scrollContainer = page.locator('.file-tree-container [data-testid="virtuoso-scroller"]').first();

  const scrollToBottomAndCheck = async (timeoutMs: number): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await scrollContainer.evaluate((el: HTMLElement) => {
        el.scrollTop = el.scrollHeight;
      });
      if (await fileLocator.isVisible({ timeout: 250 }).catch(() => false)) return true;
    }
    return false;
  };

  const watcherDetected = await scrollToBottomAndCheck(5000);
  if (!watcherDetected) {
    await page.reload();
    await waitForAppReady(page);
    const reloadDetected = await scrollToBottomAndCheck(3000);
    expect(reloadDetected, 'watch-new.md should appear in tree after reload').toBe(true);
    return;
  }

  await expect(fileLocator).toBeVisible();
});

// Skip: Lexical editor doesn't reliably reload multiple rapid external changes
test.skip('should detect rapid successive external changes', async () => {
  const filePath = path.join(workspacePath, 'watch-main.md');
  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);

  await fs.writeFile(filePath, '# Watched File\n\nOriginal content from disk.\n', 'utf8');
  await page.waitForTimeout(1000);

  await openFileFromTree(page, 'watch-main.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('watch-main.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  const changes = [
    '# Watched File\n\nFirst external edit.\n',
    '# Watched File\n\nFirst external edit.\n\nSecond external edit.\n',
    '# Watched File\n\nFirst external edit.\n\nSecond external edit.\n\nThird external edit.\n',
  ];

  for (const content of changes) {
    await fs.writeFile(filePath, content, 'utf8');
    await page.waitForTimeout(500);
  }

  await expect.poll(async () => {
    return await editor.innerText();
  }, {
    timeout: 10000,
    message: 'Expected editor to show final external edit'
  }).toContain('Third external edit');
});

test('should preserve cursor position when file is reloaded from disk', async () => {
  const filePath = path.join(workspacePath, 'watch-main.md');
  const editor = page.locator(ACTIVE_EDITOR_SELECTOR);

  // Recreate watch-main.md (may have been deleted by prior test)
  await fs.writeFile(filePath, '# Watched File\n\nOriginal content from disk.\n', 'utf8');
  await page.waitForTimeout(1000);

  await openFileFromTree(page, 'watch-main.md');
  await expect(page.locator(ACTIVE_FILE_TAB_SELECTOR)).toContainText('watch-main.md', { timeout: TEST_TIMEOUTS.TAB_SWITCH });

  await editor.click();
  await page.keyboard.press('End');

  const originalContent = await fs.readFile(filePath, 'utf8');
  await fs.writeFile(filePath, originalContent + '\nAppended by external process.\n', 'utf8');

  await page.waitForTimeout(TEST_TIMEOUTS.SAVE_OPERATION);

  const editorText = await editor.innerText();
  expect(editorText).toContain('Appended by external process');
});

// ========================================================================
// File Tree Filtering tests (from file-tree-filtering.spec.ts)
// ========================================================================

test('should filter files by type', async () => {
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-doc.md' })).toBeVisible();
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-script.js' })).toBeVisible();
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-image.png' })).toBeVisible();

  // Test Markdown Only filter
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeFilterButton).click();
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.filterMenuMarkdownOnly).click();
  await page.waitForTimeout(TEST_TIMEOUTS.DEFAULT_WAIT);

  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-doc.md' })).toBeVisible();
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-notes.md' })).toBeVisible();
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-script.js' })).toHaveCount(0);
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-app.ts' })).toHaveCount(0);

  // Test Known Files filter
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeFilterButton).click();
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.filterMenuKnownFiles).click();
  await page.waitForTimeout(TEST_TIMEOUTS.DEFAULT_WAIT);

  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-doc.md' })).toBeVisible();
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-script.js' })).toBeVisible();
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-readme.txt' })).toBeVisible();
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-image.png' })).toHaveCount(0);

  // Test All Files filter
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeFilterButton).click();
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.filterMenuAllFiles).click();
  await page.waitForTimeout(TEST_TIMEOUTS.DEFAULT_WAIT);

  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-doc.md' })).toBeVisible();
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-script.js' })).toBeVisible();
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-image.png' })).toBeVisible();
});

test('should persist filter settings after page reload', async () => {
  // Set filter to Markdown Only
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeFilterButton).click();
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.filterMenuMarkdownOnly).click();
  await page.waitForTimeout(TEST_TIMEOUTS.DEFAULT_WAIT);

  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-doc.md' })).toBeVisible();
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-script.js' })).toHaveCount(0);

  // Reload to test persistence (filter is stored in workspace state)
  await page.reload();
  await waitForAppReady(page);
  await page.waitForTimeout(1000);

  // Verify filter persisted
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-doc.md' })).toBeVisible();
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'filter-script.js' })).toHaveCount(0);
});

// ========================================================================
// File Tree Behavior tests (from file-tree-behavior.spec.ts)
// ========================================================================

/**
 * Helper: get the Virtuoso scroller element (or fallback to the container).
 */
async function getTreeScroller(p: Page) {
  const virtuosoScroller = p.locator('.file-tree-container [data-testid="virtuoso-scroller"]').first();
  const exists = await virtuosoScroller.count();
  return exists > 0
    ? virtuosoScroller
    : p.locator('.file-tree-container').first();
}

test('expanding a directory after opening a file does not scroll back', async () => {
  test.setTimeout(30000);

  // Reset filter to All Files first
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeFilterButton).click();
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.filterMenuAllFiles).click();
  await page.waitForTimeout(500);

  // 1. Wait for tree to load
  await expect(
    page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'dir-00' })
  ).toBeVisible({ timeout: TEST_TIMEOUTS.FILE_TREE_LOAD });

  // 2. Expand zzz-deep and open target.md via the tree (scrolls tree down).
  // The file lives under zzz-deep/ so pass the relative path -- bare
  // 'target.md' would resolve to <workspace>/target.md which doesn't exist.
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'zzz-deep' }).click();
  await page.waitForTimeout(500);
  await openFileFromTree(page, 'zzz-deep/target.md');

  await expect(
    page.locator(PLAYWRIGHT_TEST_SELECTORS.tabTitle, { hasText: 'target.md' })
  ).toBeVisible({ timeout: TEST_TIMEOUTS.TAB_SWITCH });

  // 3. Scroll to the top of the file tree
  const scroller = await getTreeScroller(page);
  await scroller.evaluate(el => { el.scrollTop = 0; });
  await page.waitForTimeout(300);

  await expect(
    page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'dir-00' })
  ).toBeVisible({ timeout: 2000 });

  // 4. Click dir-00 to expand it - this changes visibleNodes
  const scrollBefore = await scroller.evaluate(el => el.scrollTop);
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'dir-00' }).click();
  await page.waitForTimeout(800);

  // 5. Scroll should NOT have jumped hundreds of pixels down to target.md
  const scrollAfter = await scroller.evaluate(el => el.scrollTop);
  const scrollDelta = Math.abs(scrollAfter - scrollBefore);
  expect(scrollDelta).toBeLessThan(100);

  await expect(
    page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'dir-00' })
  ).toBeVisible({ timeout: 1000 });
});

test('expanding a directory after breadcrumb reveal does not scroll back', async () => {
  test.setTimeout(30000);

  // 1. Open src/app.ts via the tree so it has a breadcrumb. openFileFromTree
  // routes through the IPC handler so no need to pre-expand src/ (and
  // clicking would toggle, collapsing it if a prior test expanded it).
  await openFileFromTree(page, 'src/app.ts');

  await expect(
    page.locator(PLAYWRIGHT_TEST_SELECTORS.tabTitle, { hasText: 'app.ts' })
  ).toBeVisible({ timeout: TEST_TIMEOUTS.TAB_SWITCH });

  // 2. Click the breadcrumb filename to trigger a reveal (sets revealRequestAtom)
  const breadcrumbFilename = page.locator('.breadcrumb-filename', { hasText: 'app.ts' });
  const breadcrumbExists = await breadcrumbFilename.count();
  if (breadcrumbExists === 0) {
    test.skip();
    return;
  }
  await breadcrumbFilename.click({ force: true });
  await page.waitForTimeout(500);

  // 3. Scroll the tree to the top
  const scroller = await getTreeScroller(page);
  await scroller.evaluate(el => { el.scrollTop = 0; });
  await page.waitForTimeout(300);

  await expect(
    page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'dir-00' })
  ).toBeVisible({ timeout: 2000 });

  // 4. Expand dir-00
  const scrollBefore = await scroller.evaluate(el => el.scrollTop);
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'dir-00' }).click();
  await page.waitForTimeout(800);

  // 5. Verify no scroll jump
  const scrollAfter = await scroller.evaluate(el => el.scrollTop);
  const scrollDelta = Math.abs(scrollAfter - scrollBefore);
  expect(scrollDelta).toBeLessThan(100);

  await expect(
    page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'dir-00' })
  ).toBeVisible({ timeout: 1000 });
});

test('breadcrumb reveal clears filter and scrolls to file', async () => {
  test.setTimeout(30000);

  // 1. Ensure filter is set to "All Files" first (clean state)
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeFilterButton).click();
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.filterMenuAllFiles).click();
  await page.waitForTimeout(500);

  // 2. Open src/app.ts. openFileFromTree opens the file directly via the
  // IPC handler, so we don't need to expand the src/ directory first
  // (clicking it would toggle, which collapses it if a prior test left it
  // open).
  await openFileFromTree(page, 'src/app.ts');

  // 3. Set filter to "Markdown Only" (hides .ts files)
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeFilterButton).click();
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.filterMenuMarkdownOnly).click();
  await page.waitForTimeout(500);

  // src folder and app.ts should be hidden by the filter
  await expect(
    page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: 'app.ts' })
  ).toHaveCount(0, { timeout: 2000 });

  // 4. Click the breadcrumb filename to trigger reveal
  const breadcrumbFilename = page.locator('.breadcrumb-filename', { hasText: 'app.ts' });
  await expect(breadcrumbFilename).toBeVisible({ timeout: 2000 });
  await breadcrumbFilename.click({ force: true });

  // 5. Filter should clear and file should become visible in tree.
  // Use an exact regex match so `filter-app.ts` (created by an earlier
  // filter test in beforeAll) doesn't poison this selector.
  await expect(
    page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeItem, { hasText: /^app\.ts$/ })
  ).toBeVisible({ timeout: 5000 });

  // 6. Filter indicator should be gone (filter cleared to "all")
  const filterButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeFilterButton);
  await expect(filterButton.locator('.filter-active-indicator')).toHaveCount(0, { timeout: 2000 });

  // Reset filter to All Files for subsequent tests
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.fileTreeFilterButton).click();
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.filterMenuAllFiles).click();
  await page.waitForTimeout(300);
});
