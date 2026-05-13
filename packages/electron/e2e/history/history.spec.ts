/**
 * History E2E Tests (Consolidated)
 *
 * Tests for document history functionality including:
 * - Manual and auto save entries appearing in history
 * - Restoring from auto save entries
 * - Restoring from manual save entries
 * - Simple manual save entry verification
 * - Restore from manual snapshots
 * - Restored content appears immediately without refresh
 *
 * Consolidated from:
 * - history-manual-auto-save.spec.ts (3 tests)
 * - history-manual-auto-simple.spec.ts (1 test)
 * - history-restore.spec.ts (2 tests)
 *
 * All tests share a single app instance for performance.
 */
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  dismissProjectTrustToast,
  TEST_TIMEOUTS,
  ACTIVE_EDITOR_SELECTOR
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  dismissAPIKeyDialog,
  openFileFromTree,
  closeTabByFileName,
  editDocumentContent,
  manualSaveDocument,
  waitForAutosave,
  openHistoryDialog,
  getHistoryItemCount,
  selectHistoryItem,
  restoreFromHistory
} from '../utils/testHelpers';
import * as path from 'path';
import * as fs from 'fs/promises';

// Use serial mode to ensure tests run in order with shared app instance
test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

test.describe('History', () => {
  test.beforeAll(async () => {
    workspaceDir = await createTempWorkspace();

    // Create test files for all scenarios
    // hist-auto-* files for manual/auto save tests
    await fs.writeFile(
      path.join(workspaceDir, 'hist-auto-1.md'),
      '# History Test 1\n\nInitial content.\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(workspaceDir, 'hist-auto-2.md'),
      '# History Test 2\n\nInitial content.\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(workspaceDir, 'hist-auto-3.md'),
      '# History Test 3\n\nInitial content.\n',
      'utf8'
    );
    // hist-simple for simple manual save test
    await fs.writeFile(
      path.join(workspaceDir, 'hist-simple.md'),
      '# Test\n\nInitial.\n',
      'utf8'
    );
    // hist-restore for restore test
    await fs.writeFile(
      path.join(workspaceDir, 'hist-restore.md'),
      '# Original Content\n\nThis is the original content of the document.\n',
      'utf8'
    );
    // hist-immediate for immediate restore test
    await fs.writeFile(
      path.join(workspaceDir, 'hist-immediate.md'),
      '# Original\n\nOriginal text.\n',
      'utf8'
    );

    electronApp = await launchElectronApp({
      workspace: workspaceDir,
      env: { NODE_ENV: 'test' }
    });

    page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await waitForAppReady(page);
    await dismissProjectTrustToast(page);
    await dismissAPIKeyDialog(page);
  });

  test.afterAll(async () => {
    await electronApp?.close();
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  });

  // --- Tests from history-manual-auto-save.spec.ts ---

  test('should show both manual and auto save entries in history', async () => {
    const testFile = path.join(workspaceDir, 'hist-auto-1.md');

    await openFileFromTree(page, 'hist-auto-1.md');

    const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
    await editor.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.EDITOR_LOAD });

    let editorText = await editor.innerText();
    expect(editorText).toContain('Initial content');

    // MANUAL SAVE: Make edit and manually save
    await editDocumentContent(page, editor, '# History Test 1\n\nManual save content.\n');
    await manualSaveDocument(page);

    const manualSaveContent = await fs.readFile(testFile, 'utf8');
    expect(manualSaveContent).toContain('Manual save content');

    // AUTO SAVE: Make edit and let it autosave
    await editDocumentContent(page, editor, '# History Test 1\n\nAuto save content.\n');
    await waitForAutosave(page, 'hist-auto-1.md');

    const autoSaveContent = await fs.readFile(testFile, 'utf8');
    expect(autoSaveContent).toContain('Auto save content');

    // Open history dialog
    await openHistoryDialog(page);

    const itemCount = await getHistoryItemCount(page);
    expect(itemCount).toBeGreaterThanOrEqual(2);

    // Close history dialog and tab
    await page.keyboard.press('Escape');
    await closeTabByFileName(page, 'hist-auto-1.md');
  });

  test('should restore from auto save entry', async () => {
    await openFileFromTree(page, 'hist-auto-2.md');

    const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
    await editor.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.EDITOR_LOAD });

    // Create manual save with unique marker
    const manualMarker = `Manual save ${Date.now()}`;
    await editDocumentContent(page, editor, `# History Test 2\n\n${manualMarker}\n`);
    await manualSaveDocument(page);

    // Create auto save with unique marker
    const autoSaveMarker = `Auto save ${Date.now()}`;
    await editDocumentContent(page, editor, `# History Test 2\n\n${autoSaveMarker}\n`);
    await waitForAutosave(page, 'hist-auto-2.md');

    // Open history
    await openHistoryDialog(page);
    await page.waitForTimeout(500);

    // Click on the manual save entry (index 1 - second from top)
    const historyItems = page.locator('.history-item');
    const itemCount = await historyItems.count();
    expect(itemCount).toBeGreaterThanOrEqual(2);

    await historyItems.nth(1).click();
    await page.waitForTimeout(300);

    // Restore this version
    await restoreFromHistory(page);

    // Verify editor shows restored content (the manual save version)
    const editorText = await editor.innerText();
    expect(editorText).toContain(manualMarker);
    expect(editorText).not.toContain(autoSaveMarker);

    // Restore persists the chosen snapshot through saveFile, so on-disk
    // content must reflect the older version. The file-watcher then
    // re-syncs the editor, so the tab is *not* dirty after restore.
    const filePath = path.join(workspaceDir, 'hist-auto-2.md');
    await expect.poll(
      async () => (await fs.readFile(filePath, 'utf-8')).includes(manualMarker),
      { timeout: 5000 },
    ).toBe(true);

    await closeTabByFileName(page, 'hist-auto-2.md');
  });

  test('should restore from manual save entry', async () => {
    await openFileFromTree(page, 'hist-auto-3.md');

    const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
    await editor.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.EDITOR_LOAD });

    const olderMarker = `Older save ${Date.now()}`;
    await editDocumentContent(page, editor, `# History Test 3\n\n${olderMarker}\n`);
    await manualSaveDocument(page);

    const newerMarker = `Newer save ${Date.now() + 1}`;
    await editDocumentContent(page, editor, `# History Test 3\n\n${newerMarker}\n`);
    await manualSaveDocument(page);

    await openHistoryDialog(page);
    await page.waitForTimeout(500);

    const historyItems = page.locator('.history-item');
    const itemCount = await historyItems.count();
    expect(itemCount).toBeGreaterThanOrEqual(2);

    await historyItems.nth(1).click();
    await page.waitForTimeout(300);

    await restoreFromHistory(page);

    const editorText = await editor.innerText();
    expect(editorText).toContain(olderMarker);
    expect(editorText).not.toContain(newerMarker);

    await closeTabByFileName(page, 'hist-auto-3.md');
  });

  // --- Test from history-manual-auto-simple.spec.ts ---

  test('should create manual save entry in history', async () => {
    const testFile = path.join(workspaceDir, 'hist-simple.md');

    await openFileFromTree(page, 'hist-simple.md');

    const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
    await editor.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.EDITOR_LOAD });

    // Make edit and manually save
    await editDocumentContent(page, editor, '# Test\n\nManual save.\n');
    await manualSaveDocument(page);

    const savedContent = await fs.readFile(testFile, 'utf8');
    expect(savedContent).toContain('Manual save');

    // Open file history dialog
    await openHistoryDialog(page);

    const count = await getHistoryItemCount(page);
    expect(count).toBeGreaterThanOrEqual(1);

    // Close history dialog and tab
    await page.keyboard.press('Escape');
    await closeTabByFileName(page, 'hist-simple.md');
  });

  // --- Tests from history-restore.spec.ts ---

  test('creates manual snapshot and restores previous version', async () => {
    const testFile = path.join(workspaceDir, 'hist-restore.md');

    await openFileFromTree(page, 'hist-restore.md');

    const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
    await editor.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.EDITOR_LOAD });
    let editorText = await editor.innerText();
    expect(editorText).toContain('Original Content');

    // Make first edit and save manually
    const firstMarker = `First Edit ${Date.now()}`;
    await editDocumentContent(page, editor, `# ${firstMarker}\n\nThis is the first version after editing.\n`);
    await manualSaveDocument(page);

    const firstEditContent = await fs.readFile(testFile, 'utf8');
    expect(firstEditContent).toContain(firstMarker);

    // Make second edit and save
    const secondMarker = `Second Edit ${Date.now()}`;
    await editDocumentContent(page, editor, `# ${secondMarker}\n\nThis is the second version after editing.\n`);
    await manualSaveDocument(page);

    const secondEditContent = await fs.readFile(testFile, 'utf8');
    expect(secondEditContent).toContain(secondMarker);

    // Open history dialog
    await openHistoryDialog(page);
    await page.waitForTimeout(500);

    // Verify we have multiple snapshots
    const historyItems = page.locator('.history-item');
    const snapshotCount = await historyItems.count();
    expect(snapshotCount).toBeGreaterThanOrEqual(2);

    // Click on the first edit entry (index 1 - second from top)
    await historyItems.nth(1).click();
    await page.waitForTimeout(300);

    // Restore the snapshot
    await restoreFromHistory(page);

    // Wait for editor to reflect the restored content
    await expect.poll(async () => {
      return await editor.innerText();
    }, { timeout: 5000, message: 'Editor should show restored first edit content' }).toContain(firstMarker);

    editorText = await editor.innerText();
    expect(editorText).not.toContain(secondMarker);

    // Verify the file on disk now contains the restored content
    const restoredFileContent = await fs.readFile(testFile, 'utf8');
    expect(restoredFileContent).toContain(firstMarker);
    expect(restoredFileContent).not.toContain(secondMarker);

    await closeTabByFileName(page, 'hist-restore.md');
  });

  test('restored content appears immediately without refresh', async () => {
    await openFileFromTree(page, 'hist-immediate.md');

    const editor = page.locator(ACTIVE_EDITOR_SELECTOR);
    await editor.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.EDITOR_LOAD });

    // Save the original content first to create a history entry
    await manualSaveDocument(page);

    // Edit and save with modified content
    await editDocumentContent(page, editor, '# Modified\n\nModified text.\n');
    await manualSaveDocument(page);

    // Open history dialog
    await openHistoryDialog(page);

    // Wait for items to load
    await page.waitForTimeout(500);

    // Select the original version (second snapshot, index 1)
    const historyItems = page.locator('.history-item');
    const itemCount = await historyItems.count();
    expect(itemCount).toBeGreaterThanOrEqual(2);

    await selectHistoryItem(page, 1);

    // Restore from history
    await restoreFromHistory(page);

    // CRITICAL: Content should appear immediately without refresh
    await expect.poll(async () => {
      return await editor.innerText();
    }, { timeout: 5000, message: 'Editor should show restored Original content immediately' }).toContain('Original');

    const editorText = await editor.innerText();
    expect(editorText).not.toContain('Modified');

    // Verify we don't need to refresh to see the content
    expect(editorText.trim().length).toBeGreaterThan(0);

    await closeTabByFileName(page, 'hist-immediate.md');
  });
});
