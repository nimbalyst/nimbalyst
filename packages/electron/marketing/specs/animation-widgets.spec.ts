/**
 * Animation reference captures
 *
 * Pixel-accurate screenshots of the real transcript tool widgets, cropped tight,
 * for building product-UI marketing animations (nimbalyst-local/marketing). The
 * rule these enforce: an animation reproduces the REAL widget, so we capture the
 * widget from the running app rather than redrawing it from memory.
 *
 * Widgets captured: the File Change / Edit diff card, the pending Commit
 * Proposal, and the committed "Changes Committed" card. Each lands in
 * marketing/screenshots/{dark,light}/anim-<name>.png.
 *
 * Run (dev server on 5273 required):
 *   npx playwright test --config=marketing/playwright.marketing.config.ts \
 *     marketing/specs/animation-widgets.spec.ts
 */

import { test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import {
  launchMarketingApp,
  captureScreenshotBothThemes,
  switchToAgentMode,
  pause,
} from '../utils/helpers';
import {
  populateMarketingSessions,
  insertEditToolCall,
  insertGitCommitProposal,
  insertGitCommitProposalResult,
} from '../utils/sessionData';
import * as fs from 'fs/promises';

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;
let primarySessionId: string;

test.beforeAll(async () => {
  const result = await launchMarketingApp();
  electronApp = result.app;
  page = result.page;
  workspaceDir = result.workspaceDir;

  const sessions = await populateMarketingSessions(page, workspaceDir);
  primarySessionId = sessions.primarySessionId;
});

test.afterAll(async () => {
  await electronApp?.close();
  await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
});

/** Select the primary session and scroll its transcript to the newest widget. */
async function showLatest(): Promise<void> {
  await switchToAgentMode(page);
  await pause(page, 500);
  const item = page.locator('.session-list-item').first();
  if (await item.isVisible().catch(() => false)) {
    await item.click();
    await pause(page, 1200);
  }
  await page.evaluate(() => {
    const t = document.querySelector('.rich-transcript-view');
    if (t) t.scrollTop = t.scrollHeight;
  });
  await pause(page, 500);
}

/** A padded clip around the last match of `selector`, or undefined (full page). */
async function clipFor(selector: string) {
  const box = await page.locator(selector).last().boundingBox().catch(() => null);
  if (!box) return undefined;
  const pad = 14;
  return {
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
    width: box.width + pad * 2,
    height: box.height + pad * 2,
  };
}

test('anim-file-change - the Edit diff card', async () => {
  await insertEditToolCall(
    page,
    primarySessionId,
    'CHANGELOG.md',
    '<!-- Bug fixes go here -->\n- Typing in a dialog while the tracker table is open no longer edits the selected cell.',
    '<!-- Bug fixes go here -->\n- The session model picker loads ahead of opening and uses cached results instead of blocking on provider discovery.\n- Typing in a dialog while the tracker table is open no longer edits the selected cell.'
  );
  await showLatest();
  const clip = await clipFor('.rich-transcript-edit-card');
  await captureScreenshotBothThemes(electronApp, page, 'anim-file-change', { clip });
});

test('anim-commit-proposal - pending commit widget', async () => {
  await insertGitCommitProposal(
    page,
    primarySessionId,
    [
      { path: 'CHANGELOG.md', status: 'modified' },
      { path: 'packages/electron/src/renderer/components/UnifiedAI/ModelSelector.tsx', status: 'modified' },
      { path: 'packages/electron/src/renderer/components/UnifiedAI/__tests__/modelPickerKeyboard.test.tsx', status: 'modified' },
      { path: 'packages/runtime/src/ai/server/ModelRegistry.ts', status: 'modified' },
      { path: 'packages/runtime/src/ai/server/providers/CursorAgentProvider.ts', status: 'modified' },
      { path: 'packages/runtime/src/ai/server/providers/GrokBuildProvider.ts', status: 'modified' },
      { path: 'packages/runtime/src/ai/server/__tests__/modelRegistryCoverage.test.ts', status: 'added' },
      { path: 'packages/runtime/src/ai/server/__tests__/headlessCliModelCatalog.test.ts', status: 'added' },
    ],
    'fix: stop model discovery blocking the session picker\n\nFixes NIM-4732',
    'All seven session-edited implementation and regression-test files, plus the required concise [Unreleased] changelog entry. The message states the user-visible latency fix and closes the linked bug tracker item.'
  );
  await showLatest();
  const clip = await clipFor('[data-testid="git-commit-widget"]');
  await captureScreenshotBothThemes(electronApp, page, 'anim-commit-proposal', { clip });
});

test('anim-changes-committed - committed success card', async () => {
  // Reuse the proposal from the previous test's session, then flip it committed.
  const toolId = await insertGitCommitProposal(
    page,
    primarySessionId,
    [
      { path: 'CHANGELOG.md', status: 'modified' },
      { path: 'packages/runtime/src/ai/server/ModelRegistry.ts', status: 'modified' },
      { path: 'packages/runtime/src/ai/server/__tests__/modelRegistryCoverage.test.ts', status: 'added' },
    ],
    'fix: stop model discovery blocking the session picker\n\nFixes NIM-4732',
    'Commit the model-picker latency fix.'
  );
  await insertGitCommitProposalResult(
    page,
    primarySessionId,
    toolId,
    'committed',
    'a69f3dbd514ee2845ef027d8d85cbbf78bf738e8',
    new Date(2026, 7, 28, 15, 6).toISOString()
  );
  await showLatest();
  const clip = await clipFor('[data-testid="git-commit-widget"]');
  await captureScreenshotBothThemes(electronApp, page, 'anim-changes-committed', { clip });
});
