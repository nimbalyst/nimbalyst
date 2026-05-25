/**
 * CollabV3 JWT-mismatch hang reproducer
 *
 * Reproduces the renderer/main-process hang observed during long agent
 * runs on 2026-05-21: when CollabV3 has a personal/team JWT subject
 * that doesn't match the configured sync userId, every agent message
 * triggers `MessageSyncHandler.onMessageCreated -> connect()` and
 * floods main.log with `[MessageSyncHandler] Failed to connect session
 * ... CollabV3 JWT/userId mismatch -- connection refused locally`.
 *
 * In `main.1.log` from the bug session, 34% of all lines (1686 / 4986)
 * were that single log message. This spec drives the same code path
 * end-to-end via the test-only `collabv3:hang-repro:*` IPC handlers and
 * asserts the burst is bounded.
 *
 * Expected to FAIL against the current code (no rate-limiting at the
 * MessageSyncHandler / per-session connect() layer) and PASS once a
 * fix lands.
 *
 * Run with: npx playwright test e2e/sync/collabv3-jwt-mismatch-hang.spec.ts
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchElectronApp, createTempWorkspace } from '../helpers';
import {
  dismissAPIKeyDialog,
  waitForWorkspaceReady,
} from '../utils/testHelpers';
import * as fs from 'fs/promises';
import * as path from 'path';

test.describe.configure({ mode: 'serial' });

const MESSAGE_BURST = 100;
const ACCEPTABLE_CONNECT_ATTEMPTS = 5;
const ACCEPTABLE_SYNC_FAILURE_LOGS = 5;

interface ReproStats {
  connectAttempts: number;
  authMismatchThrows: number;
  syncFailureLogs: number;
  providerIsAuthMismatched: boolean | null;
  elapsedMs: number;
}

async function callRepro<T = unknown>(
  page: Page,
  channel: string,
  payload?: unknown,
): Promise<T> {
  return page.evaluate(
    async ({ ch, p }) => {
      return (window as any).electronAPI.invoke(ch, p);
    },
    { ch: channel, p: payload },
  );
}

test.describe('CollabV3 JWT mismatch hang', () => {
  test.setTimeout(60_000);

  let electronApp: ElectronApplication;
  let page: Page;
  let workspaceDir: string;

  test.beforeAll(async () => {
    workspaceDir = await createTempWorkspace();
    await fs.writeFile(
      path.join(workspaceDir, 'README.md'),
      '# Hang repro\n',
      'utf8',
    );

    electronApp = await launchElectronApp({
      workspace: workspaceDir,
      permissionMode: 'allow-all',
    });
    page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await dismissAPIKeyDialog(page);
    await waitForWorkspaceReady(page);
  });

  test.afterAll(async () => {
    try {
      await callRepro(page, 'collabv3:hang-repro:teardown');
    } catch {
      /* ignore */
    }
    await electronApp?.close();
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test(`firing ${MESSAGE_BURST} agent messages with a mismatched JWT should not trigger ${MESSAGE_BURST} connect attempts`, async () => {
    const initResult = await callRepro<{ success: boolean; error?: string }>(
      page,
      'collabv3:hang-repro:init',
    );
    expect(initResult.success, initResult.error).toBe(true);

    // Simulate an active agent streaming MESSAGE_BURST messages back-to-back.
    // In production this is the cadence we see during a tool-heavy turn.
    for (let i = 0; i < MESSAGE_BURST; i += 1) {
      const fireResult = await callRepro<{ success: boolean; error?: string }>(
        page,
        'collabv3:hang-repro:fire-message',
        {
          sessionId: 'sess-hang-repro',
          messageId: `msg-${i}`,
        },
      );
      expect(fireResult.success, fireResult.error).toBe(true);
    }

    const statsResult = await callRepro<{
      success: boolean;
      stats?: ReproStats;
      error?: string;
    }>(page, 'collabv3:hang-repro:get-stats');
    expect(statsResult.success, statsResult.error).toBe(true);
    const stats = statsResult.stats!;
    // eslint-disable-next-line no-console
    console.log('[repro stats]', JSON.stringify(stats));

    // Sanity: the provider's auth-mismatch latch must actually be set --
    // otherwise the test is silently passing because the mismatch never
    // fired, not because the fix is working. `createCollabV3Sync` calls
    // `connectToIndex()` eagerly at construction; with a mismatched JWT
    // that path sets `indexAuthBlocked = true` before any test messages
    // flow, which is exactly the state we want the MessageSyncHandler
    // gate to detect.
    expect(stats.providerIsAuthMismatched).toBe(true);

    // The actual bug: connect() should NOT be retried for every message.
    // Without the fix, this equals MESSAGE_BURST (~100).
    // With the fix (gate auto-connect on AUTH_MISMATCH at the
    // MessageSyncHandler level), it should be a small constant.
    expect(
      stats.connectAttempts,
      `Connect attempts should be bounded; observed ${stats.connectAttempts} / ${MESSAGE_BURST}. ` +
        `This is the renderer-hang surface.`,
    ).toBeLessThanOrEqual(ACCEPTABLE_CONNECT_ATTEMPTS);

    // The flooded log line is the visible symptom in main.log (1686 / 4986
    // lines in the bug session).
    expect(
      stats.syncFailureLogs,
      `Sync failure log lines should be rate-limited; observed ${stats.syncFailureLogs} / ${MESSAGE_BURST}.`,
    ).toBeLessThanOrEqual(ACCEPTABLE_SYNC_FAILURE_LOGS);
  });
});
