/**
 * Single-test real-AI E2E for the codex app-server transport.
 *
 * Purpose: tight iteration loop for the codex-app-server-protocol-migration.
 * The full `codex-real-ai.spec.ts` covers more ground but takes ~3 minutes per
 * run; this spec exists so we can verify the ONE thing the migration was
 * built to fix -- gitignored-file pre-edit baselines via reverse-applied diff
 * hunks -- and iterate quickly when it breaks.
 *
 * Gate: requires `RUN_REAL_CODEX=1`. Codex uses CLI-side auth (`~/.codex/auth.json`).
 *
 * Failure mode this guards against (the user's actual symptom):
 *   - FilesEditedSidebar peek for a gitignored edited file renders ALL-GREEN
 *     instead of the real red/green diff. Indicates the host wrote an empty
 *     pre-edit baseline -- either because the migration's app-server snapshot
 *     pipeline never ran, or it produced empty content.
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
} from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.skip(
  () => !process.env.RUN_REAL_CODEX,
  'Requires Codex CLI auth + RUN_REAL_CODEX=1',
);

// Real model + gitignored file -> ~60s typical, headroom for network.
test.setTimeout(180_000);
test.describe.configure({ mode: 'serial' });

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;

async function waitForCodexTurnComplete(panel: Locator): Promise<void> {
  const cancelButton = panel.locator('.ai-chat-cancel-button');
  await expect(cancelButton).toBeVisible({ timeout: 30_000 });
  await expect(cancelButton).toHaveCount(0, { timeout: 120_000 });
}

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

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();

  // Seed README so the workspace isn't empty (helps a few internal init steps).
  await fs.writeFile(
    path.join(workspaceDir, 'README.md'),
    '# Test workspace\n\nSeed file.\n',
    'utf8',
  );

  // Pre-launch: pin the codex transport to 'app-server' via electron-store.
  // The Electron host bootstrap reads `openaiCodex.transport` from app-settings
  // and feeds it into `OpenAICodexProvider.setCodexTransportResolver`. Setting
  // it explicitly here removes any ambiguity about which transport the test
  // exercises, even though 'app-server' is also the default.
  electronApp = await launchElectronApp({
    workspace: workspaceDir,
    permissionMode: 'allow-all',
  });
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await waitForAppReady(page);
  await dismissAPIKeyDialog(page);
  await dismissProjectTrustToast(page);

  // Set the transport setting after launch so the next codex session reads it
  // when the provider is constructed.
  await page.evaluate(async () => {
    await (window as any).electronAPI.invoke('app-settings:set', 'openaiCodex', { transport: 'app-server' });
  });
});

test.afterAll(async () => {
  try {
    const cancelButtons = page.locator('.ai-chat-cancel-button');
    const count = await cancelButtons.count();
    for (let i = 0; i < count; i++) {
      const btn = cancelButtons.nth(i);
      if (await btn.isVisible({ timeout: 250 }).catch(() => false)) {
        await btn.click().catch(() => {});
      }
    }
  } catch { /* ignore */ }
  await electronApp?.close();
  await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
});

test('app-server transport: gitignored existing-file edit renders red+green diff', async () => {
  await switchToAgentMode(page);
  await page.waitForTimeout(300);

  // Get the active session and switch it to codex.
  const sessionPanel = page.locator(PLAYWRIGHT_TEST_SELECTORS.activeSession);
  await expect(sessionPanel).toBeVisible({ timeout: 5_000 });
  const sessionId = await sessionPanel.getAttribute('data-session-id');
  expect(sessionId, 'session panel must expose data-session-id').toBeTruthy();
  const switchResult = await page.evaluate(
    async ({ id, model }) =>
      (window as any).electronAPI.invoke('sessions:update-metadata', id, { model }),
    { id: sessionId!, model: 'openai-codex:gpt-5.4' },
  );
  expect(switchResult?.success, `update-metadata failed: ${JSON.stringify(switchResult)}`).toBe(true);
  await page.waitForTimeout(500);

  // Seed a GITIGNORED file with known content. .gitignore lives in the
  // workspace root; the target file path matches a pattern that the existing
  // codex-real-ai test uses too. Gitignored is the exact bug case the
  // migration was built to fix.
  const targetFileName = 'fruits.md';
  await fs.writeFile(path.join(workspaceDir, '.gitignore'), `${targetFileName}\n`, 'utf8');
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
  // Let chokidar observe the seed (the legacy SDK transport's fallback path
  // relies on it; the new app-server transport does not, but we keep the
  // wait so failure attribution is unambiguous if anything regresses).
  await page.waitForTimeout(1_500);

  // Single edit: "Orange" -> "Mango". Replacement, not append, so the diff
  // has both a removed (red) line and an added (green) line. All-green
  // means the pre-edit baseline came back empty -- the exact regression
  // the app-server reverse-apply pipeline must prevent.
  await submitChatPrompt(
    page,
    `Edit the existing file "${targetFileName}" in the current workspace. Replace the line "- Orange" with "- Mango". Keep every other line exactly as-is. Do not ask any clarifying questions.`,
  );
  await waitForCodexTurnComplete(sessionPanel);

  // Sanity: edit landed on disk.
  await expect.poll(
    async () => (await fs.readFile(fullPath, 'utf8')).includes('- Mango'),
    { timeout: 5_000 },
  ).toBe(true);
  const finalContent = await fs.readFile(fullPath, 'utf8');
  expect(finalContent).toContain('- Mango');
  expect(finalContent).not.toContain('- Orange');

  await expandAllToolCards(sessionPanel);

  // Verify the transcript renders the edit through EditToolResultCard. A
  // missing card or empty diff body indicates the tool_call event from the
  // app-server protocol didn't carry the data we expect downstream.
  const editCard = sessionPanel
    .locator('.rich-transcript-edit-card', { hasText: targetFileName })
    .first();
  await expect(
    editCard,
    'EditToolResultCard for the edited file must be visible. Missing card = the file_change tool_call event the app-server protocol emitted lost the data the renderer needs.',
  ).toBeVisible({ timeout: 5_000 });

  const diffViewer = editCard.locator('.diff-viewer').first();
  await expect(
    diffViewer,
    'DiffViewer must render inside the edit card for an update. NewFilePreview without DiffViewer = update misclassified as create.',
  ).toBeVisible({ timeout: 5_000 });

  // The critical red+green assertion. This is the regression the migration
  // was built to fix.
  const removedLines = editCard.locator('.diff-line.removed');
  const addedLines = editCard.locator('.diff-line.added');
  await expect(addedLines.first()).toBeVisible({ timeout: 5_000 });

  const addedCount = await addedLines.count();
  const removedCount = await removedLines.count();
  expect(
    addedCount,
    'diff should have at least one added (green) line',
  ).toBeGreaterThan(0);
  expect(
    removedCount,
    `diff should have at least one removed (red) line. addedCount=${addedCount} removedCount=${removedCount}. ` +
      'All-green = empty pre-edit baseline = the app-server reverse-apply pipeline did not produce correct content. ' +
      'Check main.log for [CODEX][APPSERVER] snapshot lines.',
  ).toBeGreaterThan(0);

  const addedText = (await addedLines.allInnerTexts()).join('\n');
  const removedText = (await removedLines.allInnerTexts()).join('\n');
  expect(addedText).toContain('Mango');
  expect(removedText).toContain('Orange');
});
