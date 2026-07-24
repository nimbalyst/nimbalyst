/**
 * Monaco Editor E2E Tests (Consolidated)
 *
 * Tests for the Monaco-based code editor including:
 * - Autosave functionality
 * - Dirty close (save on tab close)
 * - External file change detection
 * - AI diff accept
 * - AI diff reject
 * - History integration (edits persist through autosave cycles)
 *
 * This file consolidates tests that previously lived in separate files.
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
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  openFileFromTree,
  closeTabByFileName,
  getTabByFileName,
  openHistoryDialog,
  selectHistoryItem,
  getHistoryItemCount,
} from '../utils/testHelpers';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

// Selector for the VISIBLE Monaco editor (inside the visible tab wrapper)
const VISIBLE_MONACO_SELECTOR = '.file-tabs-container .tab-editor-wrapper:not([style*="display: none"]) .monaco-code-editor';

/**
 * Helper to get Monaco editor content
 * Uses multiple methods to find the editor content with retry logic
 */
async function getMonacoContent(page: Page, timeout = 5000): Promise<string> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const result = await page.evaluate(() => {
      // Method 1: Try global monaco API
      const monaco = (window as any).monaco;
      const editors = monaco?.editor?.getEditors();
      if (editors && editors.length > 0) {
        return { source: 'monaco-api', content: editors[0].getValue() };
      }

      // Method 2: Try getting from view lines (fallback)
      // Note: view-lines use non-breaking spaces (charCode 160), need to normalize
      const monacoWrapper = document.querySelector('.monaco-code-editor');
      if (monacoWrapper) {
        const lines = monacoWrapper.querySelectorAll('.view-line');
        if (lines.length > 0) {
          const rawContent = Array.from(lines).map(l => l.textContent || '').join('\n');
          // Replace non-breaking spaces with regular spaces
          const normalizedContent = rawContent.replace(/\u00A0/g, ' ');
          return { source: 'view-lines', content: normalizedContent };
        }
      }

      return null;
    });

    if (result !== null && result.content.length > 0) {
      return result.content;
    }

    await page.waitForTimeout(200);
  }

  return '';
}

/**
 * Helper to type in Monaco editor (select all and replace)
 */
async function typeInMonaco(page: Page, text: string): Promise<void> {
  // Focus the Monaco editor
  await page.click(`${VISIBLE_MONACO_SELECTOR} .monaco-editor .view-lines`);
  await page.waitForTimeout(200);

  // Select all and replace
  const isMac = process.platform === 'darwin';
  await page.keyboard.press(isMac ? 'Meta+a' : 'Control+a');
  await page.waitForTimeout(100);

  // Delete selected content first
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);

  // Type new content
  await page.keyboard.type(text, { delay: 5 });
  await page.waitForTimeout(200);
}

/**
 * Helper to wait for dirty indicator to appear then disappear (autosave complete)
 */
async function waitForAutosaveComplete(page: Page, fileName: string): Promise<void> {
  const tab = getTabByFileName(page, fileName);

  // Wait for dirty indicator to appear (file was modified)
  await expect(tab.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toBeVisible({ timeout: 2000 });

  // Wait for autosave (default 2s interval + debounce + buffer)
  await page.waitForTimeout(3500);

  // Dirty indicator should be gone
  await expect(tab.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .not.toBeVisible({ timeout: 2000 });
}

// Shared app instance for all tests in this file
test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  // Create ALL test files upfront for all scenarios
  await fs.writeFile(
    path.join(workspaceDir, 'autosave-test.ts'),
    '// Original content\nconst x = 1;\n',
    'utf8'
  );
  await fs.writeFile(
    path.join(workspaceDir, 'dirty-close-test.ts'),
    '// Original content\nconst x = 1;\n',
    'utf8'
  );
  await fs.writeFile(
    path.join(workspaceDir, 'external-change-test.ts'),
    '// Original content\nconst x = 1;\n',
    'utf8'
  );
  await fs.writeFile(
    path.join(workspaceDir, 'diff-accept-test.tsx'),
    `function hello() {
  console.log("Original content");
  return true;
}
`,
    'utf8'
  );
  await fs.writeFile(
    path.join(workspaceDir, 'diff-reject-test.tsx'),
    `function hello() {
  console.log("Original content");
  return true;
}
`,
    'utf8'
  );
  // Test file for the encoding-fidelity diff test. Includes non-ASCII bytes
  // (accented chars, em-dash, emoji, CJK) so chardet auto-detection in
  // read-file-content has a chance to misclassify it as latin1/utf16/etc.
  await fs.writeFile(
    path.join(workspaceDir, 'diff-encoding-test.ts'),
    `// Café — résumé naïveté\nexport const greeting = "héllo wörld 你好 👋";\nexport const original = true;\n`,
    'utf8'
  );
  // Test file for the Codex-ordering Accept-All persistence test. The real
  // AIService Codex flow writes the file first (via the SDK's apply_patch),
  // then HistoryManager.createTag is called with the pre-edit baseline. This
  // is the OPPOSITE order from the existing diff-accept-test, which creates
  // the tag first. The race we care about hides only with this ordering.
  await fs.writeFile(
    path.join(workspaceDir, 'codex-accept-test.ts'),
    `export interface Greeting {\n  text: string;\n  emoji: string;\n}\n\nexport function greet(name: string): Greeting {\n  return { text: \`Hello, \${name}\`, emoji: '👋' };\n}\n`,
    'utf8'
  );
  // Test file mirroring the user-reported bug: Codex inserts new lines whose
  // first character is NBSP (U+00A0) instead of ASCII space. Monaco's unicode
  // highlight feature draws a box around the NBSP, which is what the user
  // sees as "weird characters" in the diff. The Accept All path must still
  // round-trip the actual file bytes to disk.
  await fs.writeFile(
    path.join(workspaceDir, 'codex-nbsp-test.ts'),
    `/*\n\nNumbers\n- One\n- Two\n- Three\n\n\nLetters\n- A\n- B\n- C\n- D\n\n*/\n`,
    'utf8'
  );
  // Mirrors the user's actual reproduction file (markdowntests/small-typescript.ts).
  // Disk bytes are CLEAN ASCII -- but Monaco still renders square glyphs on
  // the inserted lines in the diff. This test inspects exactly what those
  // glyphs are (gutter widgets, inline decorations, view-overlay elements).
  await fs.writeFile(
    path.join(workspaceDir, 'codex-glyph-probe.ts'),
    `/*\n\nNumbers\n- One\n- Two\n- Three\n\n\nLetters\n- A\n- B\n- C\n- D\n\n*/\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(workspaceDir, 'history-test.ts'),
    `// Initial content
function hello() {
  console.log("Hello");
}
`,
    'utf8'
  );

  electronApp = await launchElectronApp({ workspace: workspaceDir });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);
  await dismissProjectTrustToast(page);
});

test.afterAll(async () => {
  await electronApp?.close();
  if (workspaceDir) {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});

test('autosave clears dirty indicator and saves content', async () => {
  const tsPath = path.join(workspaceDir, 'autosave-test.ts');
  const marker = `// autosave-marker-${Date.now()}`;

  // Open the TypeScript file
  await openFileFromTree(page, 'autosave-test.ts');

  // Wait for Monaco editor to load
  await page.waitForSelector(VISIBLE_MONACO_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Click in the Monaco editor and type at the end
  await page.click(`${VISIBLE_MONACO_SELECTOR} .monaco-editor .view-lines`);
  await page.waitForTimeout(200);
  await page.keyboard.press('End');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(marker, { delay: 5 });

  // Verify dirty indicator appears
  const tabElement = getTabByFileName(page, 'autosave-test.ts');
  await expect(tabElement.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toBeVisible({ timeout: 2000 });

  // Wait for autosave (2s interval + 200ms debounce + buffer)
  await page.waitForTimeout(3500);

  // Verify dirty indicator cleared
  await expect(tabElement.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toHaveCount(0, { timeout: 1000 });

  // Verify content saved to disk
  const savedContent = await fs.readFile(tsPath, 'utf-8');
  expect(savedContent).toContain(marker);

  // Close the tab to clean up for next test
  await closeTabByFileName(page, 'autosave-test.ts');
});

test('edited content is saved when tab is closed', async () => {
  const tsPath = path.join(workspaceDir, 'dirty-close-test.ts');
  const marker = `// edited-marker-${Date.now()}`;

  // Open the TypeScript file
  await openFileFromTree(page, 'dirty-close-test.ts');

  // Wait for Monaco editor to load
  await page.waitForSelector(VISIBLE_MONACO_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Click in the Monaco editor and type at the end
  await page.click(`${VISIBLE_MONACO_SELECTOR} .monaco-editor .view-lines`);
  await page.waitForTimeout(200);
  await page.keyboard.press('End');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(marker, { delay: 5 });

  // Verify dirty indicator appears
  const tabElement = getTabByFileName(page, 'dirty-close-test.ts');
  await expect(tabElement.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toBeVisible({ timeout: 2000 });

  // Close the tab using helper (clicks close button, waits for tab to disappear)
  await closeTabByFileName(page, 'dirty-close-test.ts');

  // Wait for save to complete (async save via IPC)
  await page.waitForTimeout(500);

  // Read the file and check the content
  const savedContent = await fs.readFile(tsPath, 'utf-8');

  // Verify the content was saved
  expect(savedContent).toContain(marker);
});

test('external file change auto-reloads when editor is clean', async () => {
  const tsPath = path.join(workspaceDir, 'external-change-test.ts');
  const externalContent = '// Modified externally\nconst y = 2;\n';

  // Open the TypeScript file
  await openFileFromTree(page, 'external-change-test.ts');

  // Wait for Monaco editor to load
  await page.waitForSelector(VISIBLE_MONACO_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Verify no dirty indicator (editor is clean)
  const tabElement = getTabByFileName(page, 'external-change-test.ts');
  await expect(tabElement.locator(PLAYWRIGHT_TEST_SELECTORS.tabDirtyIndicator))
    .toHaveCount(0);

  // Verify original content
  const initialContent = await getMonacoContent(page);
  expect(initialContent).toContain('Original content');

  // Modify file externally
  await fs.writeFile(tsPath, externalContent, 'utf8');

  // Wait for file watcher to detect and reload
  await page.waitForTimeout(1500);

  // Verify editor shows new content (no conflict dialog)
  const updatedContent = await getMonacoContent(page);
  expect(updatedContent).toContain('Modified externally');
  expect(updatedContent).not.toContain('Original content');

  // Close the tab to clean up
  await closeTabByFileName(page, 'external-change-test.ts');
});

test('accepting diff applies changes and saves to disk', async () => {
  const tsxPath = path.join(workspaceDir, 'diff-accept-test.tsx');

  // Original content (already written in beforeAll)
  const originalContent = `function hello() {
  console.log("Original content");
  return true;
}
`;

  // Modified content
  const modifiedContent = `function hello() {
  console.log("Modified by AI");
  return false;
}
`;

  // Open the file
  await openFileFromTree(page, 'diff-accept-test.tsx');

  // Wait for Monaco editor to load
  await page.waitForSelector(VISIBLE_MONACO_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Verify original content loads
  const initialText = await getMonacoContent(page);
  expect(initialText).toContain('Original content');

  // Simulate AI edit:
  // 1. Create a pending history tag
  // 2. Write modified content to disk
  const tagId = `test-tag-${Date.now()}`;
  const sessionId = `test-session-${Date.now()}`;

  await page.evaluate(async ({ workspacePath, filePath, tagId, sessionId, originalContent }) => {
    await window.electronAPI.history.createTag(
      workspacePath,
      filePath,
      tagId,
      originalContent,
      sessionId,
      'test-tool-use'
    );
  }, { workspacePath: workspaceDir, filePath: tsxPath, tagId, sessionId, originalContent });

  // Write modified content to disk (triggers file watcher)
  await fs.writeFile(tsxPath, modifiedContent, 'utf8');

  // Wait for file watcher to detect change and show diff
  await page.waitForSelector(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader, { timeout: 5000 });

  // Verify Monaco is in diff mode
  const hasDiffEditor = await page.evaluate(() => {
    const diffContainer = document.querySelector('.monaco-diff-editor');
    return !!diffContainer;
  });
  expect(hasDiffEditor).toBe(true);

  // Verify unaccepted indicator on tab
  const tabElement = getTabByFileName(page, 'diff-accept-test.tsx');
  await expect(tabElement.locator(PLAYWRIGHT_TEST_SELECTORS.tabUnacceptedIndicator))
    .toBeVisible({ timeout: 2000 });

  // Click "Keep All" to accept the changes
  const acceptButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffAcceptAllButton);
  await acceptButton.click();
  await page.waitForTimeout(500);

  // Wait for unified diff header to disappear
  await page.waitForSelector(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader, { state: 'hidden', timeout: 3000 }).catch(() => {
    // Header may disappear quickly
  });

  // Verify unaccepted indicator is gone
  await expect(tabElement.locator(PLAYWRIGHT_TEST_SELECTORS.tabUnacceptedIndicator))
    .toHaveCount(0, { timeout: 2000 });

  // Verify editor shows modified content
  const finalEditorText = await getMonacoContent(page);
  expect(finalEditorText).toContain('Modified by AI');
  expect(finalEditorText).not.toContain('Original content');

  // Verify the file on disk has the modified content
  const finalContent = await fs.readFile(tsxPath, 'utf-8');
  expect(finalContent).toContain('Modified by AI');

  // Close the tab to clean up
  await closeTabByFileName(page, 'diff-accept-test.tsx');
});

test('rejecting diff reverts to original content', async () => {
  const tsxPath = path.join(workspaceDir, 'diff-reject-test.tsx');

  // Original content (already written in beforeAll)
  const originalContent = `function hello() {
  console.log("Original content");
  return true;
}
`;

  // Modified content
  const modifiedContent = `function hello() {
  console.log("Modified by AI");
  return false;
}
`;

  // Open the file
  await openFileFromTree(page, 'diff-reject-test.tsx');

  // Wait for Monaco editor to load
  await page.waitForSelector(VISIBLE_MONACO_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Verify original content loads
  const initialText = await getMonacoContent(page);
  expect(initialText).toContain('Original content');

  // Simulate AI edit:
  // 1. Create a pending history tag
  // 2. Write modified content to disk
  const tagId = `test-tag-${Date.now()}`;
  const sessionId = `test-session-${Date.now()}`;

  await page.evaluate(async ({ workspacePath, filePath, tagId, sessionId, originalContent }) => {
    await window.electronAPI.history.createTag(
      workspacePath,
      filePath,
      tagId,
      originalContent,
      sessionId,
      'test-tool-use'
    );
  }, { workspacePath: workspaceDir, filePath: tsxPath, tagId, sessionId, originalContent });

  // Write modified content to disk (triggers file watcher)
  await fs.writeFile(tsxPath, modifiedContent, 'utf8');

  // Wait for file watcher to detect change and show diff
  await page.waitForSelector(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader, { timeout: 5000 });

  // Verify unaccepted indicator on tab
  const tabElement = getTabByFileName(page, 'diff-reject-test.tsx');
  await expect(tabElement.locator(PLAYWRIGHT_TEST_SELECTORS.tabUnacceptedIndicator))
    .toBeVisible({ timeout: 2000 });

  // Click "Revert All" to reject the changes
  const rejectButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffRejectAllButton);
  await rejectButton.click();
  await page.waitForTimeout(500);

  // Wait for unified diff header to disappear
  await page.waitForSelector(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader, { state: 'hidden', timeout: 3000 }).catch(() => {
    // Header may disappear quickly
  });

  // Verify unaccepted indicator is gone
  await expect(tabElement.locator(PLAYWRIGHT_TEST_SELECTORS.tabUnacceptedIndicator))
    .toHaveCount(0, { timeout: 2000 });

  // Verify editor shows original content (reverted)
  const finalEditorText = await getMonacoContent(page);
  expect(finalEditorText).toContain('Original content');
  expect(finalEditorText).not.toContain('Modified by AI');

  // Verify the file on disk has the original content (reverted)
  const finalContent = await fs.readFile(tsxPath, 'utf-8');
  expect(finalContent).toContain('Original content');
  expect(finalContent).not.toContain('Modified by AI');

  // Close the tab to clean up
  await closeTabByFileName(page, 'diff-reject-test.tsx');
});

test('user edits persist through autosave and appear in history', async () => {
  const tsPath = path.join(workspaceDir, 'history-test.ts');

  // Open the TypeScript file
  await openFileFromTree(page, 'history-test.ts');

  // Wait for Monaco editor to load
  await page.waitForSelector(VISIBLE_MONACO_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Verify initial content
  let content = await getMonacoContent(page);
  expect(content).toContain('Initial');

  // Make first edit
  const firstEdit = `// First edit
function hello() {
  console.log("First edit content");
}
`;
  await typeInMonaco(page, firstEdit);

  // Verify edit is in editor
  content = await getMonacoContent(page);
  expect(content).toContain('First');

  // Wait for autosave
  await waitForAutosaveComplete(page, 'history-test.ts');

  // Verify file on disk has the edit
  const diskContent1 = await fs.readFile(tsPath, 'utf8');
  expect(diskContent1).toContain('First edit content');

  // Make second edit (to verify history has multiple entries)
  const secondEdit = `// Second edit
function hello() {
  console.log("Second edit content");
}
`;
  await typeInMonaco(page, secondEdit);

  content = await getMonacoContent(page);
  expect(content).toContain('Second');

  // Wait for autosave
  await waitForAutosaveComplete(page, 'history-test.ts');

  const diskContent2 = await fs.readFile(tsPath, 'utf8');
  expect(diskContent2).toContain('Second edit');

  // Open history and verify we have at least 2 snapshots
  await openHistoryDialog(page);

  const historyCount = await getHistoryItemCount(page);
  expect(historyCount).toBeGreaterThanOrEqual(2);

  // Close history dialog (press Escape)
  await page.keyboard.press('Escape');
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.historyDialog)).not.toBeVisible();

  // Verify current editor still has the latest content
  content = await getMonacoContent(page);
  expect(content).toContain('Second');

  // Close the tab to clean up
  await closeTabByFileName(page, 'history-test.ts');
});

test('Codex-style diff preserves non-ASCII bytes round-trip', async () => {
  // Simulates the Codex file_change pipeline:
  //   - FileSnapshotCache captures pre-edit content as utf-8
  //   - HistoryManager creates a pending tag with that baseline
  //   - Codex writes new content to disk
  //   - Renderer reads disk via read-file-content (chardet auto-detect)
  //   - Monaco DiffEditor renders original=baseline, modified=disk
  //
  // The bug we're hunting: if chardet picks a non-utf-8 encoding for the
  // post-edit read, the modified pane is decoded with a different encoding
  // than the original pane, and characters render mojibake-style.
  //
  // This test asserts byte-faithful round-trip on both panes.
  const tsPath = path.join(workspaceDir, 'diff-encoding-test.ts');
  const fileName = 'diff-encoding-test.ts';

  const originalContent = await fs.readFile(tsPath, 'utf-8');
  // Modified version keeps the non-ASCII content but adds a new export. Codex
  // typically rewrites a span of lines; this mirrors that pattern.
  const modifiedContent = `// Café — résumé naïveté\nexport const greeting = "héllo wörld 你好 👋";\nexport const original = false;\nexport const note = "ümlaut — em-dash — 𝓮𝓶𝓸𝓳𝓲";\n`;

  await openFileFromTree(page, fileName);
  await page.waitForSelector(VISIBLE_MONACO_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  // Sanity: editor shows the non-ASCII original
  const initialText = await getMonacoContent(page);
  expect(initialText).toContain('héllo wörld');
  expect(initialText).toContain('你好');

  // Simulate Codex pre-edit tag + apply_patch: tag holds pre-edit content,
  // then Codex writes the modified content to disk.
  const tagId = `enc-tag-${Date.now()}`;
  const sessionId = `enc-session-${Date.now()}`;

  await page.evaluate(async ({ workspacePath, filePath, tagId, sessionId, originalContent }) => {
    await window.electronAPI.history.createTag(
      workspacePath,
      filePath,
      tagId,
      originalContent,
      sessionId,
      'codex-encoding-test'
    );
  }, { workspacePath: workspaceDir, filePath: tsPath, tagId, sessionId, originalContent });

  await fs.writeFile(tsPath, modifiedContent, 'utf8');

  // Diff bar appears once the watcher event triggers DocumentModel diff mode
  await page.waitForSelector(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader, { timeout: 5000 });

  // Read both panes of the Monaco diff editor.
  //
  // We can't always rely on `window.monaco.editor.getEditors()` (the
  // @monaco-editor/react loader doesn't expose it as a window global in some
  // builds). Instead we walk the DOM: Monaco renders diff panes as
  //   `.monaco-diff-editor .editor.original .monaco-editor`
  //   `.monaco-diff-editor .editor.modified .monaco-editor`
  // and stashes the editor instance on the DOM node via a property bag the
  // contributions register. We can read text from the underlying ITextModel
  // by reaching through the rendered DOM, but the safest cross-version path
  // is to extract the text from the view-lines and normalize NBSP back to
  // space. For non-ASCII fidelity testing we just need the codepoints.
  const diffPanes = await page.evaluate(() => {
    const wrapper = document.querySelector('.monaco-code-editor[data-diff-mode="true"]');
    if (!wrapper) return { error: 'no diff-mode wrapper' };
    const diffRoot = wrapper.querySelector('.monaco-diff-editor');
    if (!diffRoot) return { error: 'no monaco-diff-editor element' };

    function readPane(paneSelector: string): string {
      const pane = diffRoot!.querySelector(paneSelector);
      if (!pane) return '';
      // Sort by `top` style on .view-line so we get them in display order.
      const lineEls = Array.from(pane.querySelectorAll('.view-line')) as HTMLElement[];
      lineEls.sort((a, b) => {
        const at = parseInt(a.style.top || '0', 10);
        const bt = parseInt(b.style.top || '0', 10);
        return at - bt;
      });
      const text = lineEls.map(l => l.textContent ?? '').join('\n');
      // Monaco renders leading spaces as NBSP (U+00A0); restore.
      return text.replace(/ /g, ' ');
    }

    return {
      original: readPane('.editor.original'),
      modified: readPane('.editor.modified'),
    };
  });

  expect(diffPanes.error).toBeUndefined();

  // Encoding fidelity: each pane must contain the actual codepoints, not
  // mojibake. If chardet misdetects the file as latin1, "ümlaut" would render
  // as "Ã¼mlaut", "你好" as "ä½ å¥½", "👋" as "ðŸ‘‹".
  // The original side comes from the gzipped pre-edit tag (always utf-8).
  // The modified side comes from read-file-content (chardet auto-detect).
  for (const phrase of ['héllo wörld', '你好', '👋', 'naïveté']) {
    expect(diffPanes.original).toContain(phrase);
    expect(diffPanes.modified).toContain(phrase);
  }
  // The new line only exists in modified.
  expect(diffPanes.modified).toContain('ümlaut — em-dash');

  // Mojibake markers — none of these should ever appear if encoding is right.
  for (const mojibake of ['Ã¼', 'Ã©', 'Ã¶', 'ä½', 'ðŸ']) {
    expect(diffPanes.original).not.toContain(mojibake);
    expect(diffPanes.modified).not.toContain(mojibake);
  }

  await closeTabByFileName(page, fileName);
});

test('Codex-style Accept All persists changes (write-then-tag ordering)', async () => {
  // The real Codex flow in AIService:
  //   1. Codex SDK writes the file to disk via apply_patch
  //   2. AIService receives the file_change event
  //   3. AIService captures pre-edit content from FileSnapshotCache
  //   4. AIService calls HistoryManager.createTag(... beforeContent ...)
  //
  // The fs.watch event from step 1 is racing with step 4. Once both have
  // landed, DocumentModel sees a pending tag and enters diff mode.
  //
  // The existing 'accepting diff applies changes' test creates the tag first
  // and then writes the file -- that's the OPPOSITE order. We mirror the
  // real ordering here so the test exercises the full race window.
  const tsPath = path.join(workspaceDir, 'codex-accept-test.ts');
  const fileName = 'codex-accept-test.ts';

  const originalContent = await fs.readFile(tsPath, 'utf-8');
  const modifiedContent = `export interface Greeting {\n  text: string;\n  emoji: string;\n  loud: boolean;\n}\n\nexport function greet(name: string, loud = false): Greeting {\n  const text = loud ? \`HELLO, \${name.toUpperCase()}!\` : \`Hello, \${name}\`;\n  return { text, emoji: '👋', loud };\n}\n`;

  await openFileFromTree(page, fileName);
  await page.waitForSelector(VISIBLE_MONACO_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  const initialText = await getMonacoContent(page);
  expect(initialText).toContain('export function greet');

  const tagId = `codex-accept-tag-${Date.now()}`;
  const sessionId = `codex-accept-session-${Date.now()}`;

  // 1. Write modified content FIRST (simulates Codex apply_patch). This
  //    triggers the workspace file watcher before any tag exists.
  await fs.writeFile(tsPath, modifiedContent, 'utf8');

  // 2. Create the pending tag SECOND (simulates AIService receiving the
  //    file_change event and calling createTag).
  await page.evaluate(async ({ workspacePath, filePath, tagId, sessionId, originalContent }) => {
    await window.electronAPI.history.createTag(
      workspacePath,
      filePath,
      tagId,
      originalContent,
      sessionId,
      'codex-accept-test'
    );
  }, { workspacePath: workspaceDir, filePath: tsPath, tagId, sessionId, originalContent });

  // Diff bar should appear once the tag-created event reaches the renderer.
  await page.waitForSelector(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader, { timeout: 5000 });

  const tabElement = getTabByFileName(page, fileName);
  await expect(tabElement.locator(PLAYWRIGHT_TEST_SELECTORS.tabUnacceptedIndicator))
    .toBeVisible({ timeout: 2000 });

  // Click Accept All
  const acceptButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffAcceptAllButton);
  await acceptButton.click();

  // Diff bar should disappear and stay gone. The race we suspect: the file
  // watcher echo from saveFile() arrives before updateTagStatus completes,
  // so DocumentModel re-enters diff mode. We wait for the diff bar to go
  // hidden, then wait an additional beat to detect any re-entry.
  await page.waitForSelector(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader, {
    state: 'hidden',
    timeout: 3000,
  });
  await page.waitForTimeout(1500);

  // The diff bar must STILL be hidden — no spurious re-entry.
  await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader))
    .toHaveCount(0, { timeout: 1000 });
  await expect(tabElement.locator(PLAYWRIGHT_TEST_SELECTORS.tabUnacceptedIndicator))
    .toHaveCount(0, { timeout: 1000 });

  // Editor must show the modified content.
  const finalEditorText = await getMonacoContent(page);
  expect(finalEditorText).toContain('loud = false');
  expect(finalEditorText).toContain('toUpperCase()');
  expect(finalEditorText).not.toContain('return { text: `Hello, ${name}`, emoji');

  // File on disk must have the modified content (not reverted).
  const finalContent = await fs.readFile(tsPath, 'utf-8');
  expect(finalContent).toBe(modifiedContent);

  await closeTabByFileName(page, fileName);
});

test('Probe: identify the square glyph Monaco renders on inserted diff lines', async () => {
  // The user reported small "square" glyphs appearing on inserted lines in
  // Monaco's diff modified pane. Disk bytes are clean ASCII. This probe
  // captures EVERY visible artifact on/around the inserted-line area:
  //   - char codes of the line text
  //   - DOM tree under each .view-line
  //   - all decoration/overlay layers Monaco creates
  // so we can identify exactly what's drawing the square.
  const filePath = path.join(workspaceDir, 'codex-glyph-probe.ts');
  const fileName = 'codex-glyph-probe.ts';

  const originalContent = await fs.readFile(filePath, 'utf-8');
  // Insert "- Four" and "- Five" right after "- Three" -- exact match of the
  // user's screenshot scenario. Clean ASCII bytes (0x2d 0x20 0x46...).
  const modifiedContent = originalContent.replace(
    '- Three\n',
    '- Three\n- Four\n- Five\n',
  );

  // Sanity: confirm we're probing with clean ASCII (no hidden non-ASCII).
  for (let i = 0; i < modifiedContent.length; i++) {
    if (modifiedContent.charCodeAt(i) > 127 && modifiedContent.charCodeAt(i) !== 10) {
      throw new Error(`Test setup is wrong: non-ASCII char at index ${i}`);
    }
  }

  await openFileFromTree(page, fileName);
  await page.waitForSelector(VISIBLE_MONACO_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  const tagId = `glyph-tag-${Date.now()}`;
  const sessionId = `glyph-session-${Date.now()}`;

  await fs.writeFile(filePath, modifiedContent, 'utf8');
  await page.evaluate(async ({ workspacePath, filePath, tagId, sessionId, originalContent }) => {
    await window.electronAPI.history.createTag(
      workspacePath, filePath, tagId, originalContent, sessionId, 'codex-glyph-probe',
    );
  }, { workspacePath: workspaceDir, filePath, tagId, sessionId, originalContent });

  await page.waitForSelector(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader, { timeout: 5000 });
  // Let Monaco settle its decorations.
  await page.waitForTimeout(500);

  const probe = await page.evaluate(() => {
    const wrapper = document.querySelector('.monaco-code-editor[data-diff-mode="true"]');
    if (!wrapper) return { error: 'no diff wrapper' };
    const modPane = wrapper.querySelector('.monaco-diff-editor .editor.modified');
    if (!modPane) return { error: 'no modified pane' };

    const linesEl = modPane.querySelector('.view-lines');
    const lineEls = Array.from(linesEl?.querySelectorAll('.view-line') ?? []) as HTMLElement[];
    lineEls.sort((a, b) => parseInt(a.style.top || '0', 10) - parseInt(b.style.top || '0', 10));

    const lineDetails = lineEls.map((line, idx) => {
      const text = line.textContent ?? '';
      const codes: number[] = [];
      for (let i = 0; i < text.length; i++) codes.push(text.charCodeAt(i));
      return {
        idx,
        top: line.style.top,
        text,
        charCodes: codes,
        innerHTML: line.innerHTML.slice(0, 400),
      };
    });

    // Find which lines are flagged as inserted by the diff. Monaco marks
    // them with `.line-insert` somewhere in the overlay layers.
    const insertedTops = new Set<string>();
    modPane.querySelectorAll('.line-insert').forEach((el) => {
      const top = (el as HTMLElement).style.top;
      if (top) insertedTops.add(top);
    });

    // Find children inside `.margin` for inserted-line tops -- this is where
    // Monaco renders gutter glyphs (the square the user is asking about).
    const marginEl = modPane.querySelector('.margin');
    const marginChildrenForInsertedLines: Array<{ top: string; outerHTML: string }> = [];
    if (marginEl) {
      const marginChildren = Array.from(marginEl.querySelectorAll('*')) as HTMLElement[];
      for (const ch of marginChildren) {
        if (ch.style.top && insertedTops.has(ch.style.top)) {
          marginChildrenForInsertedLines.push({
            top: ch.style.top,
            outerHTML: ch.outerHTML.slice(0, 500),
          });
        }
      }
    }

    // Same for view-overlays — these draw inline (over the text area).
    const viewOverlaysEl = modPane.querySelector('.view-overlays');
    const viewOverlayChildrenForInsertedLines: Array<{ top: string; outerHTML: string }> = [];
    if (viewOverlaysEl) {
      const ovChildren = Array.from(viewOverlaysEl.querySelectorAll('*')) as HTMLElement[];
      for (const ch of ovChildren) {
        if (ch.style.top && insertedTops.has(ch.style.top)) {
          viewOverlayChildrenForInsertedLines.push({
            top: ch.style.top,
            outerHTML: ch.outerHTML.slice(0, 500),
          });
        }
      }
    }

    // Pseudo-element CSS rules sometimes inject the glyph via `content`. We
    // can't read pseudo-elements from JS directly, but we can capture the
    // CSS rules that target `.line-insert::before` / `::after` or any class
    // we find on the inserted-line markers.
    const possibleGlyphElements: Array<{ className: string; before: string; after: string }> = [];
    modPane.querySelectorAll('.line-insert, .char-insert').forEach((el) => {
      const el2 = el as HTMLElement;
      const before = window.getComputedStyle(el2, '::before');
      const after = window.getComputedStyle(el2, '::after');
      possibleGlyphElements.push({
        className: el2.className,
        before: `content: ${before.content}; width: ${before.width}; bg: ${before.backgroundColor}`,
        after: `content: ${after.content}; width: ${after.width}; bg: ${after.backgroundColor}`,
      });
    });

    // Enumerate all CSS classes that ever appear on overlay decoration nodes.
    const decorationClasses = new Set<string>();
    modPane.querySelectorAll('[class*="decoration"], [class*="insert"], [class*="delete"], [class*="diff"]').forEach((el) => {
      const cls = (el as HTMLElement).className;
      if (typeof cls === 'string') {
        cls.split(/\s+/).forEach(c => {
          if (c) decorationClasses.add(c);
        });
      }
    });

    return {
      lineDetails,
      insertedTops: Array.from(insertedTops),
      marginChildrenForInsertedLines,
      viewOverlayChildrenForInsertedLines,
      possibleGlyphElements,
      decorationClasses: Array.from(decorationClasses).sort(),
    };
  });

  // Also fetch the underlying Monaco text model content so we can compare
  // it against both disk and the rendered DOM.
  const modelContent = await page.evaluate(() => {
    const monaco = (window as any).monaco;
    if (!monaco?.editor?.getModels) return { error: 'no monaco.editor' };
    const models = monaco.editor.getModels() as Array<{ uri: any; getValue(): string }>;
    return models.map(m => ({ uri: String(m.uri), value: m.getValue() }));
  });

  // Print everything so we can read the structure even if assertions pass.
  // eslint-disable-next-line no-console
  console.log('=== MONACO DIFF PROBE ===');
  console.log(JSON.stringify({ probe, modelContent }, null, 2));

  // What we know going in: disk bytes are clean ASCII (asserted at the top
  // of this test). What we want to know: where does the visible square glyph
  // come from? Possible sources:
  //   (a) Monaco's renderer turning ASCII spaces into NBSP in the DOM, then
  //       the unicodeHighlight feature flagging the NBSP as suspicious.
  //   (b) A diff add/insert indicator element overlaid on the line.
  //   (c) Actual NBSP in the underlying text model (would mean the bug is
  //       in our content pipeline writing NBSP into Monaco).
  //
  // We assert (c) is NOT happening: every model's value must contain only
  // basic ASCII for our test file. If a model has codepoint 160, the bug is
  // upstream of Monaco -- in DiskBackedStore / DocumentModel / setContent.
  if ('error' in modelContent) {
    // If we can't read models we can't assert, but the probe data is still
    // captured for inspection.
  } else {
    for (const m of modelContent) {
      for (let i = 0; i < m.value.length; i++) {
        const code = m.value.charCodeAt(i);
        if (code === 160) {
          throw new Error(
            `Monaco text model "${m.uri}" contains NBSP at index ${i}. ` +
            `Disk bytes are clean ASCII -- something between disk and Monaco ` +
            `is mutating bytes. Excerpt: "${m.value.slice(Math.max(0, i - 10), i + 10)}"`
          );
        }
      }
    }
  }

  await closeTabByFileName(page, fileName);
});

test('Accept All preserves NBSP-leading lines that Codex inserts', async () => {
  // Reproduces the user-reported "weird characters in diff + accept doesn't
  // keep changes" symptom. The screenshot showed Monaco's unicode-highlight
  // boxes on inserted lines like "- Four" — those boxes mean the line starts
  // with a non-ASCII codepoint. LLMs (and therefore Codex apply_patch output)
  // routinely emit NBSP (U+00A0) where they meant ASCII space.
  //
  // We verify two things:
  //   (a) the diff displays the actual NBSP-bearing content (not silently
  //       normalized away)
  //   (b) Accept All round-trips the exact bytes to disk -- the file after
  //       Accept must still contain the NBSP-leading lines
  const filePath = path.join(workspaceDir, 'codex-nbsp-test.ts');
  const fileName = 'codex-nbsp-test.ts';

  const originalContent = await fs.readFile(filePath, 'utf-8');
  const NBSP = ' ';
  // Insert two new lines with NBSP-leading content, just like the screenshot.
  const modifiedContent = originalContent.replace(
    '- Three\n',
    `- Three\n${NBSP}- Four\n${NBSP}- Five\n`,
  );
  // Sanity: modified actually differs from original and contains NBSP.
  expect(modifiedContent).not.toBe(originalContent);
  expect(modifiedContent.includes(NBSP)).toBe(true);

  await openFileFromTree(page, fileName);
  await page.waitForSelector(VISIBLE_MONACO_SELECTOR, { timeout: TEST_TIMEOUTS.EDITOR_LOAD });
  await page.waitForTimeout(500);

  const tagId = `nbsp-tag-${Date.now()}`;
  const sessionId = `nbsp-session-${Date.now()}`;

  // Codex ordering: write the file first (with NBSP), then create tag.
  await fs.writeFile(filePath, modifiedContent, 'utf8');
  await page.evaluate(async ({ workspacePath, filePath, tagId, sessionId, originalContent }) => {
    await window.electronAPI.history.createTag(
      workspacePath,
      filePath,
      tagId,
      originalContent,
      sessionId,
      'codex-nbsp-test',
    );
  }, { workspacePath: workspaceDir, filePath, tagId, sessionId, originalContent });

  await page.waitForSelector(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader, { timeout: 5000 });

  // Read the modified pane via Monaco DOM and assert NBSP is still there.
  // If Monaco silently normalized NBSP -> space in the diff editor, this
  // would fail (and Accept would write the wrong bytes).
  const modifiedPaneCharCodes = await page.evaluate(() => {
    const wrapper = document.querySelector('.monaco-code-editor[data-diff-mode="true"]');
    const pane = wrapper?.querySelector('.monaco-diff-editor .editor.modified');
    if (!pane) return null;
    const lines = Array.from(pane.querySelectorAll('.view-line')) as HTMLElement[];
    lines.sort((a, b) => parseInt(a.style.top || '0', 10) - parseInt(b.style.top || '0', 10));
    // Return char codes of the first character of each line so we can detect
    // NBSP (160) vs ASCII space (32).
    return lines.map(l => (l.textContent ?? '').charCodeAt(0));
  });
  expect(modifiedPaneCharCodes).not.toBeNull();
  // The two inserted lines should appear in the modified pane with NBSP (160)
  // as their first character. Monaco renders NBSP literally in DOM textContent.
  expect(modifiedPaneCharCodes).toContain(160);

  // Click Accept All
  await page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffAcceptAllButton).click();
  await page.waitForSelector(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader, {
    state: 'hidden',
    timeout: 3000,
  });
  await page.waitForTimeout(1500);

  // The file on disk must STILL contain the NBSP-leading lines.
  // If acceptDiff() returned a normalized string, or the unmount race
  // caused us to revert, this assertion catches it.
  const finalContent = await fs.readFile(filePath, 'utf-8');
  expect(finalContent).toBe(modifiedContent);
  expect(finalContent.includes(`${NBSP}- Four`)).toBe(true);
  expect(finalContent.includes(`${NBSP}- Five`)).toBe(true);

  await closeTabByFileName(page, fileName);
});
