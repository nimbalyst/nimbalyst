/**
 * Mockup Diff E2E Tests (Consolidated)
 *
 * Tests for accepting and rejecting AI edits to mockup files:
 * - Accepting diff shows updated content in iframe viewer
 * - Rejecting diff reverts to original content
 *
 * Consolidated from:
 * - diff-accept.spec.ts (1 test)
 * - diff-reject.spec.ts (1 test)
 *
 * All tests share a single app instance for performance.
 */

import { test, expect, ElectronApplication, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  dismissProjectTrustToast,
  TEST_TIMEOUTS,
  ACTIVE_EDITOR_SELECTOR,
} from '../../helpers';

// Selector for the active tab's iframe (avoids matching hidden tab iframes)
const ACTIVE_TAB_WRAPPER = '.file-tabs-container .tab-editor-wrapper:not([style*="display: none"])';
import { dismissAPIKeyDialog, switchToAgentMode, switchToFilesMode } from '../../utils/testHelpers';

// Use serial mode to ensure tests run in order with shared app instance
test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

// Shared mockup HTML templates
const makeOriginalContent = (color: string) => `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Test Mockup</title>
</head>
<body>
    <div style="width: 100px; height: 100px; background-color: ${color};"></div>
</body>
</html>`;

test.describe('Mockup Diff', () => {
  test.beforeAll(async () => {
    workspaceDir = await createTempWorkspace();

    // Create test mockup files with different names to avoid conflicts
    await fs.writeFile(
      path.join(workspaceDir, 'accept.mockup.html'),
      makeOriginalContent('red'),
      'utf8'
    );
    await fs.writeFile(
      path.join(workspaceDir, 'reject.mockup.html'),
      makeOriginalContent('red'),
      'utf8'
    );

    electronApp = await launchElectronApp({ workspace: workspaceDir });
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

  test('sidebar resize drags continue over the mockup iframe and end on release', async () => {
    await page.locator('.file-tree-name', { hasText: 'accept.mockup.html' }).click();

    const activeWrapper = page.locator(ACTIVE_TAB_WRAPPER);
    const mockupFrame = activeWrapper.locator('iframe');
    await mockupFrame.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.EDITOR_LOAD });

    const fileSidebar = page.locator('.workspace-sidebar');
    const fileResizeHandle = page.getByTestId('editor-mode-sidebar-resize-handle');
    const fileHandleBox = await fileResizeHandle.boundingBox();
    const frameBox = await mockupFrame.boundingBox();
    const initialFileWidth = (await fileSidebar.boundingBox())!.width;
    expect(fileHandleBox).not.toBeNull();
    expect(frameBox).not.toBeNull();

    await page.mouse.move(fileHandleBox!.x + fileHandleBox!.width / 2, fileHandleBox!.y + 40);
    await page.mouse.down();
    await page.mouse.move(frameBox!.x + 80, frameBox!.y + 80);

    await expect.poll(async () => (await fileSidebar.boundingBox())!.width).toBeGreaterThan(initialFileWidth + 40);
    await expect(page.getByTestId('resize-drag-shield')).toBeAttached();

    await page.mouse.up();
    await expect(page.getByTestId('resize-drag-shield')).toHaveCount(0);
    const releasedFileWidth = (await fileSidebar.boundingBox())!.width;
    await page.mouse.move(frameBox!.x + 140, frameBox!.y + 80);
    await expect.poll(async () => (await fileSidebar.boundingBox())!.width).toBe(releasedFileWidth);

    const chatSidebar = page.getByTestId('chat-sidebar-panel');
    const chatResizeHandle = page.getByTestId('chat-sidebar-resize-handle');
    await chatSidebar.waitFor({ state: 'visible' });
    const chatHandleBox = await chatResizeHandle.boundingBox();
    const initialChatWidth = (await chatSidebar.boundingBox())!.width;
    expect(chatHandleBox).not.toBeNull();

    await page.mouse.move(chatHandleBox!.x + chatHandleBox!.width / 2, chatHandleBox!.y + 40);
    await page.mouse.down();
    await page.mouse.move(chatHandleBox!.x - 80, frameBox!.y + 80);

    await expect.poll(async () => (await chatSidebar.boundingBox())!.width).toBeGreaterThan(initialChatWidth + 40);
    await page.mouse.up();
    const releasedChatWidth = (await chatSidebar.boundingBox())!.width;
    await page.mouse.move(chatHandleBox!.x - 140, frameBox!.y + 80);
    await expect.poll(async () => (await chatSidebar.boundingBox())!.width).toBe(releasedChatWidth);

    // Restore the shared app layout so the remaining serial mockup tests keep
    // their original editor viewport and click targets.
    const resizedChatHandleBox = await chatResizeHandle.boundingBox();
    await page.mouse.move(resizedChatHandleBox!.x + resizedChatHandleBox!.width / 2, resizedChatHandleBox!.y + 40);
    await page.mouse.down();
    await page.mouse.move(chatHandleBox!.x + chatHandleBox!.width / 2, resizedChatHandleBox!.y + 40);
    await page.mouse.up();
    await expect.poll(async () => Math.abs((await chatSidebar.boundingBox())!.width - initialChatWidth)).toBeLessThan(3);

    const resizedFileHandleBox = await fileResizeHandle.boundingBox();
    await page.mouse.move(resizedFileHandleBox!.x + resizedFileHandleBox!.width / 2, resizedFileHandleBox!.y + 40);
    await page.mouse.down();
    await page.mouse.move(initialFileWidth, resizedFileHandleBox!.y + 40);
    await page.mouse.up();
    await expect.poll(async () => Math.abs((await fileSidebar.boundingBox())!.width - initialFileWidth)).toBeLessThan(3);
  });

  test('Agent mode resizers keep working over a mockup in the top editor tab', async () => {
    const mockupPath = path.join(workspaceDir, 'accept.mockup.html');
    await switchToAgentMode(page);
    await page.evaluate(async ({ workspacePath, filePath }) => {
      const helpers = (window as any).__testHelpers;
      if (!helpers?.openFileInAgentMode) {
        throw new Error('openFileInAgentMode test helper not exposed');
      }
      return helpers.openFileInAgentMode(workspacePath, filePath);
    }, { workspacePath: workspaceDir, filePath: mockupPath });

    const agentMode = page.locator('.agent-mode:visible');
    const editorArea = agentMode.locator('.agent-workstream-editor-area');
    const mockupFrame = editorArea.locator('iframe[title^="Mockup:"]');
    await mockupFrame.waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.EDITOR_LOAD });
    const frameBox = await mockupFrame.boundingBox();
    expect(frameBox).not.toBeNull();

    const historyPanel = agentMode.locator('.resizable-panel-left');
    const historyHandle = agentMode.getByTestId('agent-history-resize-handle');
    const historyHandleBox = await historyHandle.boundingBox();
    const initialHistoryWidth = (await historyPanel.boundingBox())!.width;
    expect(historyHandleBox).not.toBeNull();

    await page.mouse.move(historyHandleBox!.x + historyHandleBox!.width / 2, historyHandleBox!.y + 40);
    await page.mouse.down();
    await page.mouse.move(frameBox!.x + 80, frameBox!.y + 80);
    await expect.poll(async () => (await historyPanel.boundingBox())!.width).toBeGreaterThan(initialHistoryWidth + 40);
    await page.mouse.up();
    const releasedHistoryWidth = (await historyPanel.boundingBox())!.width;
    await page.mouse.move(frameBox!.x + 140, frameBox!.y + 80);
    await expect.poll(async () => (await historyPanel.boundingBox())!.width).toBe(releasedHistoryWidth);

    const filesSidebar = agentMode.locator('.files-edited-sidebar');
    const filesHandle = agentMode.getByTestId('agent-files-sidebar-resize-handle');
    await filesSidebar.waitFor({ state: 'visible' });
    const filesHandleBox = await filesHandle.boundingBox();
    const initialFilesWidth = (await filesSidebar.boundingBox())!.width;
    expect(filesHandleBox).not.toBeNull();

    await page.mouse.move(filesHandleBox!.x + filesHandleBox!.width / 2, filesHandleBox!.y + 40);
    await page.mouse.down();
    await page.mouse.move(filesHandleBox!.x - 80, frameBox!.y + 80);
    await expect.poll(async () => (await filesSidebar.boundingBox())!.width).toBeGreaterThan(initialFilesWidth + 40);
    await page.mouse.up();
    const releasedFilesWidth = (await filesSidebar.boundingBox())!.width;
    await page.mouse.move(filesHandleBox!.x - 140, frameBox!.y + 80);
    await expect.poll(async () => (await filesSidebar.boundingBox())!.width).toBe(releasedFilesWidth);

    const verticalHandle = agentMode.getByTestId('agent-workstream-vertical-resize-handle');
    const verticalHandleBox = await verticalHandle.boundingBox();
    const initialEditorHeight = (await editorArea.boundingBox())!.height;
    expect(verticalHandleBox).not.toBeNull();

    await page.mouse.move(verticalHandleBox!.x + 40, verticalHandleBox!.y + verticalHandleBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(frameBox!.x + 80, frameBox!.y + 80);
    await expect.poll(async () => (await editorArea.boundingBox())!.height).toBeLessThan(initialEditorHeight - 40);
    await page.mouse.up();
    const releasedEditorHeight = (await editorArea.boundingBox())!.height;
    await page.mouse.move(frameBox!.x + 80, frameBox!.y + 40);
    await expect.poll(async () => (await editorArea.boundingBox())!.height).toBe(releasedEditorHeight);

    await switchToFilesMode(page);
  });

  test('mockup viewer shows updated content after accepting diff', async () => {
    const mockupPath = path.join(workspaceDir, 'accept.mockup.html');
    const originalContent = makeOriginalContent('red');
    const modifiedContent = makeOriginalContent('blue');

    // Open the mockup file
    await page.locator('.file-tree-name', { hasText: 'accept.mockup.html' }).click();

    // Wait for the mockup viewer to load (scoped to active tab)
    const activeWrapper = page.locator(ACTIVE_TAB_WRAPPER);
    await activeWrapper.locator('iframe').waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.EDITOR_LOAD });
    await page.waitForTimeout(500);

    // Verify the iframe shows the RED box initially
    const iframe = activeWrapper.frameLocator('iframe');
    const redBox = iframe.locator('div[style*="red"]');
    await expect(redBox).toBeVisible({ timeout: 5000 });

    // Simulate AI edit: write modified content to disk and create pending history tag
    await fs.writeFile(mockupPath, modifiedContent, 'utf8');

    const tagId = `test-tag-accept-${Date.now()}`;
    const sessionId = `test-session-accept-${Date.now()}`;

    await page.evaluate(async ({ workspacePath, filePath, tagId, sessionId, originalContent }) => {
      await window.electronAPI.history.createTag(
        workspacePath,
        filePath,
        tagId,
        originalContent,
        sessionId,
        'test-tool-use'
      );
    }, { workspacePath: workspaceDir, filePath: mockupPath, tagId, sessionId, originalContent });

    // Close and reopen the file to trigger pending tag check
    await page.keyboard.press('Meta+w');
    await page.waitForTimeout(300);

    await page.locator('.file-tree-name', { hasText: 'accept.mockup.html' }).click();
    const activeWrapper2 = page.locator(ACTIVE_TAB_WRAPPER);
    // Diff view creates 2 iframes (Updated + Original), use .first()
    await activeWrapper2.locator('iframe').first().waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.EDITOR_LOAD });
    await page.waitForTimeout(500);

    // Wait for diff header to appear
    await page.waitForSelector('.unified-diff-header', { timeout: 5000 });

    // Click "Keep All" to accept the changes
    const keepButton = page.locator('.unified-diff-header button', { hasText: /Keep/i }).first();
    await keepButton.click();
    await page.waitForTimeout(500);

    // Wait for diff header to disappear
    await page.waitForSelector('.unified-diff-header', { state: 'hidden', timeout: 3000 }).catch(() => {
      console.log('[Test] Diff header still visible after Keep');
    });

    await page.waitForTimeout(1000);

    // After accepting, diff view collapses to single iframe
    const iframeFinal = activeWrapper2.frameLocator('iframe').first();
    const blueBox = iframeFinal.locator('div[style*="blue"]');
    await expect(blueBox).toBeVisible({ timeout: 5000 });

    // Also verify RED is gone
    const redBoxAfter = iframeFinal.locator('div[style*="red"]');
    await expect(redBoxAfter).not.toBeVisible();

    // Verify the file on disk has blue
    const finalContent = await fs.readFile(mockupPath, 'utf-8');
    expect(finalContent).toContain('blue');
    expect(finalContent).not.toContain('red');
  });

  test('rejecting diff reverts to original content', async () => {
    const mockupPath = path.join(workspaceDir, 'reject.mockup.html');
    const originalContent = makeOriginalContent('red');
    const modifiedContent = makeOriginalContent('blue');

    // Open the mockup file
    await page.locator('.file-tree-name', { hasText: 'reject.mockup.html' }).click();

    // Wait for the mockup viewer to load (scoped to active tab)
    const activeWrapper = page.locator(ACTIVE_TAB_WRAPPER);
    await activeWrapper.locator('iframe').waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.EDITOR_LOAD });
    await page.waitForTimeout(500);

    // Verify the iframe shows the RED box initially
    const iframe = activeWrapper.frameLocator('iframe');
    const redBox = iframe.locator('div[style*="red"]');
    await expect(redBox).toBeVisible({ timeout: 5000 });

    // Simulate AI edit: write modified content to disk and create pending history tag
    await fs.writeFile(mockupPath, modifiedContent, 'utf8');

    const tagId = `test-tag-reject-${Date.now()}`;
    const sessionId = `test-session-reject-${Date.now()}`;

    await page.evaluate(async ({ workspacePath, filePath, tagId, sessionId, originalContent }) => {
      await window.electronAPI.history.createTag(
        workspacePath,
        filePath,
        tagId,
        originalContent,
        sessionId,
        'test-tool-use'
      );
    }, { workspacePath: workspaceDir, filePath: mockupPath, tagId, sessionId, originalContent });

    // Close and reopen the file to trigger pending tag check
    await page.keyboard.press('Meta+w');
    await page.waitForTimeout(300);

    await page.locator('.file-tree-name', { hasText: 'reject.mockup.html' }).click();
    const activeWrapper2 = page.locator(ACTIVE_TAB_WRAPPER);
    // Diff view creates 2 iframes (Updated + Original), use .first()
    await activeWrapper2.locator('iframe').first().waitFor({ state: 'visible', timeout: TEST_TIMEOUTS.EDITOR_LOAD });
    await page.waitForTimeout(500);

    // Wait for diff header to appear
    await page.waitForSelector('.unified-diff-header', { timeout: 5000 });

    // Click "Revert" to reject the changes
    const revertButton = page.locator('.unified-diff-header button', { hasText: /Revert/i }).first();
    await revertButton.click();
    await page.waitForTimeout(500);

    // Wait for diff header to disappear
    await page.waitForSelector('.unified-diff-header', { state: 'hidden', timeout: 3000 }).catch(() => {
      console.log('[Test] Diff header still visible after Revert');
    });

    await page.waitForTimeout(1000);

    // After reverting, diff view collapses to single iframe
    const iframeFinal = activeWrapper2.frameLocator('iframe').first();
    const redBoxAfter = iframeFinal.locator('div[style*="red"]');
    await expect(redBoxAfter).toBeVisible({ timeout: 5000 });

    // Also verify BLUE is gone
    const blueBoxAfter = iframeFinal.locator('div[style*="blue"]');
    await expect(blueBoxAfter).not.toBeVisible();

    // Verify the file on disk has red (reverted)
    const finalContent = await fs.readFile(mockupPath, 'utf-8');
    expect(finalContent).toContain('red');
    expect(finalContent).not.toContain('blue');
  });
});
