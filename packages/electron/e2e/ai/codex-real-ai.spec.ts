/**
 * Real-AI Codex E2E test.
 *
 * Drives a live `openai-codex` agent session against a temp workspace and
 * verifies the end-to-end edit-attribution -> transcript-diff pipeline:
 *
 *   Codex SDK -> raw event -> canonical event -> session_files
 *     -> ToolCallMatcher -> renderer EditToolResultCard -> DiffViewer/NewFilePreview
 *
 * Gate: requires `RUN_REAL_CODEX=1` and a host that already has Codex CLI
 * auth configured (Codex uses CLI-side auth, not a Nimbalyst-stored API key).
 * NEVER runs in CI by default. Skipped automatically without the env var.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page, Locator } from 'playwright';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  dismissProjectTrustToast,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  dismissAPIKeyDialog,
  switchToAgentMode,
  submitChatPrompt,
  createNewAgentSession,
  openFileFromTree,
} from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

// Skip entire file unless the explicit opt-in is set.
test.skip(
  () => !process.env.RUN_REAL_CODEX,
  'Requires Codex CLI auth + RUN_REAL_CODEX=1'
);

// Codex API turn can take longer than typical UI interactions.
test.setTimeout(180000);

test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

// --- Helpers shared across tests --------------------------------------------

/**
 * Switch the active session in the visible panel to Codex by setting the
 * model. The metadata handler derives provider from the model id, so this
 * is sufficient to route the next message to OpenAICodexProvider.
 */
async function switchActiveSessionToCodex(): Promise<string> {
  const sessionPanel = page.locator(PLAYWRIGHT_TEST_SELECTORS.activeSession);
  await expect(sessionPanel).toBeVisible({ timeout: 5000 });
  const sessionId = await sessionPanel.getAttribute('data-session-id');
  expect(sessionId, 'agent-session-panel should expose data-session-id').toBeTruthy();
  const result = await page.evaluate(
    async ({ id, model }) =>
      (window as any).electronAPI.invoke('sessions:update-metadata', id, { model }),
    { id: sessionId!, model: 'openai-codex:gpt-5.4' }
  );
  expect(result?.success, `update-metadata failed: ${JSON.stringify(result)}`).toBe(true);
  await page.waitForTimeout(500);
  return sessionId!;
}

/**
 * Wait for a Codex turn to finish in the given panel. The cancel button is
 * only mounted while isLoading is true, so its disappearance is the canonical
 * "done" signal. Codex model latency dominates so we give 90s headroom.
 */
async function waitForCodexTurnComplete(panel: Locator): Promise<void> {
  const cancelButton = panel.locator('.ai-chat-cancel-button');
  await expect(cancelButton).toBeVisible({ timeout: 30000 });
  await expect(cancelButton).toHaveCount(0, { timeout: 90000 });
}

/**
 * Expand every collapsed tool card inside the panel so any embedded diff
 * widgets are mounted.
 */
async function expandAllToolCards(panel: Locator): Promise<void> {
  const cards = panel.locator(PLAYWRIGHT_TEST_SELECTORS.richTranscriptToolContainer);
  const count = await cards.count();
  for (let i = 0; i < count; i++) {
    const headerButton = cards
      .nth(i)
      .locator('.rich-transcript-tool-button, .rich-transcript-edit-card__header, .file-change-widget > button')
      .first();
    if (await headerButton.isVisible().catch(() => false)) {
      await headerButton.click().catch(() => {});
      await page.waitForTimeout(150);
    }
  }
}

// --- Setup ------------------------------------------------------------------

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  await fs.writeFile(
    path.join(workspaceDir, 'README.md'),
    '# Test workspace\n\nSeed file.\n',
    'utf8'
  );

  electronApp = await launchElectronApp({
    workspace: workspaceDir,
    permissionMode: 'allow-all',
  });
  page = await electronApp.firstWindow();

  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);
  await dismissAPIKeyDialog(page);
  await dismissProjectTrustToast(page);
});

test.afterAll(async () => {
  // Cancel any in-flight Codex turn to avoid leaking the subprocess.
  try {
    const cancelButtons = page.locator('.ai-chat-cancel-button');
    const count = await cancelButtons.count();
    for (let i = 0; i < count; i++) {
      const btn = cancelButtons.nth(i);
      if (await btn.isVisible({ timeout: 250 }).catch(() => false)) {
        await btn.click().catch(() => {});
      }
    }
  } catch {
    // ignore
  }

  await electronApp?.close();
  await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
});

// --- Test 1: New file creation ----------------------------------------------

test('Codex new-file creation renders NewFilePreview with the file body', async () => {
  await switchToAgentMode(page);
  await page.waitForTimeout(500);
  await switchActiveSessionToCodex();
  const sessionPanel = page.locator(PLAYWRIGHT_TEST_SELECTORS.activeSession);

  const targetFileName = 'codex-hello.txt';
  const fullPath = path.join(workspaceDir, targetFileName);
  await fs.rm(fullPath, { force: true });

  await submitChatPrompt(
    page,
    `Create a new file named "${targetFileName}" in the current workspace containing the single line "hi from codex". Do not ask any clarifying questions. Just create the file and stop.`
  );
  await waitForCodexTurnComplete(sessionPanel);

  // Sanity: file landed on disk with expected content.
  await expect.poll(
    async () => fs.stat(fullPath).then(() => true).catch(() => false),
    { timeout: 5000 }
  ).toBe(true);
  const finalContent = await fs.readFile(fullPath, 'utf8');
  expect(finalContent).toContain('hi from codex');

  await expandAllToolCards(sessionPanel);

  // The renderer must surface the new file via the EditToolResultCard wrapper
  // (`.rich-transcript-edit-card`) which embeds either `.new-file-preview` or
  // `.diff-viewer`. For a fresh-create we require NewFilePreview specifically:
  // a missing or empty preview means the kind=create metadata was lost in the
  // synthetic-edit-group-id pipeline.
  const editCard = sessionPanel
    .locator('.rich-transcript-edit-card', { hasText: targetFileName })
    .first();
  await expect(editCard).toBeVisible({ timeout: 5000 });

  const newFilePreview = editCard.locator('.new-file-preview', { hasText: targetFileName }).first();
  await expect(newFilePreview).toBeVisible({ timeout: 5000 });
  await expect(newFilePreview).toContainText('hi from codex');
});

// --- Test 2: Existing file edit (red+green diff) ----------------------------

test('Codex edit on existing file renders both removed (red) and added (green) lines', async () => {
  // Reproduces the user-reported regression: editing an existing file via
  // Codex's file_change tool failed to render any diff at all, or rendered
  // the entire post-edit body as added (green only). With the item.started
  // pre-edit snapshot path, the synthetic edit-group ID stamps a real
  // baseline into local history so DiffViewer renders both sides.

  await createNewAgentSession(page);
  await page.waitForTimeout(500);
  await switchActiveSessionToCodex();
  const sessionPanel = page.locator(PLAYWRIGHT_TEST_SELECTORS.activeSession);

  // Add to .gitignore BEFORE seeding so the file has neither a git baseline
  // nor a FileSnapshotCache entry -- that combination broke the old bash
  // watcher path that was fabricating empty pre-edit baselines.
  const targetFileName = 'fruits.md';
  await fs.writeFile(
    path.join(workspaceDir, '.gitignore'),
    `${targetFileName}\n`,
    'utf8'
  );

  const initialContent = [
    '# Fruits',
    '',
    '- Apple',
    '- Orange',
    '- Grape',
    '',
  ].join('\n');
  const fullPath = path.join(workspaceDir, targetFileName);
  await fs.writeFile(fullPath, initialContent, 'utf8');
  // Give chokidar a beat to observe the new file before Codex starts editing.
  await page.waitForTimeout(1500);

  // Use a REPLACEMENT (rename one fruit to another) so the diff has BOTH a
  // removed (red) line for "- Orange" and an added (green) line for "- Mango".
  // Pure insertions like "append a fruit" have no removed lines, which is a
  // correct diff but does not exercise the empty-pre-edit-baseline regression
  // we are guarding against.
  await submitChatPrompt(
    page,
    `Edit the existing file "${targetFileName}" in the current workspace. Replace the line "- Orange" with "- Mango". Keep every other line exactly as-is. Do not ask any clarifying questions.`
  );
  await waitForCodexTurnComplete(sessionPanel);

  // Sanity: the edit landed on disk.
  await expect.poll(
    async () => (await fs.readFile(fullPath, 'utf8')).includes('- Mango'),
    { timeout: 5000 }
  ).toBe(true);
  const finalContent = await fs.readFile(fullPath, 'utf8');
  expect(finalContent).toContain('- Mango');
  expect(finalContent).not.toContain('- Orange');

  await expandAllToolCards(sessionPanel);

  // The transcript must surface the edit through EditToolResultCard. The
  // wrapper carries the file path; its DiffViewer child carries the lines.
  const editCard = sessionPanel
    .locator('.rich-transcript-edit-card', { hasText: targetFileName })
    .first();
  await expect(
    editCard,
    'EditToolResultCard for the edited file must be visible. Missing card = AsyncEditToolResultCard returned no edits, which means getToolCallDiffs lost the synthetic edit-group ID -> session_files attribution.'
  ).toBeVisible({ timeout: 5000 });

  const diffViewer = editCard.locator('.diff-viewer').first();
  await expect(
    diffViewer,
    'DiffViewer must render inside the edit card for an update. NewFilePreview without DiffViewer indicates the edit was misclassified as a create.'
  ).toBeVisible({ timeout: 5000 });

  // Red+green requirement. All-green = empty pre-edit baseline regression.
  const removedLines = editCard.locator('.diff-line.removed');
  const addedLines = editCard.locator('.diff-line.added');
  await expect(addedLines.first()).toBeVisible({ timeout: 5000 });
  expect(
    await addedLines.count(),
    'diff for an existing-file update should include at least one added (green) line'
  ).toBeGreaterThan(0);
  expect(
    await removedLines.count(),
    'diff for an existing-file update should include at least one removed (red) line; all-green indicates the empty-baseline regression'
  ).toBeGreaterThan(0);

  // The diff should pair the removal of "Orange" with the addition of "Mango".
  const addedText = (await addedLines.allInnerTexts()).join('\n');
  const removedText = (await removedLines.allInnerTexts()).join('\n');
  expect(addedText).toContain('Mango');
  expect(removedText).toContain('Orange');
});

// --- Test 3: Files mode + open file tab + Codex edit ------------------------

test('Files mode: Codex edit refreshes the open editor and renders red+green diff in the chat transcript', async () => {
  // The user-reported scenario: a file is open in a Files-mode tab, the
  // chat sidebar runs a Codex session, and the user asks the model to edit
  // that file. The full pipeline must:
  //   1) write the new bytes to disk (sanity)
  //   2) refresh the open editor with the new content
  //   3) render a red+green DiffViewer in the chat transcript
  //
  // Failures here are the surface the user keeps re-reporting: "edit tool
  // calls aren't showing as edits with red/green diffs in the transcript
  // and the file showed no changes" -- meaning the open editor didn't
  // reload AND the AsyncEditToolResultCard rendered nothing.

  // Ensure Files mode is active before this test runs. The default launch
  // mode is Files, but earlier tests in this file leave us in Agent mode --
  // so we may need to click the Files button. Use the visibility of the
  // workspace sidebar as the source of truth, not the button state.
  const sidebar = page.locator(PLAYWRIGHT_TEST_SELECTORS.workspaceSidebar);
  if (!(await sidebar.isVisible().catch(() => false))) {
    const filesButton = page.locator(PLAYWRIGHT_TEST_SELECTORS.filesModeButton);
    await filesButton.click();
    await expect(sidebar).toBeVisible({ timeout: 5000 });
  }
  await page.waitForTimeout(500);

  // Seed the file BEFORE opening so the editor has stable initial content.
  const targetFileName = 'fruits-files-mode.md';
  const initialContent = [
    '# Fruits',
    '',
    '- Apple',
    '- Orange',
    '- Grape',
    '',
  ].join('\n');
  const fullPath = path.join(workspaceDir, targetFileName);
  await fs.writeFile(fullPath, initialContent, 'utf8');
  await page.waitForTimeout(500); // chokidar settle

  await openFileFromTree(page, targetFileName);
  // The Lexical editor renders inside a contenteditable; require it to show
  // the seeded content before continuing.
  const editor = page.locator(PLAYWRIGHT_TEST_SELECTORS.contentEditable).first();
  await expect(editor).toBeVisible({ timeout: 5000 });
  await expect(editor).toContainText('Apple', { timeout: 5000 });

  // Open the Files-mode chat sidebar via the keyboard shortcut. The Files-mode
  // sidebar is the ChatSidebar component, which has [data-testid="chat-sidebar-panel"]
  // and a [data-session-id] attribute on the same element. There is no nested
  // `.agent-session-panel` in this mode -- the chat sidebar IS the session host.
  const chatSidebar = page.locator('[data-testid="chat-sidebar-panel"]');
  if (!(await chatSidebar.isVisible().catch(() => false))) {
    await page.keyboard.press('Meta+Shift+a');
    await expect(chatSidebar).toBeVisible({ timeout: 5000 });
  }

  // Wait for the sidebar to mount with a real session id. The first time the
  // sidebar opens for a workspace it auto-creates a session.
  await expect.poll(
    async () => (await chatSidebar.getAttribute('data-session-id')) ?? '',
    { timeout: 10000, message: 'chat-sidebar-panel must expose a non-empty data-session-id' }
  ).not.toBe('');
  const filesSessionId = await chatSidebar.getAttribute('data-session-id');
  expect(filesSessionId, 'files-mode chat sidebar should expose data-session-id').toBeTruthy();

  // Switch the auto-created session's model to Codex via the same IPC the
  // model picker uses; provider is derived from the model id.
  const updateResult = await page.evaluate(
    async ({ id, model }) =>
      (window as any).electronAPI.invoke('sessions:update-metadata', id, { model }),
    { id: filesSessionId!, model: 'openai-codex:gpt-5.4' }
  );
  expect(updateResult?.success, `update-metadata failed: ${JSON.stringify(updateResult)}`).toBe(true);
  await page.waitForTimeout(500);

  // The chat sidebar IS the panel scope for cancel-button / transcript
  // assertions in this test.
  const filesModePanel = chatSidebar;

  // Submit the prompt through the Files-mode chat input. submitChatPrompt
  // routes to filesChatInput when agent mode isn't visible.
  // We use a REPLACEMENT (rename "Orange" -> "Mango") instead of an append
  // so the diff has both a removed (red) and an added (green) line.
  await submitChatPrompt(
    page,
    `Edit "${targetFileName}". Replace the line "- Orange" with "- Mango". Keep every other line exactly as-is. Do not ask any clarifying questions.`
  );
  await waitForCodexTurnComplete(filesModePanel);

  // Sanity: edit landed on disk.
  await expect.poll(
    async () => (await fs.readFile(fullPath, 'utf8')).includes('- Mango'),
    { timeout: 5000 }
  ).toBe(true);

  // 1) Open editor must refresh with the new content. This was the user's
  // "the file showed no changes" complaint -- the editor was still showing
  // pre-edit content until they closed and reopened the tab.
  //
  // Note: in pending-review mode the editor shows BOTH the original and
  // replacement strings (the diff overlay strikes through the old line and
  // highlights the new one). So we only assert the new text appears -- we
  // cannot assert "Orange" is gone, because the strikethrough overlay keeps
  // it in the text content for review.
  await expect(editor).toContainText('Mango', { timeout: 5000 });

  // 1b) The unified diff approval bar must mount above the editor for the
  // edited file. If this is missing, the editor has not registered the AI
  // edit as a pending review even though the bytes may have landed on disk
  // -- which is the exact failure mode the user keeps reporting (file-watcher
  // attribution dropped because pre_edit_snapshot path passed window=null
  // and dedup-blocked the later tool_call call's watcher setup).
  await expect(
    page.locator(PLAYWRIGHT_TEST_SELECTORS.unifiedDiffHeader).first(),
    'editor must show the unified diff approval bar after a Codex AI edit; missing bar = AI edit attribution lost'
  ).toBeVisible({ timeout: 5000 });

  // 2) Transcript must show a DiffViewer with red AND green lines for the
  // edited file. This was the user's "not showing as edits with red/green
  // diffs" complaint.
  await expandAllToolCards(filesModePanel);

  const editCard = filesModePanel
    .locator('.rich-transcript-edit-card', { hasText: targetFileName })
    .first();
  await expect(
    editCard,
    'EditToolResultCard for the edited file must render in the Files-mode transcript'
  ).toBeVisible({ timeout: 5000 });

  const removedLines = editCard.locator('.diff-line.removed');
  const addedLines = editCard.locator('.diff-line.added');
  await expect(addedLines.first()).toBeVisible({ timeout: 5000 });
  expect(
    await addedLines.count(),
    'Files-mode transcript should render at least one added (green) line'
  ).toBeGreaterThan(0);
  expect(
    await removedLines.count(),
    'Files-mode transcript should render at least one removed (red) line; all-green = empty-baseline regression'
  ).toBeGreaterThan(0);
});
