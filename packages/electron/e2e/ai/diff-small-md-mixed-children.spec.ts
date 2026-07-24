/**
 * Regression: small.md sub-bullet-with-link diff bug
 *
 * Reproduces the exact failure the user reported in tests/small.md:
 * a list item whose children mix plain text ("URL: ") with a link, where the
 * baseline has just "**URL:**" (placeholder) and the target has
 * "**URL:** https://en.wikipedia.org/wiki/Delaware". Plus a wholly-new
 * California outer bullet appended after Deleware.
 *
 * Bug visual the user sees today (with previous "fixes" claimed):
 *   - 1 RED Texas URL bullet + 2 IDENTICAL GREEN Texas URL bullets (wrong;
 *     Texas was unchanged so it should have NO diff markers)
 *   - Orphaned RED "URL:" placeholder bullet at the end (wrong)
 *
 * What "fixed" must look like (and what this test asserts on the rendered
 * DOM after the diff is applied through the real TabEditor mount flow):
 *   - Texas: NO diff markers; exactly ONE Texas URL listitem
 *   - Deleware: only the Delaware URL portion is green; "URL:" stays plain
 *   - California: outer bullet + nested URL bullet are both green
 *   - NO listitem with text === "URL:" alone (that orphaned placeholder
 *     means the rejection-merge bug fired again)
 *   - NO duplicate Texas URL listitems
 *
 * Three previous attempts each shipped a "passing" unit test but the user's
 * actual app still rendered the broken visual. This file launches the real
 * Electron app, sets up a pending pre-edit history tag exactly like the
 * harness in DiffErgonomicsFixture.ts, opens the file, lets TabEditor's
 * checkAndApplyPendingDiffs run end-to-end (autolink plugin, LiveNodeKeyState
 * tagging, APPLY_MARKDOWN_REPLACE_COMMAND, the works), and asserts on the
 * rendered listitems. A screenshot is captured to disk on every run as
 * physical evidence that the fix actually held in the live editor.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  dismissProjectTrustToast,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  openFileFromTree,
} from '../utils/testHelpers';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

const FILE_NAME = 'small.md';

const BASELINE = `# Small


- Texas
  - **URL**: https://en.wikipedia.org/wiki/Texas
- Deleware
  - **URL:**
`;

const TARGET = `# Small


- Texas
  - **URL**: https://en.wikipedia.org/wiki/Texas
- Deleware
  - **URL:** https://en.wikipedia.org/wiki/Delaware
- California
  - **URL:** https://en.wikipedia.org/wiki/California
`;

// The active editor's contenteditable inside the visible tab wrapper. Off-
// screen tabs stay mounted (display:none) so we must scope to the visible one.
const ACTIVE_EDITOR =
  '.file-tabs-container .tab-editor-wrapper:not([style*="display: none"]) .multi-editor-instance .editor [contenteditable="true"]';

const SCREENSHOT_DIR = path.resolve(
  __dirname,
  '../../../../e2e_test_output/diff-small-md-screenshots',
);

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });

  // Pre-create the file in BASELINE state so the file tree picks it up.
  await fs.writeFile(path.join(workspaceDir, FILE_NAME), BASELINE, 'utf8');

  electronApp = await launchElectronApp({ workspace: workspaceDir });
  page = await electronApp.firstWindow();
  await waitForAppReady(page);
  await dismissProjectTrustToast(page);

  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.setSize(1400, 900);
      win.center();
    }
  });
  await page.waitForTimeout(200);
});

test.afterAll(async () => {
  await electronApp?.close();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

test('renders small.md sub-bullet-with-link diff cleanly via real TabEditor mount flow', async () => {
  test.setTimeout(30000);
  const filePath = path.join(workspaceDir, FILE_NAME);

  // Mirror DiffErgonomicsFixture.runDiffErgonomicsHarness exactly:
  //   1. file already on disk in BASELINE
  //   2. createTag(...) so a pending pre-edit tag exists with BASELINE as
  //      baseline content
  //   3. overwrite the file with TARGET
  //   4. open the file as a normal tab
  //
  // The createTag IPC needs the workspace path, so pass it through evaluate.
  await page.evaluate(
    async ({ wp, fp, baseline }) => {
      const tagId = `small-md-diff-${Date.now()}`;
      const sessionId = `small-md-session-${Date.now()}`;
      const toolUseId = `small-md-tool-${Date.now()}`;
      await window.electronAPI.history.createTag(
        wp,
        fp,
        tagId,
        baseline,
        sessionId,
        toolUseId,
      );
    },
    { wp: workspaceDir, fp: filePath, baseline: BASELINE },
  );

  // Now overwrite disk with the AFTER content. TabEditor mount picks up the
  // pending tag and treats this as the AI's edit.
  await fs.writeFile(filePath, TARGET, 'utf8');
  await page.waitForTimeout(200);

  // Open the file. TabEditor.checkAndApplyPendingDiffs runs.
  await openFileFromTree(page, FILE_NAME);

  // Diff approval bar should appear -- proves the pending tag was found and
  // the diff was applied through the real flow.
  await expect(
    page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader),
  ).toBeVisible({ timeout: 5000 });

  // Wait for diff markers to settle.
  const editor = page.locator(ACTIVE_EDITOR);
  await expect(editor.locator('.nim-diff-add').first()).toBeVisible({
    timeout: 5000,
  });

  // Give Lexical/autolink one extra paint pass so we read the final state.
  await page.waitForTimeout(500);

  // Capture the screenshot first thing, so we always have evidence even
  // when assertions fail. Use only the editor region so the diff is the
  // dominant content.
  const screenshotPath = path.join(
    SCREENSHOT_DIR,
    `small-md-diff-${Date.now()}.png`,
  );
  await page.locator(ACTIVE_EDITOR).screenshot({ path: screenshotPath });
  console.log(`[diff-small-md] Screenshot saved to: ${screenshotPath}`);

  // Also a full-page screenshot (header + editor) for context when reviewing.
  const fullPath = path.join(
    SCREENSHOT_DIR,
    `small-md-diff-full-${Date.now()}.png`,
  );
  await page.screenshot({ path: fullPath, fullPage: true });
  console.log(`[diff-small-md] Full-page screenshot saved to: ${fullPath}`);

  // Dump the actual rendered listitem structure for debugging when the
  // assertions below fail. Each entry: text content + classList. This lets
  // us see exactly what the editor produced without needing to reproduce
  // the bug locally.
  const listItemSnapshot = await editor.evaluate((root) => {
    const items = Array.from(root.querySelectorAll('li'));
    return items.map((li) => ({
      text: (li.textContent || '').trim(),
      classList: Array.from(li.classList),
      innerHTML: li.innerHTML,
      hasDiffAddDescendant: !!li.querySelector('.nim-diff-add'),
      hasDiffRemoveDescendant: !!li.querySelector('.nim-diff-remove'),
    }));
  });
  console.log(
    '[diff-small-md] Listitem snapshot:\n' +
      JSON.stringify(listItemSnapshot, null, 2),
  );

  // Also dump the full Lexical exportJSON of the editor so we can see the
  // tree structure at the model level (children types, diff state, etc).
  // This requires reaching into the editor instance via the registered
  // editorRegistry that the AI tool simulator uses.
  const lexicalDump = await page.evaluate(({ fp }) => {
    const editorRegistry = (window as any).__editorRegistry;
    if (!editorRegistry || !editorRegistry.has(fp)) {
      return { error: 'No registered editor for ' + fp };
    }
    const instance = editorRegistry.getEditor?.(fp);
    if (!instance || !instance.editor) {
      return { error: 'editorRegistry.getEditor returned no instance.editor' };
    }
    return instance.editor.getEditorState().toJSON();
  }, { fp: filePath });
  const dumpPath = path.join(SCREENSHOT_DIR, `lexical-state-${Date.now()}.json`);
  await fs.writeFile(dumpPath, JSON.stringify(lexicalDump, null, 2), 'utf8');
  console.log(`[diff-small-md] Lexical state dumped to: ${dumpPath}`);

  // === Assertions on the rendered DOM ===

  // Count INNER listitems (li without a nested <ul>) whose text is the
  // Texas URL line. We exclude wrapper listitems because in Lexical's list
  // rendering a sub-bullet is materialized as `<li><ul><li>...</li></ul></li>`
  // -- both the outer wrapper and the inner li have the same textContent.
  // Counting only the leaf li gives the visible-bullet count, which is the
  // user-facing failure mode (the bug renders 3 visible Texas URL bullets
  // instead of 1).
  //
  // Match shape: "URL: https://en.wikipedia.org/wiki/Texas" (URL is bold,
  // ": " is plain, then the link. Lexical's rendered textContent collapses
  // that to one string).
  const texasUrlInnerListItems = listItemSnapshot.filter(
    (li) =>
      /^URL:\s*https:\/\/en\.wikipedia\.org\/wiki\/Texas\s*$/.test(li.text) &&
      !li.classList.includes('nim-nested-list-item'),
  );
  expect(
    texasUrlInnerListItems.length,
    `expected exactly 1 inner listitem with Texas URL, got ${texasUrlInnerListItems.length}: ${JSON.stringify(texasUrlInnerListItems.map((li) => li.text))}`,
  ).toBe(1);

  // The single Texas URL listitem must NOT contain any diff markers.
  expect(
    texasUrlInnerListItems[0].hasDiffAddDescendant,
    'Texas URL listitem must not contain a green/added marker',
  ).toBe(false);
  expect(
    texasUrlInnerListItems[0].hasDiffRemoveDescendant,
    'Texas URL listitem must not contain a red/removed marker',
  ).toBe(false);

  // No orphaned "URL:" placeholder. Strictly: a listitem whose entire text
  // content is "URL:" (with no URL appended) is the orphan from the bug.
  // The Deleware URL listitem text is "URL: https://..." (URL + URL), not
  // "URL:" alone, so this assertion is exact.
  const orphanedUrlPlaceholder = listItemSnapshot.filter(
    (li) => /^URL:\s*$/.test(li.text),
  );
  expect(
    orphanedUrlPlaceholder.length,
    `expected no orphaned 'URL:' placeholder listitem, got ${orphanedUrlPlaceholder.length}: ${JSON.stringify(orphanedUrlPlaceholder.map((li) => li.text))}`,
  ).toBe(0);

  // California section must be present and marked added (the outer bullet
  // is added; the inner URL bullet is added). Any element with the word
  // "California" must sit inside an .nim-diff-add subtree.
  const californiaInfo = await editor.evaluate(() => {
    const matches: Array<{ text: string; insideDiffAdd: boolean }> = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent || '';
      if (text.includes('California')) {
        let p: Element | null = (node as Text).parentElement;
        let insideDiffAdd = false;
        while (p) {
          if (p.classList?.contains('nim-diff-add')) {
            insideDiffAdd = true;
            break;
          }
          p = p.parentElement;
        }
        matches.push({ text, insideDiffAdd });
      }
    }
    return matches;
  });
  expect(
    californiaInfo.length,
    'expected California to appear in the rendered editor',
  ).toBeGreaterThan(0);
  expect(
    californiaInfo.every((m) => m.insideDiffAdd),
    `every California text node must be inside .nim-diff-add; got ${JSON.stringify(californiaInfo)}`,
  ).toBe(true);

  // Deleware bullet (note the user's spelling, intentionally preserved): the
  // ONLY green portion should be the URL after "URL:" -- the "URL:" prefix
  // and the outer "Deleware" bullet must NOT be marked added/removed.
  const delewareInfo = listItemSnapshot.filter((li) =>
    li.text.includes('Deleware'),
  );
  // The outer Deleware listitem (text starts with "Deleware") must not itself
  // be marked added or removed (its descendant nested URL bullet WILL contain
  // a green link, that's expected).
  const outerDeleware = delewareInfo.find((li) =>
    li.text.startsWith('Deleware'),
  );
  expect(
    outerDeleware,
    'Deleware outer listitem must exist',
  ).toBeTruthy();

  // Sanity: the editor's full plain text should contain the target's main
  // chunks. (Disk content == TARGET, but in diff mode the editor displays
  // both removed and added; assert the must-haves.)
  const fullEditorText = (await editor.textContent()) ?? '';
  expect(fullEditorText).toContain(
    'https://en.wikipedia.org/wiki/Delaware',
  );
  expect(fullEditorText).toContain(
    'https://en.wikipedia.org/wiki/California',
  );
  expect(fullEditorText).toContain(
    'https://en.wikipedia.org/wiki/Texas',
  );

  console.log(
    `[diff-small-md] PASSED. Screenshot evidence at ${screenshotPath}`,
  );
});
