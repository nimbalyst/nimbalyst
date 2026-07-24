/**
 * AI Tool Simulator - Test utility for simulating AI tool calls without actual AI
 *
 * This utility allows tests to simulate:
 * - applyDiff operations (text replacements)
 * - streamContent operations (streaming edits)
 * - getDocumentContent operations
 *
 * Usage:
 * ```typescript
 * import { simulateApplyDiff, simulateStreamContent } from './utils/aiToolSimulator';
 *
 * // Simulate a diff edit
 * await simulateApplyDiff(page, filePath, [
 *   { oldText: 'hello', newText: 'goodbye' }
 * ]);
 *
 * // Simulate streaming content
 * await simulateStreamContent(page, 'New content here', { insertAtEnd: true });
 * ```
 */

import type { Page } from '@playwright/test';
import { PLAYWRIGHT_TEST_SELECTORS } from './testHelpers';

export interface TextReplacement {
  oldText: string;
  newText: string;
}

export interface StreamConfig {
  position?: string;
  insertAfter?: string;
  insertAtEnd?: boolean;
  mode?: 'append' | 'replace';
}

/**
 * Simulate an applyDiff operation using editorRegistry.applyReplacements
 * This properly simulates the AI edit flow with diff tags and visualization
 */
export async function simulateApplyDiff(
  page: Page,
  targetFilePath: string,
  replacements: TextReplacement[]
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await page.evaluate(
      async ({ filePath, reps }) => {
        const editorRegistry = (window as any).__editorRegistry;

        if (!editorRegistry) {
          throw new Error('EditorRegistry not found on window');
        }

        // Wait for the editor to register with the registry.
        // AIChatIntegrationPlugin registers asynchronously (deferred via rAF)
        // so the editor may not be available immediately after opening a file.
        const maxWait = 3000;
        const start = Date.now();
        while (!editorRegistry.has(filePath) && Date.now() - start < maxWait) {
          await new Promise(r => setTimeout(r, 50));
        }

        if (!editorRegistry.has(filePath)) {
          return { success: false, error: `No editor registered for ${filePath} after ${maxWait}ms wait` };
        }

        const result = await editorRegistry.applyReplacements(filePath, reps);
        return result;
      },
      { filePath: targetFilePath, reps: replacements }
    );

    return result || { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Simulate a streamContent operation by directly calling editorRegistry
 */
export async function simulateStreamContent(
  page: Page,
  content: string,
  config: StreamConfig = {}
): Promise<void> {
  await page.evaluate(
    async ({ contentText, cfg }) => {
      // Access the already-loaded editorRegistry from window
      const editorRegistry = (window as any).__editorRegistry;

      if (!editorRegistry) {
        throw new Error('EditorRegistry not found on window');
      }

      const streamId = `stream-test-${Date.now()}`;

      // Get active file path
      const filePath = editorRegistry.getActiveFilePath();
      if (!filePath) {
        throw new Error('No active editor for streaming');
      }

      // Start streaming
      editorRegistry.startStreaming(filePath, {
        id: streamId,
        position: cfg.position || (cfg.insertAtEnd ? undefined : 'cursor'),
        insertAfter: cfg.insertAfter,
        insertAtEnd: cfg.insertAtEnd || false,
        mode: cfg.mode || 'append'
      });

      // Small delay to let React state update
      await new Promise(resolve => setTimeout(resolve, 50));

      // Stream content in chunks (simulate real streaming)
      const chunkSize = 50;
      for (let i = 0; i < contentText.length; i += chunkSize) {
        const chunk = contentText.slice(i, Math.min(i + chunkSize, contentText.length));
        editorRegistry.streamContent(filePath, streamId, chunk);
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // End streaming
      editorRegistry.endStreaming(filePath, streamId);
    },
    { contentText: content, cfg: config }
  );
}

/**
 * Simulate getting document content
 */
export async function simulateGetDocumentContent(page: Page, filePath?: string): Promise<string> {
  return await page.evaluate(async (path) => {
    // Access the already-loaded editorRegistry from window
    const editorRegistry = (window as any).__editorRegistry;

    if (!editorRegistry) {
      throw new Error('EditorRegistry not found on window');
    }

    // Get target file path
    const target = path || editorRegistry.getActiveFilePath();
    if (!target) {
      throw new Error('No active editor');
    }

    return editorRegistry.getContent(target);
  }, filePath);
}

/**
 * Wait for editor to be ready (has content and is editable)
 */
export async function waitForEditorReady(page: Page, timeout = 5000): Promise<void> {
  await page.waitForSelector('.editor [contenteditable="true"]', { timeout, state: 'visible' });
  await page.waitForTimeout(100); // Small delay for Lexical initialization
}

/**
 * Get the active editor's file path
 */
export async function getActiveEditorFilePath(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const activeEditor = document.querySelector('.multi-editor-instance.active');
    return activeEditor?.getAttribute('data-file-path') || null;
  });
}

/**
 * Set up AI API for testing - expose editorRegistry on window
 */
export async function setupAIApiForTesting(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Wait for editorRegistry to be available
    const checkRegistry = () => {
      // Try to find it from any loaded module
      const modules = (window as any).__modules;
      if (modules) {
        for (const mod of Object.values(modules)) {
          if ((mod as any).editorRegistry) {
            (window as any).__editorRegistry = (mod as any).editorRegistry;
            return true;
          }
        }
      }
      return false;
    };

    // If not found, we'll need to wait for it to load
    if (!checkRegistry()) {
      console.log('[Test] EditorRegistry not yet available, will retry');
    }
  });
}

/**
 * Helper to create test markdown content
 */
export function createTestMarkdown(sections: Record<string, string>): string {
  return Object.entries(sections)
    .map(([heading, content]) => `# ${heading}\n\n${content}\n`)
    .join('\n');
}

/**
 * Accept all pending diffs in the active editor
 */
export async function acceptDiffs(page: Page): Promise<void> {
  // Click the Accept All button using the proper selector
  const acceptButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffAcceptAllButton);

  try {
    // Wait for the button to appear (it should already be there if there are diffs)
    await acceptButton.waitFor({ state: 'visible', timeout: 2000 });
    await acceptButton.click();
  } catch (e) {
    console.warn('[Test] Accept All button not found or not clickable');
  }

  // Wait for diffs to be processed
  await page.waitForTimeout(300);
}

/**
 * Helper to verify text exists in editor
 */
export async function verifyEditorContains(
  page: Page,
  text: string,
  shouldExist = true
): Promise<boolean> {
  const editorText = await page.evaluate(() => {
    // Use the canonical active editor selector: visible tab-editor-wrapper's contenteditable
    const activeEditor = document.querySelector(
      '.file-tabs-container .tab-editor-wrapper:not([style*="display: none"]) .multi-editor-instance .editor [contenteditable="true"]'
    );
    return activeEditor?.textContent || '';
  });

  const exists = editorText.includes(text);
  return shouldExist ? exists : !exists;
}

/**
 * Trigger manual save via IPC (simulates Cmd+S / File > Save menu action)
 *
 * This properly simulates how the Electron menu triggers a save by sending
 * the 'file-save' IPC event to the focused window.
 */
export async function triggerManualSave(electronApp: any): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }: any) => {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused) {
      focused.webContents.send('file-save');
    }
  });
}

/**
 * Wait for file to be saved (dirty indicator disappears)
 */
export async function waitForSave(page: Page, fileName: string = 'test.md', timeout = 2000): Promise<void> {
  const tab = page.locator('.file-tabs-container .tab', { has: page.locator('.tab-title', { hasText: fileName }) });
  await tab.locator('.tab-dirty-indicator').waitFor({ state: 'hidden', timeout });
}

/**
 * Query all tags for a file from the database (returns full metadata)
 * This includes status, sessionId, tagId, etc.
 */
export async function queryTags(electronApp: any, filePath: string): Promise<any[]> {
  const page = await electronApp.firstWindow();
  return page.evaluate(async (filePath: string) => {
    return await window.electronAPI.invoke('history:get-all-tags', filePath);
  }, filePath);
}

/**
 * Get pending tags for a file
 */
export async function getPendingTags(electronApp: any, filePath: string): Promise<any[]> {
  const page = await electronApp.firstWindow();
  return page.evaluate(async (filePath: string) => {
    return await window.electronAPI.history.getPendingTags(filePath);
  }, filePath);
}

/**
 * Get the diff baseline for a file (latest incremental-approval or pre-edit tag)
 */
export async function getDiffBaseline(electronApp: any, filePath: string): Promise<{ content: string; tagType: string } | null> {
  const page = await electronApp.firstWindow();
  return page.evaluate(async (filePath: string) => {
    return await window.electronAPI.invoke('history:get-diff-baseline', filePath);
  }, filePath);
}

/**
 * Count tags of a specific type for a file
 */
export async function countTagsByType(electronApp: any, filePath: string, tagType: string): Promise<number> {
  const tags = await queryTags(electronApp, filePath);
  return tags.filter((tag: any) => tag.type === tagType).length;
}
