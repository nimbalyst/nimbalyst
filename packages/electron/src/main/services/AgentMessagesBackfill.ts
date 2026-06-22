/**
 * AgentMessagesBackfill
 *
 * One-shot maintenance pass that runs at startup after RepositoryManager has
 * wired up the agent-messages store. A single combined pass walks rows that
 * have not yet been classified (`message_kind IS NULL`) and, for each row,
 * either:
 *
 *   - DELETEs it, if it is a transient claude-code chunk the live write-side
 *     filter now drops at insert time (`hook_started`, `task_progress`,
 *     `tool_progress`, `auth_status`, `rate_limit_event`, etc.). Existing
 *     rows of these types are pure dead storage -- the parser ignores them.
 *
 *   - UPDATEs `searchable_text` + `message_kind` using the same
 *     `extractSearchable` extractor the write path uses, so search behavior
 *     is identical regardless of when the row was written.
 *
 * The pass is idempotent: each row is visited exactly once across the DB's
 * lifetime. After the first run completes, the gating SELECT returns zero
 * rows and subsequent startups exit immediately.
 *
 * Why `message_kind IS NULL` (not `metadata IS NULL`): `metadata` is the
 * natural state of almost every claude-code row, so it does not narrow the
 * scan. `message_kind` is set on every visited row, giving us a real
 * high-watermark. Past incident: the previous two-pass implementation
 * rescanned ~590k rows on every restart (the transient-delete pass used
 * `metadata IS NULL` as its filter), saturating the write lane for ~2 minutes
 * and tail-blocking `ai:loadSession` for 56s.
 *
 * Plan: nimbalyst-local/plans/canonical-transcript-deprecation.md (Phases 1C, 5).
 */

import { extractSearchable } from '@nimbalyst/runtime/ai/server/transcript/searchableTextExtractor';
import type { StoreDbAdapter } from '../database/sqlite/SQLiteStoreAdapter';
import { getAppSetting, setAppSetting } from '../utils/store';
import { logger } from '../utils/logger';

interface BackfillChunkRow {
  id: number;
  source: string;
  direction: 'input' | 'output';
  content: string;
  metadata: string | Record<string, unknown> | null;
  hidden: boolean | number | null;
}

const SELECT_CHUNK_SIZE = 1000;

/**
 * Pause between chunks so the backfill cedes the shared SQLite worker to any
 * user-facing queries that arrive mid-run. The worker is FIFO; without a gap,
 * back-to-back chunk traffic keeps it busy. Even though the pass is now
 * deferred past first-usable (NIM-899), this keeps it a good citizen if it runs
 * long. Tests pass 0 to stay fast and deterministic.
 */
const DEFAULT_INTER_CHUNK_DELAY_MS = 15;

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export interface AgentMessagesBackfillOptions {
  /**
   * Optional override of the chunk size used for SELECT/UPDATE batches.
   * Lower values reduce per-iteration latency at the cost of more round-trips.
   */
  chunkSize?: number;
  /**
   * Milliseconds to pause between chunks (default 15). Set to 0 in tests.
   */
  interChunkDelayMs?: number;
  /**
   * If false, skip the transient-row DELETE pass. Used in tests to isolate
   * the extractor pass from the cleanup pass.
   */
  deleteTransients?: boolean;
  /**
   * Test hook: read/write the run-once flag for the historical-transient
   * cleanup. Production uses the electron-store app-settings file.
   */
  flagStore?: {
    get: (key: string) => boolean | undefined;
    set: (key: string, value: boolean) => void;
  };
}

interface BackfillStats {
  searchableTextBackfilled: number;
  transientsDeleted: number;
  /**
   * Rows deleted by the one-shot historical sweep that catches transients
   * inserted during the window between Phase 1B (extractor at insert time)
   * and the write-side filter that now drops them at insert. Distinct from
   * `transientsDeleted` so tests can assert each pass independently.
   */
  historicalTransientsDeleted: number;
}

/**
 * Electron-store key that marks the historical-transient sweep complete.
 * Bumping the suffix (V2, V3, ...) forces the sweep to re-run, e.g. if we
 * widen the detector and want to re-scan once.
 */
const HISTORICAL_CLEANUP_FLAG_KEY = 'agentMessagesTransientHistoricalCleanupV1' as const;

/**
 * Electron-store key marking the searchable_text/message_kind backfill drained.
 * Once set, the extractor pass is skipped entirely on subsequent startups so we
 * never re-scan ai_agent_messages. Before this gate, the pending-count probe
 * full-scanned ~1.3M rows (~12s) on every startup -- and because the pass runs
 * on the shared single-threaded SQLite worker, that scan head-of-line-blocked
 * the entire startup (sessions:list, tracker-items-list, ai:loadSession all
 * queued behind it). The live write path sets message_kind at insert time, so
 * no new NULL rows appear once drained. Bump the suffix to force a re-scan.
 * NIM-899.
 */
const SEARCHABLE_BACKFILL_COMPLETE_FLAG_KEY = 'agentMessagesSearchableBackfillCompleteV1' as const;

/**
 * Run the full maintenance pass. Logs progress; failures are caught and
 * logged so startup is never blocked by a backfill regression.
 */
export async function runAgentMessagesBackfill(
  db: StoreDbAdapter,
  options: AgentMessagesBackfillOptions = {},
): Promise<BackfillStats> {
  const stats: BackfillStats = {
    searchableTextBackfilled: 0,
    transientsDeleted: 0,
    historicalTransientsDeleted: 0,
  };
  const deleteTransients = options.deleteTransients !== false;
  const readFlag = options.flagStore?.get ?? ((k: string) => getAppSetting<boolean>(k));
  const writeFlag = options.flagStore?.set ?? ((k: string, v: boolean) => setAppSetting<boolean>(k, v));
  // Entry log fires before any await so we can verify the function was even
  // reached. Past observation: on a 1.36M-row DB the function appeared to
  // never run -- no [AgentMessagesBackfill] lines of any kind in the log --
  // and we had no way to distinguish "never invoked", "scheduled but
  // unresolved", and "ran to completion with updated=0".
  logger.main.info('[AgentMessagesBackfill] starting');
  const startedAt = Date.now();
  const interChunkDelayMs = options.interChunkDelayMs ?? DEFAULT_INTER_CHUNK_DELAY_MS;
  if (readFlag(SEARCHABLE_BACKFILL_COMPLETE_FLAG_KEY) === true) {
    // Drained on a previous run -- skip the extractor pass so we never re-scan
    // ai_agent_messages on the shared SQLite worker at startup. NIM-899.
    logger.main.info('[AgentMessagesBackfill] searchable/message_kind backfill already complete; skipping scan');
  } else {
    try {
      const result = await backfillAndCleanup(
        db,
        options.chunkSize ?? SELECT_CHUNK_SIZE,
        deleteTransients,
        interChunkDelayMs,
      );
      stats.searchableTextBackfilled = result.updated;
      stats.transientsDeleted = result.deleted;
      // Only record completion when the pass drained every NULL row without a
      // single UPDATE failure -- a failed row stays NULL and must be retried on
      // the next startup, so we must not flag the backfill done.
      if (result.drainedClean) {
        writeFlag(SEARCHABLE_BACKFILL_COMPLETE_FLAG_KEY, true);
      }
    } catch (err) {
      logger.main.error('[AgentMessagesBackfill] backfill failed:', err);
    }
  }

  if (deleteTransients) {
    try {
      stats.historicalTransientsDeleted = await cleanupAlreadyClassifiedTransients(
        db,
        options.chunkSize ?? SELECT_CHUNK_SIZE,
        options.flagStore,
        interChunkDelayMs,
      );
    } catch (err) {
      logger.main.error('[AgentMessagesBackfill] historical transient cleanup failed:', err);
    }
  }
  const elapsedMs = Date.now() - startedAt;
  logger.main.info(
    `[AgentMessagesBackfill] complete in ${elapsedMs}ms ` +
      `backfilled=${stats.searchableTextBackfilled} ` +
      `transientsDeleted=${stats.transientsDeleted} ` +
      `historicalTransientsDeleted=${stats.historicalTransientsDeleted}`,
  );
  return stats;
}

async function backfillAndCleanup(
  db: StoreDbAdapter,
  chunkSize: number,
  deleteTransients: boolean,
  interChunkDelayMs: number,
): Promise<{ updated: number; deleted: number; drainedClean: boolean }> {
  let updated = 0;
  let deleted = 0;
  let lastId = 0;
  let totalFailures = 0;

  // No upfront COUNT(*) probe here: `WHERE message_kind IS NULL` cannot use the
  // partial index (idx_ai_agent_messages_user_prompts is `WHERE searchable_text
  // IS NOT NULL`), so counting full-scanned ~1.3M rows for ~12s on every startup
  // just to print a log line -- and that scan blocked the whole startup on the
  // shared SQLite worker. The chunked loop below reveals the same information
  // via its progress logs and the natural-drain break. NIM-899.

  let chunkIdx = 0;
  let lastProgressLogAt = Date.now();

  // Gate on `message_kind IS NULL` so each row is visited exactly once across
  // the DB's lifetime. The live write path sets message_kind at insert time
  // (see AIProvider.ts), so this loop only walks the historical backlog.

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { rows } = await db.query<BackfillChunkRow>(
      `SELECT id, source, direction, content, metadata, hidden
       FROM ai_agent_messages
       WHERE message_kind IS NULL AND id > $1
       ORDER BY id
       LIMIT $2`,
      [lastId, chunkSize],
    );
    if (rows.length === 0) break;

    const toDelete: number[] = [];
    let perRowFailures = 0;

    for (const row of rows) {
      if (deleteTransients && row.source === 'claude-code' && isTransientContentString(row.content)) {
        toDelete.push(row.id);
        continue;
      }

      let metadata: Record<string, unknown> | null = null;
      if (row.metadata) {
        if (typeof row.metadata === 'string') {
          try { metadata = JSON.parse(row.metadata) as Record<string, unknown>; } catch { metadata = null; }
        } else if (typeof row.metadata === 'object') {
          metadata = row.metadata as Record<string, unknown>;
        }
      }
      const hidden = row.hidden === true || row.hidden === 1;
      const { searchableText, messageKind } = extractSearchable({
        source: row.source,
        direction: row.direction,
        content: row.content,
        metadata,
        hidden,
      });
      // Catch per-row so a single bad UPDATE doesn't abort the whole pass.
      // The pre-instrumentation version threw out of the loop on the first
      // failure, leaving the entire historical backlog unbackfilled. We log
      // the row id + error code/stack and move on; the outer loop's
      // `WHERE message_kind IS NULL` gate ensures retries on next startup.
      try {
        await db.query(
          `UPDATE ai_agent_messages SET searchable_text = $1, message_kind = $2 WHERE id = $3`,
          [searchableText, messageKind, row.id],
        );
        updated += 1;
      } catch (err) {
        perRowFailures += 1;
        if (perRowFailures <= 3) {
          const code = (err as { code?: string })?.code;
          const stack = (err as Error)?.stack;
          logger.main.error(
            `[AgentMessagesBackfill] UPDATE failed for row id=${row.id} ` +
              `source=${row.source} dir=${row.direction} code=${code ?? 'n/a'}: ` +
              `${(err as Error).message}\n${stack ?? ''}`,
          );
        }
        // Force the loop to advance past this id so we don't retry it
        // forever within this run. Subsequent startups will revisit via the
        // `message_kind IS NULL` filter -- which is fine because the error
        // signal is what we're after right now.
      }
    }
    if (perRowFailures > 0) {
      totalFailures += perRowFailures;
      logger.main.warn(
        `[AgentMessagesBackfill] chunk had ${perRowFailures} UPDATE failures (showed first 3)`,
      );
    }

    if (toDelete.length > 0) {
      const placeholders = toDelete.map((_, i) => `$${i + 1}`).join(', ');
      await db.query(
        `DELETE FROM ai_agent_messages WHERE id IN (${placeholders})`,
        toDelete,
      );
      deleted += toDelete.length;
    }

    lastId = rows[rows.length - 1].id;
    chunkIdx += 1;
    // Heartbeat at most every 5s so we can see real-time progress without
    // flooding the log. Bounded by chunkIdx too so test runs with chunkSize=1
    // don't go silent for 5s when they finish in milliseconds.
    const now = Date.now();
    if (now - lastProgressLogAt >= 5000 || chunkIdx % 50 === 0) {
      logger.main.info(
        `[AgentMessagesBackfill] progress chunks=${chunkIdx} updated=${updated} ` +
          `deleted=${deleted} lastId=${lastId}`,
      );
      lastProgressLogAt = now;
    }
    if (rows.length < chunkSize) break;
    // Cede the shared SQLite worker between chunks so user-facing queries that
    // arrive mid-run aren't head-of-line-blocked. NIM-899.
    await delay(interChunkDelayMs);
  }

  if (updated > 0) {
    logger.main.info(`[AgentMessagesBackfill] populated searchable_text/message_kind for ${updated} rows`);
  }
  if (deleted > 0) {
    logger.main.info(`[AgentMessagesBackfill] deleted ${deleted} transient claude-code rows`);
  }
  // The while-loop only exits via its natural-drain breaks (empty chunk or a
  // short final chunk), so reaching here means every NULL row was visited.
  // `drainedClean` gates the run-once completion flag: a row whose UPDATE
  // failed stays NULL and must be revisited next startup.
  return { updated, deleted, drainedClean: totalFailures === 0 };
}

/**
 * One-shot historical sweep for transient claude-code rows that were
 * inserted with `message_kind` already populated (typically 'system'), which
 * happens for rows written between Phase 1B (extractor runs at insert) and
 * the write-side transient filter landing. Those rows are invisible to
 * `backfillAndCleanup` because its gate is `message_kind IS NULL`.
 *
 * Runs once per machine, gated by an electron-store flag. Subsequent calls
 * return immediately. The scan filter narrows by `searchable_text IS NULL`
 * (transient claude-code rows have NULL searchable_text) which keeps the
 * candidate set small even on large logs.
 */
async function cleanupAlreadyClassifiedTransients(
  db: StoreDbAdapter,
  chunkSize: number,
  flagStore?: AgentMessagesBackfillOptions['flagStore'],
  interChunkDelayMs = 0,
): Promise<number> {
  const readFlag = flagStore?.get ?? ((k: string) => getAppSetting<boolean>(k));
  const writeFlag = flagStore?.set ?? ((k: string, v: boolean) => setAppSetting<boolean>(k, v));

  if (readFlag(HISTORICAL_CLEANUP_FLAG_KEY) === true) {
    return 0;
  }

  let totalDeleted = 0;
  let lastId = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { rows } = await db.query<{ id: number; content: string }>(
      `SELECT id, content FROM ai_agent_messages
       WHERE source = 'claude-code'
         AND message_kind IS NOT NULL
         AND searchable_text IS NULL
         AND id > $1
       ORDER BY id
       LIMIT $2`,
      [lastId, chunkSize],
    );
    if (rows.length === 0) break;

    const toDelete: number[] = [];
    for (const row of rows) {
      if (isTransientContentString(row.content)) {
        toDelete.push(row.id);
      }
    }

    if (toDelete.length > 0) {
      const placeholders = toDelete.map((_, i) => `$${i + 1}`).join(', ');
      await db.query(
        `DELETE FROM ai_agent_messages WHERE id IN (${placeholders})`,
        toDelete,
      );
      totalDeleted += toDelete.length;
    }

    lastId = rows[rows.length - 1].id;
    if (rows.length < chunkSize) break;
    await delay(interChunkDelayMs);
  }

  // Set the flag only on clean completion. A mid-scan crash leaves the flag
  // unset so the next startup retries.
  writeFlag(HISTORICAL_CLEANUP_FLAG_KEY, true);

  if (totalDeleted > 0) {
    logger.main.info(
      `[AgentMessagesBackfill] historical sweep deleted ${totalDeleted} already-classified transient claude-code rows`,
    );
  }
  return totalDeleted;
}

const TRANSIENT_SYSTEM_SUBTYPES = new Set([
  'hook_started',
  'hook_response',
  'task_started',
  'task_progress',
  'task_notification',
]);

const TRANSIENT_CHUNK_TYPES = new Set([
  'tool_progress',
  'tool_use_summary',
  'auth_status',
  'rate_limit_event',
]);

function isTransientContentString(content: string): boolean {
  try {
    const p = JSON.parse(content) as { type?: string; subtype?: string };
    if (!p || typeof p !== 'object') return false;
    if (typeof p.type !== 'string') return false;
    if (p.type === 'system' && typeof p.subtype === 'string') {
      return TRANSIENT_SYSTEM_SUBTYPES.has(p.subtype);
    }
    return TRANSIENT_CHUNK_TYPES.has(p.type);
  } catch {
    return false;
  }
}
