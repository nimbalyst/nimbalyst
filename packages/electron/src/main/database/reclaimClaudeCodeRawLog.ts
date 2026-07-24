/**
 * One-time maintenance: reclaim disk wasted by the Claude Code raw message log.
 *
 * The Claude Agent SDK attaches a heavy `tool_use_result` sidecar (the entire
 * pre-edit file + structured patch + redundant old/new strings) and a ~12 KB
 * `signature` blob on every thinking block. We persist the chunk verbatim into
 * `ai_agent_messages`, so on a real workload ~60% of the claude-code raw log is
 * data no part of Nimbalyst reads (transcript, UI, and resume all ignore it; the
 * rendered Edit diff comes from the tool_use CALL, and resume uses the SDK's own
 * history.jsonl).
 *
 * `slimClaudeCodeChunkForStorage` now strips these at write time, but existing
 * rows stay bloated. This pass rewrites them and (optionally) VACUUMs to return
 * the freed pages to the filesystem.
 *
 * Safety / behavior:
 *   - Idempotent: re-running only rewrites rows that still shrink.
 *   - Incremental by id, batched, so it never holds the whole table in memory.
 *   - VACUUM is a separate, explicit final step (it exclusively locks the DB).
 */
import type { AppDatabase } from './PGLiteDatabaseWorker';
import { slimClaudeCodeChunkForStorage } from '@nimbalyst/runtime';
import { logger } from '../utils/logger';

export interface ReclaimProgress {
  scanned: number;
  rewritten: number;
  bytesSaved: number;
}

export interface ReclaimResult extends ReclaimProgress {
  vacuumed: boolean;
  vacuumError?: string;
  durationMs: number;
}

const BATCH_SIZE = 1000;

interface RawRow {
  id: number;
  content: string;
}

/**
 * Count rows that still carry trimmable claude-code dead weight. Cheap-ish
 * estimate for a confirmation prompt (still a full scan of the candidate
 * predicate, but no JSON work).
 */
export async function previewReclaimClaudeCodeRawLog(
  db: AppDatabase,
): Promise<{ candidateRows: number }> {
  const res = await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ai_agent_messages
     WHERE source = 'claude-code'
       AND (content LIKE '%"tool_use_result":%' OR content LIKE '%"signature":"%')`,
  );
  const n = res.rows[0]?.n;
  return { candidateRows: typeof n === 'string' ? parseInt(n, 10) : Number(n ?? 0) };
}

export async function reclaimClaudeCodeRawLog(
  db: AppDatabase,
  options: { vacuum?: boolean; onProgress?: (p: ReclaimProgress) => void } = {},
): Promise<ReclaimResult> {
  const startedAt = Date.now();
  const progress: ReclaimProgress = { scanned: 0, rewritten: 0, bytesSaved: 0 };
  let lastId = 0;

  for (;;) {
    const batch = await db.query<RawRow>(
      `SELECT id, content FROM ai_agent_messages
       WHERE source = 'claude-code'
         AND id > $1
         AND (content LIKE '%"tool_use_result":%' OR content LIKE '%"signature":"%')
       ORDER BY id ASC
       LIMIT $2`,
      [lastId, BATCH_SIZE],
    );
    if (batch.rows.length === 0) break;

    for (const row of batch.rows) {
      lastId = row.id;
      progress.scanned++;

      let parsed: unknown;
      try {
        parsed = JSON.parse(row.content);
      } catch {
        continue; // not JSON (shouldn't happen for these) -- leave untouched
      }

      const slimmed = slimClaudeCodeChunkForStorage(parsed);
      if (slimmed === parsed) continue; // already slim -- nothing to do

      const newContent = JSON.stringify(slimmed);
      const saved = row.content.length - newContent.length;
      if (saved <= 0) continue;

      await db.query(`UPDATE ai_agent_messages SET content = $1 WHERE id = $2`, [
        newContent,
        row.id,
      ]);
      progress.rewritten++;
      progress.bytesSaved += saved;
    }

    options.onProgress?.({ ...progress });
    logger.main.info(
      `[ReclaimRawLog] scanned=${progress.scanned} rewritten=${progress.rewritten} ` +
        `saved=${(progress.bytesSaved / 1024 / 1024).toFixed(1)}MB lastId=${lastId}`,
    );
  }

  let vacuumed = false;
  let vacuumError: string | undefined;
  if (options.vacuum) {
    try {
      logger.main.info('[ReclaimRawLog] running VACUUM (this exclusively locks the DB)...');
      await db.query('VACUUM');
      vacuumed = true;
      logger.main.info('[ReclaimRawLog] VACUUM complete');
    } catch (err) {
      vacuumError = String(err);
      logger.main.error(`[ReclaimRawLog] VACUUM failed: ${vacuumError}`);
    }
  }

  return { ...progress, vacuumed, vacuumError, durationMs: Date.now() - startedAt };
}
