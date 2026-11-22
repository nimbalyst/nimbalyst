/**
 * Daily database retention, with no user action.
 *
 * Retention passes existed for tool output, queued prompts and document
 * history, but the first two had no automatic caller and history only ran from
 * an awaited startup step, so the local database grew without bound. Each task
 * here runs once after first-usable (never inline at init; see
 * packages/electron/DATABASE.md) and then once a day while the app stays open.
 *
 * VACUUM is deliberately not scheduled: these passes free pages inside the
 * file, and giving them back to the filesystem stays an explicit user step.
 */

import { runWhenFirstUsable as defaultRunWhenFirstUsable } from './startupMaintenanceGate';
import { logger } from '../utils/logger';
import {
  getDatabaseMaintenanceSettings,
  getToolOutputRetentionCursor,
  setToolOutputRetentionCursor,
} from '../utils/store';
import type { RetentionResult } from '../database/toolOutputRetentionPass';
import { runMessageKindBackfill, type MessageKindBackfillDb } from './messageKindBackfill';
import { runScheduledTrackerBodyCacheRetention } from './tracker/trackerBodyCacheRetention';

export const DAILY_MS = 24 * 60 * 60 * 1000;

/** Completed and failed queued prompts older than this are deleted. */
export const QUEUED_PROMPT_RETENTION_MS = 30 * DAILY_MS;

/**
 * Rows examined per retention request. Each request must finish inside the
 * proxy's 60s request timeout, or the result (and its resume cursor) is lost.
 */
export const TOOL_RETENTION_ROWS_PER_RUN = 20_000;

/** Pause between bounded retention requests so foreground queries interleave. */
const TOOL_RETENTION_INTER_RUN_DELAY_MS = 1000;

export interface MaintenanceSchedulerDeps {
  runWhenFirstUsable?: (label: string, fn: () => Promise<unknown> | unknown) => void;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
}

/**
 * Run `fn` once after first-usable, then every day. Overlapping runs are
 * skipped, and a failure is logged without stopping later runs.
 */
export function scheduleDailyMaintenance(
  label: string,
  fn: () => Promise<unknown>,
  deps: MaintenanceSchedulerDeps = {},
): void {
  const runWhenFirstUsable = deps.runWhenFirstUsable ?? defaultRunWhenFirstUsable;
  const every = deps.setInterval ?? setInterval;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
  runWhenFirstUsable(label, async () => {
    try {
      await run();
    } finally {
      const timer = every(() => {
        run().catch((err) => logger.main.error(`[DatabaseRetention] '${label}' failed:`, err));
      }, DAILY_MS);
      timer.unref?.();
    }
  });
}

/** The slice of `SQLiteDatabaseProxy` the tool-output task needs. */
export interface ToolRetentionRunner {
  toolRetentionRun(retentionDays: number, maxRows?: number, startAfterId?: number): Promise<unknown>;
  /** Used by the message-kind backfill that runs before retention. */
  query?: MessageKindBackfillDb['query'];
}

/**
 * Relabel historical rows to the current `message_kind` classification before
 * retention reads them. A no-op once the backfill has drained, and on PGLite.
 */
export async function runMessageKindBackfillStep(
  getRunner: () => ToolRetentionRunner | null,
  backfill: (db: MessageKindBackfillDb) => Promise<unknown> = runMessageKindBackfill,
): Promise<void> {
  const runner = getRunner();
  if (!runner?.query) return;
  const query = runner.query.bind(runner);
  await backfill({ query });
}

/**
 * Tombstone aged tool output in bounded requests, resuming from the persisted
 * cursor. SQLite only: the pass is written against better-sqlite3 and has no
 * PGLite implementation, so `getRunner` returns null on PGLite and this is a
 * no-op there.
 */
export async function runToolOutputRetention(
  getRunner: () => ToolRetentionRunner | null,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const days = getDatabaseMaintenanceSettings().toolOutputRetentionDays;
  if (days <= 0) return;
  const runner = getRunner();
  if (!runner) return;

  let rewritten = 0;
  let bytesSaved = 0;
  for (;;) {
    const result = (await runner.toolRetentionRun(
      days,
      TOOL_RETENTION_ROWS_PER_RUN,
      getToolOutputRetentionCursor(),
    )) as RetentionResult | null;
    if (!result) break;
    setToolOutputRetentionCursor(result.lastId);
    rewritten += result.rewritten;
    bytesSaved += result.bytesSaved;
    if (!result.stoppedEarly) break;
    await sleep(TOOL_RETENTION_INTER_RUN_DELAY_MS);
  }
  if (rewritten > 0) {
    logger.main.info(
      `[DatabaseRetention] Tool output: rewrote ${rewritten} row(s), freed ${(bytesSaved / 1024 / 1024).toFixed(1)}MB of pages`,
    );
  }
}

/**
 * Schedule the tool-output and queued-prompt passes. Document history is
 * scheduled by the history handlers, which own the configured HistoryManager.
 */
export function scheduleDatabaseRetention(
  opts: {
    getToolRetentionRunner: () => ToolRetentionRunner | null;
    queuedPromptsStore: { cleanup(olderThanMs: number): Promise<number> };
  },
  deps: MaintenanceSchedulerDeps = {},
): void {
  scheduleDailyMaintenance('tool-output-retention', async () => {
    // A backfill failure must not cost the day's retention run.
    try {
      await runMessageKindBackfillStep(opts.getToolRetentionRunner);
    } catch (err) {
      logger.main.error('[DatabaseRetention] message-kind backfill failed:', err);
    }
    await runToolOutputRetention(opts.getToolRetentionRunner);
  }, deps);
  scheduleDailyMaintenance(
    'queued-prompts-retention',
    () => opts.queuedPromptsStore.cleanup(QUEUED_PROMPT_RETENTION_MS),
    deps,
  );
  scheduleDailyMaintenance('tracker-body-cache-retention', () => runScheduledTrackerBodyCacheRetention(opts.getToolRetentionRunner), deps);
}
