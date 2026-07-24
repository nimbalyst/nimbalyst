/**
 * Visual Diff Rendering E2E Tests
 *
 * These tests verify that when an AI edit triggers diff mode, the Lexical
 * editor actually renders red/green markers (not just the diff approval
 * header). The existing diff.spec.ts tests primarily assert on the header
 * and final accepted content -- they did not catch a regression where the
 * header showed but the in-document red/green visualization was missing.
 *
 * What we assert here:
 *   - `.nim-diff-add` elements exist in the active editor and contain new text
 *   - `.nim-diff-remove` elements exist and contain old text
 *   - Computed background colors are non-transparent (theme variable applied)
 *   - Pure-add edits produce only `.nim-diff-add`; pure-removes only
 *     `.nim-diff-remove`
 *   - Markers clear after Accept All
 *
 * This is intentionally a separate file from diff.spec.ts so it launches
 * its own Electron instance (one-file-per-command rule) and runs fast.
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
  simulateApplyDiff,
  setupAIApiForTesting,
  waitForEditorReady,
} from '../utils/aiToolSimulator';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  openFileFromTree,
  closeTabByFileName,
} from '../utils/testHelpers';

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

const FILE_NAME = 'visual-diff.md';
const ORIGINAL_CONTENT = `# Visual Diff Test

This is the first paragraph.

This is the second paragraph.
`;

// Off-screen tabs stay mounted (display:none on the wrapper) so we must
// scope every diff-class query to the active wrapper only.
const ACTIVE_EDITOR_LOCATOR =
  '.file-tabs-container .tab-editor-wrapper:not([style*="display: none"]) .multi-editor-instance .editor';

async function resetFile(filePath: string, content: string) {
  await fs.writeFile(filePath, content, 'utf8');
}

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();
  await fs.writeFile(path.join(workspaceDir, FILE_NAME), ORIGINAL_CONTENT, 'utf8');

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

test.describe('Visual Diff Rendering', () => {
  test('renders red/green markers for an inline paragraph replacement', async () => {
    const filePath = path.join(workspaceDir, FILE_NAME);
    await resetFile(filePath, ORIGINAL_CONTENT);

    await openFileFromTree(page, FILE_NAME);
    await waitForEditorReady(page);
    await setupAIApiForTesting(page);

    const result = await simulateApplyDiff(page, filePath, [
      { oldText: 'This is the first paragraph.', newText: 'FIRST PARAGRAPH WAS REPLACED.' },
    ]);
    expect(result.success).toBe(true);

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible({ timeout: 3000 });

    const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);

    // The word-level (LCS) diff splits adjacent inserted words / spaces /
    // punctuation into multiple add markers and likewise for removes -- assert
    // on text content rather than exact marker count.
    await expect(activeEditor.locator('.nim-diff-add').first()).toBeVisible({ timeout: 3000 });
    await expect(activeEditor.locator('.nim-diff-remove').first()).toBeVisible({ timeout: 3000 });

    const addText = (await activeEditor.locator('.nim-diff-add').allTextContents()).join(' ');
    expect(addText).toContain('FIRST PARAGRAPH WAS REPLACED');

    const removeText = (await activeEditor.locator('.nim-diff-remove').allTextContents()).join(' ');
    expect(removeText).toContain('This is the first paragraph');

    // Verify the rendered background actually inherits the theme variable.
    // We don't hardcode rgb (dark/light differ) - just that something is set.
    const addBg = await activeEditor.locator('.nim-diff-add').first().evaluate((el) => {
      return getComputedStyle(el).backgroundColor;
    });
    const removeBg = await activeEditor.locator('.nim-diff-remove').first().evaluate((el) => {
      return getComputedStyle(el).backgroundColor;
    });
    expect(addBg).not.toBe('rgba(0, 0, 0, 0)');
    expect(addBg).not.toBe('transparent');
    expect(removeBg).not.toBe('rgba(0, 0, 0, 0)');
    expect(removeBg).not.toBe('transparent');

    await closeTabByFileName(page, FILE_NAME);
  });

  test('renders only green markers for a pure addition (new paragraph)', async () => {
    const filePath = path.join(workspaceDir, FILE_NAME);
    await resetFile(filePath, ORIGINAL_CONTENT);

    await openFileFromTree(page, FILE_NAME);
    await waitForEditorReady(page);

    const result = await simulateApplyDiff(page, filePath, [
      {
        oldText: 'This is the second paragraph.\n',
        newText: 'This is the second paragraph.\n\nThis is a brand new paragraph added by AI.\n',
      },
    ]);
    expect(result.success).toBe(true);

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible({ timeout: 3000 });

    const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);

    // Pure addition - one logical change group (the new paragraph) but the
    // structural diff may also mark the empty spacer paragraph as added, so
    // we assert at least 1 add marker rather than exactly 1.
    await expect(activeEditor.locator('.nim-diff-add').first()).toBeVisible({ timeout: 3000 });
    const addCount = await activeEditor.locator('.nim-diff-add').count();
    expect(addCount).toBeGreaterThanOrEqual(1);
    // Pure addition - nothing was removed
    await expect(activeEditor.locator('.nim-diff-remove')).toHaveCount(0);

    const addTexts = (await activeEditor.locator('.nim-diff-add').allTextContents()).join(' ');
    expect(addTexts).toContain('brand new paragraph added by AI');

    await closeTabByFileName(page, FILE_NAME);
  });

  test('renders only red markers for a pure deletion (paragraph removed)', async () => {
    const filePath = path.join(workspaceDir, FILE_NAME);
    const startContent = `# Visual Diff Test

This is the first paragraph.

This is the second paragraph.

This paragraph will be deleted.
`;
    await resetFile(filePath, startContent);

    await openFileFromTree(page, FILE_NAME);
    await waitForEditorReady(page);

    const result = await simulateApplyDiff(page, filePath, [
      {
        oldText: '\n\nThis paragraph will be deleted.\n',
        newText: '\n',
      },
    ]);
    expect(result.success).toBe(true);

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible({ timeout: 3000 });

    const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);

    // Pure deletion - one logical change group but structural diff may mark
    // an adjacent empty paragraph as also removed, so assert >= 1.
    await expect(activeEditor.locator('.nim-diff-remove').first()).toBeVisible({ timeout: 3000 });
    const removeCount = await activeEditor.locator('.nim-diff-remove').count();
    expect(removeCount).toBeGreaterThanOrEqual(1);
    await expect(activeEditor.locator('.nim-diff-add')).toHaveCount(0);

    const removeTexts = (await activeEditor.locator('.nim-diff-remove').allTextContents()).join(' ');
    expect(removeTexts).toContain('This paragraph will be deleted');

    await closeTabByFileName(page, FILE_NAME);
  });

  test('renders multiple add/remove markers for separate edits in one batch', async () => {
    const filePath = path.join(workspaceDir, FILE_NAME);
    await resetFile(filePath, ORIGINAL_CONTENT);

    await openFileFromTree(page, FILE_NAME);
    await waitForEditorReady(page);

    const result = await simulateApplyDiff(page, filePath, [
      { oldText: 'This is the first paragraph.', newText: 'NEW FIRST PARAGRAPH.' },
      { oldText: 'This is the second paragraph.', newText: 'NEW SECOND PARAGRAPH.' },
    ]);
    expect(result.success).toBe(true);

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible({ timeout: 3000 });

    const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);

    // Two paragraphs replaced -> at least two add markers and two remove
    // markers. Structural diff may add more if adjacent empty paragraphs
    // are also marked, so we check >=2 and verify content via text.
    await expect(activeEditor.locator('.nim-diff-add').first()).toBeVisible({ timeout: 3000 });
    await expect(activeEditor.locator('.nim-diff-remove').first()).toBeVisible({ timeout: 3000 });
    const addCount = await activeEditor.locator('.nim-diff-add').count();
    const removeCount = await activeEditor.locator('.nim-diff-remove').count();
    expect(addCount).toBeGreaterThanOrEqual(2);
    expect(removeCount).toBeGreaterThanOrEqual(2);

    const addTexts = (await activeEditor.locator('.nim-diff-add').allTextContents()).join(' ');
    expect(addTexts).toContain('NEW FIRST PARAGRAPH');
    expect(addTexts).toContain('NEW SECOND PARAGRAPH');

    const removeTexts = (await activeEditor.locator('.nim-diff-remove').allTextContents()).join(' ');
    expect(removeTexts).toContain('This is the first paragraph');
    expect(removeTexts).toContain('This is the second paragraph');

    await closeTabByFileName(page, FILE_NAME);
  });

  test('renders red/green markers inside a list edit', async () => {
    const filePath = path.join(workspaceDir, FILE_NAME);
    const listContent = `# Shopping List

- Apples
- Bananas
- Oranges
`;
    await resetFile(filePath, listContent);

    await openFileFromTree(page, FILE_NAME);
    await waitForEditorReady(page);

    const result = await simulateApplyDiff(page, filePath, [
      { oldText: '- Bananas', newText: '- Plantains' },
    ]);
    expect(result.success).toBe(true);

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible({ timeout: 3000 });

    const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);

    await expect(activeEditor.locator('.nim-diff-add').first()).toBeVisible({ timeout: 3000 });
    await expect(activeEditor.locator('.nim-diff-remove').first()).toBeVisible({ timeout: 3000 });

    const addText = (await activeEditor.locator('.nim-diff-add').allTextContents()).join(' ');
    expect(addText).toContain('Plantains');

    const removeText = (await activeEditor.locator('.nim-diff-remove').allTextContents()).join(' ');
    expect(removeText).toContain('Bananas');

    await closeTabByFileName(page, FILE_NAME);
  });

  test('clears red/green markers after Accept All', async () => {
    const filePath = path.join(workspaceDir, FILE_NAME);
    await resetFile(filePath, ORIGINAL_CONTENT);

    await openFileFromTree(page, FILE_NAME);
    await waitForEditorReady(page);

    const result = await simulateApplyDiff(page, filePath, [
      { oldText: 'This is the second paragraph.', newText: 'SECOND PARAGRAPH WAS REPLACED.' },
    ]);
    expect(result.success).toBe(true);

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible({ timeout: 3000 });

    const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);

    await expect(activeEditor.locator('.nim-diff-add').first()).toBeVisible({ timeout: 3000 });

    await page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffAcceptAllButton).click();

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).not.toBeVisible({ timeout: 3000 });
    await expect(activeEditor.locator('.nim-diff-add')).toHaveCount(0, { timeout: 2000 });
    await expect(activeEditor.locator('.nim-diff-remove')).toHaveCount(0, { timeout: 2000 });

    await closeTabByFileName(page, FILE_NAME);
  });
});

test.describe('Visual Diff Rendering - Reject Path', () => {
  test('clears all red/green markers after Reject All', async () => {
    const filePath = path.join(workspaceDir, FILE_NAME);
    await resetFile(filePath, ORIGINAL_CONTENT);

    await openFileFromTree(page, FILE_NAME);
    await waitForEditorReady(page);
    await setupAIApiForTesting(page);

    const result = await simulateApplyDiff(page, filePath, [
      { oldText: 'This is the first paragraph.', newText: 'REJECTED FIRST PARAGRAPH.' },
      { oldText: 'This is the second paragraph.', newText: 'REJECTED SECOND PARAGRAPH.' },
    ]);
    expect(result.success).toBe(true);

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible({ timeout: 3000 });

    const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);
    await expect(activeEditor.locator('.nim-diff-add').first()).toBeVisible({ timeout: 3000 });
    await expect(activeEditor.locator('.nim-diff-remove').first()).toBeVisible({ timeout: 3000 });

    await page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffRejectAllButton).click();

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).not.toBeVisible({ timeout: 3000 });
    await expect(activeEditor.locator('.nim-diff-add')).toHaveCount(0, { timeout: 2000 });
    await expect(activeEditor.locator('.nim-diff-remove')).toHaveCount(0, { timeout: 2000 });

    // Original text should still be present (rejection preserves baseline)
    const editorText = await activeEditor.textContent();
    expect(editorText).toContain('This is the first paragraph');
    expect(editorText).toContain('This is the second paragraph');
    expect(editorText).not.toContain('REJECTED');

    await closeTabByFileName(page, FILE_NAME);
  });

  test('per-group reject reduces change count and removes one marker pair', async () => {
    const filePath = path.join(workspaceDir, FILE_NAME);
    await resetFile(filePath, ORIGINAL_CONTENT);

    await openFileFromTree(page, FILE_NAME);
    await waitForEditorReady(page);

    const result = await simulateApplyDiff(page, filePath, [
      { oldText: 'This is the first paragraph.', newText: 'NEW ALPHA PARAGRAPH.' },
      { oldText: 'This is the second paragraph.', newText: 'NEW BRAVO PARAGRAPH.' },
    ]);
    expect(result.success).toBe(true);

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible({ timeout: 3000 });

    const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);
    await expect(activeEditor.locator('.nim-diff-add').first()).toBeVisible({ timeout: 3000 });

    const addsBefore = await activeEditor.locator('.nim-diff-add').count();
    const removesBefore = await activeEditor.locator('.nim-diff-remove').count();
    expect(addsBefore).toBeGreaterThanOrEqual(2);
    expect(removesBefore).toBeGreaterThanOrEqual(2);

    // Word-level (LCS) diff splits a single paragraph replacement into
    // multiple change groups (one per inserted word, separated by equal
    // whitespace). So the counter shows many groups, and per-group reject
    // only removes ONE chunk -- not the whole paragraph's replacement.
    const counter = page.locator(PLAYWRIGHT_TEST_SELECTORS.diffChangeCounter);
    const initialCounterText = (await counter.textContent()) ?? '';
    if (!initialCounterText.includes('of')) {
      await page.locator('button[aria-label="Next change"]').click();
      await page.waitForTimeout(150);
    }
    await expect(counter).toContainText('of');
    const totalGroupsMatch = ((await counter.textContent()) ?? '').match(/of (\d+)/);
    const initialGroupCount = totalGroupsMatch ? Number(totalGroupsMatch[1]) : 0;
    expect(initialGroupCount).toBeGreaterThanOrEqual(2);

    await page.locator(PLAYWRIGHT_TEST_SELECTORS.diffRejectButton).first().click();
    await page.waitForTimeout(300);

    // Counter total drops by at least one
    await expect(counter).toContainText(`of ${initialGroupCount - 1}`);

    // Marker counts drop too; the bulk of both replacements survive (each
    // paragraph contributes multiple change groups, so a single reject only
    // pulls one piece out).
    const addsAfter = await activeEditor.locator('.nim-diff-add').count();
    const removesAfter = await activeEditor.locator('.nim-diff-remove').count();
    expect(addsAfter).toBeLessThan(addsBefore);
    expect(addsAfter).toBeGreaterThanOrEqual(1);
    expect(removesAfter).toBeLessThanOrEqual(removesBefore);

    // Both paragraphs should still contribute SOMETHING -- the per-group
    // reject is granular, not all-or-nothing per paragraph.
    const remainingAddText = (await activeEditor.locator('.nim-diff-add').allTextContents()).join(' ');
    expect(remainingAddText.length).toBeGreaterThan(0);

    await closeTabByFileName(page, FILE_NAME);
  });

  test('reject then a fresh AI edit re-renders new red/green markers', async () => {
    const filePath = path.join(workspaceDir, FILE_NAME);
    await resetFile(filePath, ORIGINAL_CONTENT);

    await openFileFromTree(page, FILE_NAME);
    await waitForEditorReady(page);

    // First edit -> reject all
    const firstResult = await simulateApplyDiff(page, filePath, [
      { oldText: 'This is the first paragraph.', newText: 'FIRST ATTEMPT.' },
    ]);
    expect(firstResult.success).toBe(true);

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible({ timeout: 3000 });
    const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);
    await expect(activeEditor.locator('.nim-diff-add').first()).toBeVisible({ timeout: 3000 });

    await page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffRejectAllButton).click();
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).not.toBeVisible({ timeout: 3000 });
    await expect(activeEditor.locator('.nim-diff-add')).toHaveCount(0, { timeout: 2000 });

    // Second AI edit on the same baseline should produce new markers
    const secondResult = await simulateApplyDiff(page, filePath, [
      { oldText: 'This is the first paragraph.', newText: 'SECOND ATTEMPT.' },
    ]);
    expect(secondResult.success).toBe(true);

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible({ timeout: 3000 });
    await expect(activeEditor.locator('.nim-diff-add').first()).toBeVisible({ timeout: 3000 });

    const addText = (await activeEditor.locator('.nim-diff-add').allTextContents()).join(' ');
    const removeText = (await activeEditor.locator('.nim-diff-remove').allTextContents()).join(' ');
    expect(addText).toContain('SECOND ATTEMPT');
    expect(addText).not.toContain('FIRST ATTEMPT');
    expect(removeText).toContain('This is the first paragraph');

    await closeTabByFileName(page, FILE_NAME);
  });
});

test.describe('Visual Diff Rendering - Fragile Node Types', () => {
  const TABLE_FILE = 'visual-diff-table.md';
  const CODE_FILE = 'visual-diff-code.md';
  const HEADING_FILE = 'visual-diff-heading.md';
  const FRONTMATTER_FILE = 'visual-diff-frontmatter.md';
  const FORMATTED_BULLET_FILE = 'visual-diff-formatted-bullet.md';

  test.beforeAll(async () => {
    // Pre-create files so the file tree picks them up before each test opens them
    await fs.writeFile(
      path.join(workspaceDir, FORMATTED_BULLET_FILE),
      `# Formatted Bullet\n\n- **Test Bullet:** This is a bullet and the middle stays the same\n- **Other Item:** unrelated\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(workspaceDir, TABLE_FILE),
      `# Table Test\n\n| Name | Score |\n|------|-------|\n| Alice | 90 |\n| Bob | 85 |\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(workspaceDir, CODE_FILE),
      `# Code Test\n\n\`\`\`javascript\nfunction greet() {\n  return "hello";\n}\n\`\`\`\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(workspaceDir, HEADING_FILE),
      `# Original Heading\n\nA paragraph beneath the heading.\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(workspaceDir, FRONTMATTER_FILE),
      `---\ntitle: Original Title\nauthor: Greg\n---\n\n# Document Body\n\nBody text stays the same.\n`,
      'utf8',
    );
  });

  // Bullet items with leading **bold** formatting are a common shape in real
  // docs (persona files, style guides, "key: value" lists). Before the
  // diffWords LCS fix, the diff engine flattened the entire old bullet into
  // one <strong> remove and rebuilt the new bullet from scratch -- the
  // unchanged middle text would show up in BOTH add and remove regions. This
  // test pins the granular-diff behavior for that shape.
  test('bullet with **bold** prefix produces intra-text diff, not whole-line replacement', async () => {
    const filePath = path.join(workspaceDir, FORMATTED_BULLET_FILE);
    await fs.writeFile(
      filePath,
      `# Formatted Bullet\n\n- **Test Bullet:** This is a bullet and the middle stays the same\n- **Other Item:** unrelated\n`,
      'utf8',
    );
    await openFileFromTree(page, FORMATTED_BULLET_FILE);
    await waitForEditorReady(page);

    // Old: - **Test Bullet:** This is a bullet and the middle stays the same
    // New: - **Test Bullet 2:** This is a bullet and the middle stays the same also
    const result = await simulateApplyDiff(page, filePath, [
      {
        oldText: '- **Test Bullet:** This is a bullet and the middle stays the same',
        newText: '- **Test Bullet 2:** This is a bullet and the middle stays the same also',
      },
    ]);
    expect(result.success).toBe(true);

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible({ timeout: 3000 });

    const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);
    await expect(activeEditor.locator('.nim-diff-add').first()).toBeVisible({ timeout: 3000 });

    const addText = (await activeEditor.locator('.nim-diff-add').allTextContents()).join(' ');
    const removeText = (await activeEditor.locator('.nim-diff-remove').allTextContents()).join(' ');

    // Both new bits must show up as additions
    expect(addText).toContain('2');
    expect(addText).toContain('also');

    // The unchanged middle chunk must NOT appear in any marker (otherwise
    // we're back to whole-line replacement).
    expect(addText).not.toContain('the middle stays the same');
    expect(removeText).not.toContain('the middle stays the same');

    // The sibling bullet must not get touched
    expect(addText).not.toContain('Other Item');
    expect(removeText).not.toContain('Other Item');

    await closeTabByFileName(page, FORMATTED_BULLET_FILE);
  });

  // Investigation finding: text-replacement edits that change a single cell value
  // inside an existing table row apply directly to the cell's TextNode without
  // setting diff state on any node, so no .unified-diff-header appears and no
  // .nim-diff-add/.nim-diff-remove markers are produced. The cell content does
  // update (verified via the page snapshot showing "Bob 99" after the edit). This
  // test pins that current behavior so a future change adding a visual signal --
  // or accidentally regressing the silent-apply path -- shows up here. The
  // related "row addition" path below DOES produce visible markers.
  test('table cell modification applies silently (no diff header, no markers - known fragility)', async () => {
    const filePath = path.join(workspaceDir, TABLE_FILE);
    await fs.writeFile(
      filePath,
      `# Table Test\n\n| Name | Score |\n|------|-------|\n| Alice | 90 |\n| Bob | 85 |\n`,
      'utf8',
    );
    await openFileFromTree(page, TABLE_FILE);
    await waitForEditorReady(page);

    const result = await simulateApplyDiff(page, filePath, [
      { oldText: '| Bob | 85 |', newText: '| Bob | 99 |' },
    ]);
    expect(result.success).toBe(true);

    // Give any header that WOULD appear time to render. We expect none.
    await page.waitForTimeout(500);

    const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);

    // No diff approval UI should appear for in-cell modifications today
    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toHaveCount(0);
    await expect(activeEditor.locator('.nim-diff-add')).toHaveCount(0);
    await expect(activeEditor.locator('.nim-diff-remove')).toHaveCount(0);

    // But the cell content WAS updated (silent apply path)
    const editorText = (await activeEditor.textContent()) ?? '';
    expect(editorText).toContain('99');
    expect(editorText).not.toContain('85');

    await closeTabByFileName(page, TABLE_FILE);
  });

  test('table row addition renders only green markers for the new row', async () => {
    const filePath = path.join(workspaceDir, TABLE_FILE);
    // reset file in case prior test mutated it via accept (it didn't, but be defensive)
    await fs.writeFile(
      filePath,
      `# Table Test\n\n| Name | Score |\n|------|-------|\n| Alice | 90 |\n| Bob | 85 |\n`,
      'utf8',
    );
    await openFileFromTree(page, TABLE_FILE);
    await waitForEditorReady(page);

    const result = await simulateApplyDiff(page, filePath, [
      { oldText: '| Bob | 85 |', newText: '| Bob | 85 |\n| Charlie | 77 |' },
    ]);
    expect(result.success).toBe(true);

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible({ timeout: 3000 });

    const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);
    await expect(activeEditor.locator('.nim-diff-add').first()).toBeVisible({ timeout: 3000 });

    const addText = (await activeEditor.locator('.nim-diff-add').allTextContents()).join(' ');
    expect(addText).toContain('Charlie');
    expect(addText).toContain('77');

    await closeTabByFileName(page, TABLE_FILE);
  });

  test('code block content change renders red/green markers inside the fenced block', async () => {
    const filePath = path.join(workspaceDir, CODE_FILE);
    await openFileFromTree(page, CODE_FILE);
    await waitForEditorReady(page);

    const result = await simulateApplyDiff(page, filePath, [
      { oldText: '  return "hello";', newText: '  return "world";' },
    ]);
    expect(result.success).toBe(true);

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible({ timeout: 3000 });

    const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);
    await expect(activeEditor.locator('.nim-diff-add').first()).toBeVisible({ timeout: 3000 });
    await expect(activeEditor.locator('.nim-diff-remove').first()).toBeVisible({ timeout: 3000 });

    const addText = (await activeEditor.locator('.nim-diff-add').allTextContents()).join(' ');
    const removeText = (await activeEditor.locator('.nim-diff-remove').allTextContents()).join(' ');
    expect(addText).toContain('world');
    expect(removeText).toContain('hello');

    await closeTabByFileName(page, CODE_FILE);
  });

  test('heading text change renders red/green markers on the heading', async () => {
    const filePath = path.join(workspaceDir, HEADING_FILE);
    await openFileFromTree(page, HEADING_FILE);
    await waitForEditorReady(page);

    const result = await simulateApplyDiff(page, filePath, [
      { oldText: '# Original Heading', newText: '# Updated Heading' },
    ]);
    expect(result.success).toBe(true);

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible({ timeout: 3000 });

    const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);
    await expect(activeEditor.locator('.nim-diff-add').first()).toBeVisible({ timeout: 3000 });
    await expect(activeEditor.locator('.nim-diff-remove').first()).toBeVisible({ timeout: 3000 });

    // The diff system marks only the changed words inside the heading (intra-text
    // diff), not the entire heading text. So we expect the changed word in each
    // marker, not the full "Updated Heading" / "Original Heading" string.
    const addText = (await activeEditor.locator('.nim-diff-add').allTextContents()).join(' ');
    const removeText = (await activeEditor.locator('.nim-diff-remove').allTextContents()).join(' ');
    expect(addText).toContain('Updated');
    expect(removeText).toContain('Original');

    // The diffed text should sit inside (or be) an h1 ancestor so the heading itself is marked
    const addInsideHeading = await activeEditor.locator('h1 .nim-diff-add, h1.nim-diff-add').count();
    expect(addInsideHeading).toBeGreaterThanOrEqual(1);

    await closeTabByFileName(page, HEADING_FILE);
  });

  // Frontmatter-only changes short-circuit in diffUtils.ts (line 499): when bodyChanged
  // is false but frontmatterUpdated is true, the diff system updates the frontmatter
  // node state and returns -- no inline add/remove markers are produced. This test
  // documents that current behavior end-to-end so a future change that introduces a
  // visual signal won't slip through unnoticed.
  test('frontmatter-only change updates frontmatter without inline markers (current behavior)', async () => {
    const filePath = path.join(workspaceDir, FRONTMATTER_FILE);
    await openFileFromTree(page, FRONTMATTER_FILE);
    await waitForEditorReady(page);

    const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);
    const addsBefore = await activeEditor.locator('.nim-diff-add').count();
    const removesBefore = await activeEditor.locator('.nim-diff-remove').count();

    // Drive the change through the file watcher path so the full pipeline runs
    // (simulateApplyDiff uses text-replacement and may not target frontmatter the
    // same way a disk write does).
    await fs.writeFile(
      filePath,
      `---\ntitle: Updated Title\nauthor: Greg\n---\n\n# Document Body\n\nBody text stays the same.\n`,
      'utf8',
    );
    await page.waitForTimeout(800);

    // No inline markers should have been added (frontmatter-only short-circuit)
    const addsAfter = await activeEditor.locator('.nim-diff-add').count();
    const removesAfter = await activeEditor.locator('.nim-diff-remove').count();
    expect(addsAfter).toBe(addsBefore);
    expect(removesAfter).toBe(removesBefore);

    await closeTabByFileName(page, FRONTMATTER_FILE);
  });
});

// Regression coverage for the original "I'm not seeing the changes in
// nimbalyst-local/social/persona.md even though the diff header shows" report.
// persona.md is heavy on the heading -> paragraph -> bulleted-list shape, often
// with sub-bullets. The basic-shape tests above cover plain paragraphs and a
// flat list; this test exercises the combined shape end-to-end.
test.describe('Visual Diff Rendering - Persona-shaped Content', () => {
  const PERSONA_FILE = 'visual-diff-persona-shape.md';
  const PERSONA_CONTENT = `# Persona

## Identity

Write as the CTO of a fictional software company.

This is a founder-builder voice, not a brand voice.

The account should feel like:

- a technical operator with receipts
- someone who has shipped real products
- someone willing to be blunt without sounding performative

## Voice

Use a tone that is:

- blunt
- specific
- technical
`;

  test.beforeAll(async () => {
    await fs.writeFile(path.join(workspaceDir, PERSONA_FILE), PERSONA_CONTENT, 'utf8');
  });

  test('edit to a bullet under a heading produces visible red/green markers', async () => {
    const filePath = path.join(workspaceDir, PERSONA_FILE);
    await fs.writeFile(filePath, PERSONA_CONTENT, 'utf8');

    await openFileFromTree(page, PERSONA_FILE);
    await waitForEditorReady(page);

    const result = await simulateApplyDiff(page, filePath, [
      { oldText: '- a technical operator with receipts', newText: '- a hands-on operator with shipped product receipts' },
    ]);
    expect(result.success).toBe(true);

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible({ timeout: 3000 });

    const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);
    await expect(activeEditor.locator('.nim-diff-add').first()).toBeVisible({ timeout: 3000 });
    await expect(activeEditor.locator('.nim-diff-remove').first()).toBeVisible({ timeout: 3000 });

    // The LCS-based intra-text diff finds "operator with" common between
    // old and new, so it produces:
    //   add: "hands-on", add: "shipped product "  (separate segments)
    //   remove: "technical"
    // The unchanged "operator with" and trailing "receipts" stay unmarked.
    const addText = (await activeEditor.locator('.nim-diff-add').allTextContents()).join(' ');
    const removeText = (await activeEditor.locator('.nim-diff-remove').allTextContents()).join(' ');
    expect(addText).toContain('hands-on');
    expect(addText).toContain('shipped product');
    expect(removeText).toContain('technical');
    // Verify the unchanged middle was NOT marked
    expect(addText).not.toContain('operator with');
    expect(removeText).not.toContain('operator with');

    await closeTabByFileName(page, PERSONA_FILE);
  });

  test('multiple edits across heading sections all render markers', async () => {
    const filePath = path.join(workspaceDir, PERSONA_FILE);
    await fs.writeFile(filePath, PERSONA_CONTENT, 'utf8');

    await openFileFromTree(page, PERSONA_FILE);
    await waitForEditorReady(page);

    const result = await simulateApplyDiff(page, filePath, [
      { oldText: '## Identity', newText: '## Identity & Background' },
      { oldText: '- blunt', newText: '- direct' },
    ]);
    expect(result.success).toBe(true);

    await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible({ timeout: 3000 });

    const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);
    await expect(activeEditor.locator('.nim-diff-add').first()).toBeVisible({ timeout: 3000 });

    // Heading edit (Identity -> Identity & Background) is a pure-add intra-text
    // diff: only " & Background" is marked added, "Identity" stays unmarked.
    // Bullet edit (blunt -> direct) is a full-token replace.
    // So we expect at least 2 add markers but only 1 remove marker overall.
    const addCount = await activeEditor.locator('.nim-diff-add').count();
    const removeCount = await activeEditor.locator('.nim-diff-remove').count();
    expect(addCount).toBeGreaterThanOrEqual(2);
    expect(removeCount).toBeGreaterThanOrEqual(1);

    const addText = (await activeEditor.locator('.nim-diff-add').allTextContents()).join(' ');
    const removeText = (await activeEditor.locator('.nim-diff-remove').allTextContents()).join(' ');
    expect(addText).toContain('Background');
    expect(addText).toContain('direct');
    expect(removeText).toContain('blunt');

    await closeTabByFileName(page, PERSONA_FILE);
  });
});

test.describe('Visual Diff Rendering - Dark Theme', () => {
  test('renders red/green markers with dark-theme outline overrides', async () => {
    const filePath = path.join(workspaceDir, FILE_NAME);
    await resetFile(filePath, ORIGINAL_CONTENT);

    // Switch to dark theme via the existing IPC flow. set-theme is a `safeOn`
    // (ipcMain.on) handler, so we use electronAPI.send (not invoke). The central
    // theme listener picks up the broadcast `theme-change` event and applies the
    // dark-theme class + CSS variables to documentElement.
    await page.evaluate(() => {
      (window as any).electronAPI.send('set-theme', 'dark');
    });
    await page.waitForFunction(
      () => document.documentElement.classList.contains('dark-theme'),
      undefined,
      { timeout: 3000 },
    );

    await openFileFromTree(page, FILE_NAME);
    await waitForEditorReady(page);

    try {
      const result = await simulateApplyDiff(page, filePath, [
        { oldText: 'This is the first paragraph.', newText: 'DARK THEME PARAGRAPH.' },
      ]);
      expect(result.success).toBe(true);

      await expect(page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader)).toBeVisible({ timeout: 3000 });

      const activeEditor = page.locator(ACTIVE_EDITOR_LOCATOR);
      await expect(activeEditor.locator('.nim-diff-add').first()).toBeVisible({ timeout: 3000 });
      await expect(activeEditor.locator('.nim-diff-remove').first()).toBeVisible({ timeout: 3000 });

      // Dark theme overrides (NimbalystEditorTheme.css:937-944) add an outline to
      // both add and remove markers, plus line-through on remove. Verify at least
      // one of those visual signals is present (computed style), since the exact
      // background may render via inline style or var fallback.
      const addStyle = await activeEditor.locator('.nim-diff-add').first().evaluate((el) => {
        const cs = getComputedStyle(el);
        return { outline: cs.outline, outlineWidth: cs.outlineWidth, bg: cs.backgroundColor };
      });
      const removeStyle = await activeEditor.locator('.nim-diff-remove').first().evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          outline: cs.outline,
          outlineWidth: cs.outlineWidth,
          textDecoration: cs.textDecorationLine,
          bg: cs.backgroundColor,
        };
      });

      // The .dark-theme override sets a 1px outline; computed outline-width should
      // be non-zero (e.g. "1px"). Background may or may not be transparent depending
      // on whether the empty-paragraph rule kicked in, but outline is reliable.
      expect(addStyle.outlineWidth).not.toBe('0px');
      expect(removeStyle.outlineWidth).not.toBe('0px');
      // Remove markers also get line-through under dark theme
      expect(removeStyle.textDecoration).toContain('line-through');
    } finally {
      // Restore light theme so subsequent describe blocks (run in serial mode)
      // start from a known state.
      await page.evaluate(() => {
        (window as any).electronAPI.send('set-theme', 'light');
      });
      await page.waitForFunction(
        () => document.documentElement.classList.contains('light-theme'),
        undefined,
        { timeout: 3000 },
      );
      await closeTabByFileName(page, FILE_NAME);
    }
  });
});
