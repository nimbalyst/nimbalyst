/**
 * Large Markdown File Crash Reproduction
 *
 * Reproduces the 2026-05-21 crash where opening CHANGELOG.md hung the
 * renderer main thread for ~30s and tripped Electron's `unresponsive`
 * signal. At crash time the file was mid-trim: HEAD's CHANGELOG was
 * ~420 KB / ~6,700 lines and an AI session was rewriting it down to
 * ~280 KB / ~6,600 lines (line count barely moved; per-line byte count
 * dropped ~38%).
 *
 * Hypothesis (from session 4dc11b8f): because the file was being edited,
 * a pending pre-edit history tag held the LARGE (420 KB) snapshot. On
 * file open, TabEditor.checkAndApplyPendingDiffs runs a SECOND full
 * $convertFromEnhancedMarkdownString(oldContent) on top of the initial
 * parse, then dispatches APPLY_MARKDOWN_REPLACE_COMMAND which tree-
 * matches the whole newContent against the just-re-parsed oldContent.
 * That stacks parse(280 KB) + parse(420 KB) + tree-match back-to-back
 * on the renderer main thread.
 *
 * This spec measures two scenarios so we can confirm the amplifier:
 *
 *   1. Plain open: open the trimmed (280 KB) markdown file, no pending
 *      diff. Establishes the baseline parse cost.
 *   2. Open-with-pending-diff: pre-seed a pre-edit history tag holding
 *      the LARGE (420 KB) snapshot, write the TRIMMED (280 KB) content
 *      to disk, open the file. This is the exact diff that was in
 *      flight when the renderer hung.
 *
 * Both cases also assert the renderer is still responsive after open
 * (IPC roundtrip within a budget) -- a hung renderer would fail the IPC
 * assertion well before the wall-time assertion fires.
 *
 * Threshold: the budget is intentionally generous (10s). The bug
 * symptom was ~30s of unresponsiveness, so 10s gives plenty of headroom
 * for slow CI hardware while still flagging the regression we care about.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  launchElectronApp,
  createTempWorkspace,
  waitForAppReady,
  dismissProjectTrustToast,
  TEST_TIMEOUTS,
  ACTIVE_EDITOR_SELECTOR,
} from '../helpers';
import {
  PLAYWRIGHT_TEST_SELECTORS,
  openFileFromTree,
  closeTabByFileName,
} from '../utils/testHelpers';

test.describe.configure({ mode: 'serial' });

const TEST_FILES = {
  plainOpen: 'large-plain.md',
  pendingDiffOpen: 'large-with-pending-diff.md',
};

// CHANGELOG shape: headings + nested bullets, NO tables (the table-row
// guard in PR #335 only fires above 5 KB / row and doesn't apply here).
// We build two versions to mirror the in-flight trim:
//
//   - "large" : ~420 KB / ~6,700 lines, ~63 bytes/line avg. Matches HEAD
//               CHANGELOG.md at crash time. Long bullet bodies.
//   - "trimmed": ~280 KB / ~6,600 lines, ~42 bytes/line avg. Matches the
//               working-tree state the AI was rewriting toward. Short
//               bullet bodies; same number of versions/sections so the
//               diff is "every line shrank" rather than "lines removed".
function buildChangelogVersions(versionCount: number): {
  large: string;
  trimmed: string;
} {
  const sections = ['Added', 'Changed', 'Fixed', 'Removed'];

  const largeLines: string[] = ['# Changelog', '', 'All notable changes documented here.', ''];
  const trimmedLines: string[] = ['# Changelog', '', 'All notable changes documented here.', ''];

  for (let v = 0; v < versionCount; v++) {
    const header = `## [0.${v}.0] - 2026-01-${(v % 28) + 1}`;
    largeLines.push(header);
    largeLines.push('');
    trimmedLines.push(header);
    trimmedLines.push('');

    for (const section of sections) {
      largeLines.push(`### ${section}`);
      trimmedLines.push(`### ${section}`);

      for (let i = 0; i < 5; i++) {
        // Large: commit-message-style bullet (~88 bytes), close to the real
        // mix of `fix(...)` / `feat(...)` lines that filled HEAD CHANGELOG.
        largeLines.push(
          `- v${v} ${section} item ${i}: descriptive bullet text padded to realistic length for shape.`,
        );
        largeLines.push(
          `  - Nested explanatory detail with additional context padded out a bit.`,
        );
        // Trimmed: short bullet (~45 bytes) — same line, shorter content.
        trimmedLines.push(`- v${v} ${section} item ${i}: short bullet text.`);
        trimmedLines.push(`  - Nested detail for the bullet above.`);
      }
      largeLines.push('');
      trimmedLines.push('');
    }
  }

  return { large: largeLines.join('\n'), trimmed: trimmedLines.join('\n') };
}

let electronApp: ElectronApplication;
let page: Page;
let workspaceDir: string;
let largeMarkdown: string; // ~280 KB trimmed version (what's on disk)
let largeMarkdownPreTrim: string; // ~420 KB pre-trim version (pre-edit tag)

test.beforeAll(async () => {
  workspaceDir = await createTempWorkspace();
  const { large, trimmed } = buildChangelogVersions(130);
  largeMarkdown = trimmed;
  largeMarkdownPreTrim = large;

  await fs.writeFile(path.join(workspaceDir, TEST_FILES.plainOpen), largeMarkdown, 'utf8');
  await fs.writeFile(
    path.join(workspaceDir, TEST_FILES.pendingDiffOpen),
    largeMarkdown,
    'utf8',
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

// Sanity check on the fixtures. If they stop resembling the real
// CHANGELOG (way smaller / way larger / has tables), revisit.
test('fixtures are CHANGELOG-shaped', () => {
  const trimmedBytes = Buffer.byteLength(largeMarkdown, 'utf8');
  const trimmedLines = largeMarkdown.split('\n').length;
  const preTrimBytes = Buffer.byteLength(largeMarkdownPreTrim, 'utf8');
  const preTrimLines = largeMarkdownPreTrim.split('\n').length;

  // Trimmed (working-tree) state: ~280 KB / ~6,600 lines.
  expect(trimmedBytes).toBeGreaterThan(200_000);
  expect(trimmedBytes).toBeLessThan(500_000);
  expect(trimmedLines).toBeGreaterThan(5_000);

  // Pre-trim (HEAD) state: ~420 KB / similar line count.
  expect(preTrimBytes).toBeGreaterThan(380_000);
  expect(preTrimBytes).toBeLessThan(550_000);
  expect(preTrimLines).toBeGreaterThan(5_000);

  // The diff is "every line shrank" -- line count moves <5%.
  const lineDeltaPct = Math.abs(preTrimLines - trimmedLines) / preTrimLines;
  expect(lineDeltaPct).toBeLessThan(0.05);

  // Byte size dropped substantially (>30%).
  expect((preTrimBytes - trimmedBytes) / preTrimBytes).toBeGreaterThan(0.3);

  expect(largeMarkdown.includes('|---')).toBe(false);
  expect(largeMarkdownPreTrim.includes('|---')).toBe(false);
});

test('opening a 280 KB markdown file does not hang the renderer', async () => {
  const t0 = Date.now();
  await openFileFromTree(page, TEST_FILES.plainOpen);
  await page.waitForSelector(ACTIVE_EDITOR_SELECTOR, {
    timeout: TEST_TIMEOUTS.EDITOR_LOAD * 4, // 12s -- generous, normal open is sub-second
  });
  const openMs = Date.now() - t0;

  // Surface the timing so we can compare against the pending-diff case.
  console.log(`[large-markdown] plain open took ${openMs}ms`);

  // Renderer must still be responsive. If the main thread is pinned the
  // page.evaluate() round-trip will time out long before 10s.
  const responsive = await page.evaluate(async () => {
    // Cheap round-trip: read a global the app sets at startup and return
    // a timestamp. If the renderer event loop is blocked, this never lands.
    return { ok: true, ts: Date.now(), workspace: (window as any).__workspacePath };
  });
  expect(responsive.ok).toBe(true);
  expect(typeof responsive.workspace).toBe('string');

  // Wall-time guard: the symptom in production was ~30s. Anything past 10s
  // here means we've regressed back toward that range.
  expect(openMs).toBeLessThan(10_000);

  await closeTabByFileName(page, TEST_FILES.plainOpen);
});

test('opening a 280 KB markdown file WITH a pending AI diff does not hang the renderer', async () => {
  const filePath = path.join(workspaceDir, TEST_FILES.pendingDiffOpen);

  // Pre-seed the pre-edit tag with the LARGE (~420 KB) pre-trim snapshot.
  // Disk holds the TRIMMED (~280 KB) version. This is the exact diff that
  // was in flight at crash time: AI session rewrote CHANGELOG.md down,
  // pre-edit tag captured the large pre-state, and on file open
  // TabEditor.checkAndApplyPendingDiffs walks the full
  // clear() + $convertFromEnhancedMarkdownString(largeOld) +
  // APPLY_MARKDOWN_REPLACE_COMMAND(trimmedNew) path -- stacking both
  // parses + a tree-match back-to-back on the renderer main thread.
  await page.evaluate(
    async ({ wp, fp, preTrim }) => {
      await (window as any).electronAPI.history.createTag(
        wp,
        fp,
        'large-md-pending-diff-tag',
        preTrim,
        'large-md-test-session',
        'test-large-markdown',
      );
    },
    { wp: workspaceDir, fp: filePath, preTrim: largeMarkdownPreTrim },
  );
  await page.waitForTimeout(100);

  const t0 = Date.now();
  await openFileFromTree(page, TEST_FILES.pendingDiffOpen);
  await page.waitForSelector(ACTIVE_EDITOR_SELECTOR, {
    timeout: TEST_TIMEOUTS.EDITOR_LOAD * 6, // 18s -- pending-diff path is the slow one
  });
  const openMs = Date.now() - t0;

  console.log(`[large-markdown] pending-diff open took ${openMs}ms`);

  // Renderer responsiveness check, same as the plain case.
  const responsive = await page.evaluate(async () => ({
    ok: true,
    ts: Date.now(),
    workspace: (window as any).__workspacePath,
  }));
  expect(responsive.ok).toBe(true);
  expect(typeof responsive.workspace).toBe('string');

  // Same 10s budget as plain open -- diff-on-mount should not be a giant
  // multiplier. The bug we're chasing is "diff-on-mount turns this into a
  // 30s hang"; passing this assertion means the amplifier is gone.
  expect(openMs).toBeLessThan(10_000);

  await closeTabByFileName(page, TEST_FILES.pendingDiffOpen);
});
