/**
 * toolOutputRetentionPass -- reclaim disk by tombstoning aged tool output.
 *
 * Layer 2 driver. The rewrite itself is pure and lives in
 * `@nimbalyst/runtime` (`toolOutputRetention`); this file owns row selection,
 * batching, and lane discipline.
 *
 * ## Why this runs on the background lane
 *
 * This is not a theoretical concern. While measuring the table for the plan
 * behind this work, four consecutive read-only analytical scans of
 * `ai_agent_messages` each held the SQLite worker to its 35-second timeout and
 * hung the app badly enough to need a restart -- routine reads
 * (`document_history`, `session_files`, normally 150-250 ms) queued behind
 * them. This pass touches the same table and additionally rewrites hundreds of
 * thousands of rows, so run naively it is an outage rather than a slow
 * maintenance job.
 *
 * `WriteCoordinator.runBackground` exists for exactly this: chunks yield to
 * the event loop between units, no hot-lane write runs concurrently with a
 * chunk, and any chunk over 50 ms is reported. Every query below is bounded by
 * `id` range and `LIMIT` -- there is no unbounded scan anywhere in this file,
 * including the estimate.
 *
 * ## What is never touched
 *
 *   - `direction = 'input'`  -- every user prompt, forever
 *   - `message_kind = 'assistant'` -- every word the agent said, forever
 *   - `tool_use` calls -- name, arguments and Edit diffs, so "what did the
 *     agent do to my repo" stays answerable
 *   - `system/init` / `compact_boundary` -- session forensics
 *   - rows in a session that is currently running or waiting on the user
 */
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { tombstoneRawContent } from '@nimbalyst/runtime/storage/toolOutputRetention';
import {
  classifyPrunableRawMessage,
  readCodexDeltaItemId,
  PRUNE_REASON_SUPERSESSION_PROOF,
  type PruneReason,
} from '@nimbalyst/runtime/storage/rawMessagePrune';

/** Rows examined per background chunk. Sized to stay well under the
 *  coordinator's 50 ms slow-chunk warning on a cold cache. */
const CHUNK_ROWS = 250;

/** Rows sampled by the estimate. Deliberately bounded -- the full-table
 *  `SUM(LENGTH(content))` version of this query is what hung the app. */
const ESTIMATE_SAMPLE_ROWS = 2000;

/**
 * Only these providers have a tombstone shape. Others are left alone rather
 * than guessed at.
 */
const ELIGIBLE_SOURCE_PREFIXES = ['claude-code', 'openai-codex', 'copilot-cli', 'grok-build', 'cursor-agent'];

export interface RetentionProgress {
  scanned: number;
  rewritten: number;
  bytesSaved: number;
}

export interface RetentionResult extends RetentionProgress {
  durationMs: number;
  cutoffIso: string;
  stoppedEarly: boolean;
  /**
   * Highest row id examined. Pass it back as `startAfterId` so a scheduled run
   * resumes where the last one stopped instead of re-reading every row it
   * already tombstoned.
   */
  lastId: number;
}

export interface RetentionOptions {
  /** Age threshold in days. Rows newer than this are never touched. */
  retentionDays: number;
  /** Cap on rows examined in one run so a first pass on a huge table ends. */
  maxRows?: number;
  /** Resume after this row id. Omit to walk from the start of the table. */
  startAfterId?: number;
  onProgress?: (p: RetentionProgress) => void;
  /**
   * Log sink. Injected rather than imported because this pass executes inside
   * the SQLite worker_threads worker, where `electron-log/main` cannot be
   * required (no `electron` module resolution from a worker bundle). Defaults
   * to a no-op.
   */
  log?: (level: 'info' | 'warn', msg: string) => void;
  /** Injectable for tests. */
  now?: () => number;
}

interface CandidateRow {
  id: number;
  source: string;
  content: string;
  /** Selected by `CANDIDATE_SQL` only; the sampling query filters age in SQL. */
  created_at?: string;
}

function cutoffIso(retentionDays: number, now: number): string {
  return new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

const SOURCE_PREDICATE = ELIGIBLE_SOURCE_PREFIXES.map(() => `m.source LIKE ? || '%'`).join(' OR ');

/**
 * Candidate selection. Tool rows only, in a session that is not currently
 * active.
 *
 * Age is NOT filtered here. The walk is resumed from a persisted row id, and
 * ids do not rise with timestamps: an imported or copied row keeps its old
 * `created_at` at a new id. With `created_at < cutoff` in this query, one such
 * row carried the cursor past every younger row below it, and those rows were
 * never examined again once they aged (NIM-7735; on the measured install the
 * cursor sat 558k rows past the cutoff and a nightly run freed 5-17 MB). The
 * age filter also made the `LIMIT` scan walk every young row to the end of the
 * table looking for matches, an 11 s chunk on the same install. The chunk loop
 * reads `created_at` and stops at the first row still inside the window.
 *
 * `tool` covers claude-code and, since the classifier change, codex
 * app-server tool items. `meta` is still admitted, and the pure rewrite
 * decides whether a row actually carries output, because three populations of
 * tool output remain under `meta`: codex rows the message-kind backfill has not
 * reached yet, the legacy codex SDK and ACP shapes the classifier does not
 * label, and hidden rows, which are `meta` for every provider. Codex lifecycle
 * frames are `system` now, so they no longer reach this query at all.
 */
const CANDIDATE_SQL = `
  SELECT m.id, m.source, m.content, m.created_at
  FROM ai_agent_messages m
  JOIN ai_sessions s ON s.id = m.session_id
  WHERE m.id > ?
    AND m.direction = 'output'
    AND m.message_kind IN ('tool', 'meta')
    AND (${SOURCE_PREDICATE})
    AND s.status NOT IN ('running', 'waiting_for_input')
  ORDER BY m.id ASC
  LIMIT ?
`;

/**
 * Sampling variant of `CANDIDATE_SQL`, bounded ABOVE as well as below.
 *
 * `CANDIDATE_SQL` is correct for the rewrite, which legitimately walks forward
 * until it finds its chunk. For a probe that is wrong: with `id > ?` alone,
 * SQLite keeps scanning past the probe's region hunting for `LIMIT` matches, so
 * a sparse stretch turns a "bounded" probe into a long scan. Bounding the id
 * range makes each probe's worst case proportional to the range, which is what
 * this file's header promises.
 */
const SAMPLE_SQL = `
  SELECT m.id, m.source, m.content
  FROM ai_agent_messages m
  JOIN ai_sessions s ON s.id = m.session_id
  WHERE m.id > ?
    AND m.id <= ?
    AND m.created_at < ?
    AND m.direction = 'output'
    AND m.message_kind IN ('tool', 'meta')
    AND (${SOURCE_PREDICATE})
    AND s.status NOT IN ('running', 'waiting_for_input')
  ORDER BY m.id ASC
  LIMIT ?
`;

/**
 * Estimate reclaimable bytes from a bounded sample, for a confirmation prompt.
 * Extrapolates from the sample's hit rate rather than scanning the table.
 *
 * The confidence fields exist because a bare `estimatedBytesSaved: 0` is
 * ambiguous, and the ambiguity cost a full investigation (NIM-3661): it means
 * both "there is nothing to reclaim" and "my sample happened to find nothing".
 * A caller must be able to tell those apart.
 */
export interface ReclaimEstimate {
  sampledRows: number;
  sampleBytesSaved: number;
  candidateRows: number;
  estimatedBytesSaved: number;
  /** `sampledRows / candidateRows`. Small by construction; report, don't hide. */
  sampleCoverage: number;
  /** Independent id probes that returned at least one row. */
  probesTaken: number;
  /** True when the sample is too thin for the extrapolation to mean much. */
  lowConfidence: boolean;
  /** Set whenever the number needs a caveat spoken out loud. */
  note?: string;
}

/** Id span counted per estimate chunk, so the worker yields while counting. */
const ESTIMATE_COUNT_WINDOW = 200_000;

/**
 * Independent probes per id window.
 *
 * The original sampler took the first `budget` candidate rows after the window
 * cursor. On the measured install that was ~125 CONSECUTIVE ids out of a
 * 200,000-id window -- 0.06% coverage, drawn from a single session's contiguous
 * run, eight times over. Whole shapes were invisible to it. Spreading the same
 * row budget across probes at fixed offsets costs the same number of rows and
 * actually crosses session boundaries.
 */
const PROBES_PER_WINDOW = 8;

/** Below this many sampled rows the extrapolation is not worth trusting. */
const MIN_TRUSTWORTHY_SAMPLE = 250;

/**
 * Chunked estimate for the background lane.
 *
 * Counting all candidates in ONE statement took 5.7 s against a real 10 GB
 * store, and better-sqlite3 is synchronous -- that is 5.7 s of blocked worker
 * behind a single click, which is the exact failure this whole file exists to
 * avoid. (It never showed up in `_perf_slow_queries` either: the estimate runs
 * on the raw handle and bypasses the instrumented query path, the same blind
 * spot that hid the 35 s timeouts during the original investigation.) Counting
 * an id window per chunk lets the coordinator yield between windows.
 */
/**
 * Attach confidence to a raw estimate.
 *
 * The rule this enforces: a caller must never be handed a number that reads as
 * "there is nothing here" when what actually happened is "I barely looked".
 * The zero that started NIM-3661 was technically true and completely
 * misleading, and it survived review because nothing in the shape of the result
 * invited the question.
 */
export function finalizeEstimate(raw: ReclaimEstimate): ReclaimEstimate {
  const { sampledRows, sampleBytesSaved, candidateRows } = raw;

  if (candidateRows === 0) {
    return { ...raw, lowConfidence: false, note: 'No rows are old enough to reclaim.' };
  }

  if (sampledRows === 0) {
    return {
      ...raw,
      lowConfidence: true,
      note: `Sampled no rows out of ${candidateRows.toLocaleString()} candidates, so nothing `
        + 'can be concluded about how much is reclaimable.',
    };
  }

  const thin = sampledRows < MIN_TRUSTWORTHY_SAMPLE;
  const coveragePct = (raw.sampleCoverage * 100).toFixed(3);

  if (sampleBytesSaved === 0) {
    return {
      ...raw,
      lowConfidence: true,
      note: `The ${sampledRows.toLocaleString()} sampled rows (${coveragePct}% of `
        + `${candidateRows.toLocaleString()} candidates, ${raw.probesTaken} probes) contained `
        + 'nothing reclaimable. That is a floor, not a guarantee the rest is empty.',
    };
  }

  return {
    ...raw,
    lowConfidence: thin,
    note: thin
      ? `Based on only ${sampledRows.toLocaleString()} sampled rows (${coveragePct}% of `
        + `${candidateRows.toLocaleString()} candidates); treat as a rough order of magnitude.`
      : undefined,
  };
}

export function createToolOutputEstimateWork(
  retentionDays: number,
  onDone: (estimate: ReclaimEstimate) => void,
  now: number = Date.now(),
) {
  const cutoff = cutoffIso(retentionDays, now);
  const iso = new Date(now).toISOString();

  let bounds: { lo: number; hi: number } | null = null;
  let cursor = 0;
  let candidateRows = 0;
  let sampleBytesSaved = 0;
  let sampledRows = 0;
  let sampleTaken = 0;
  let probesTaken = 0;
  let perProbe = 1;

  return {
    name: 'tool-output-retention-estimate',
    chunk(db: SqliteDatabase): { done: boolean } {
      if (!bounds) {
        const b = db
          .prepare(
            `SELECT MIN(id) AS lo, MAX(id) AS hi FROM ai_agent_messages WHERE created_at < ?`,
          )
          .get(cutoff) as { lo: number | null; hi: number | null } | undefined;
        bounds = { lo: Number(b?.lo ?? 0), hi: Number(b?.hi ?? 0) };
        // Windows are half-open (`id > cursor`), so start one below the lowest
        // id or the very first candidate row is never counted.
        cursor = bounds.lo - 1;

        // Spend the whole row budget across however many probes the id range
        // actually yields. Deriving this from a fixed guess at the window count
        // is what left the old sampler taking 800 rows when it was budgeted
        // 2,000 -- and taking them from eight places instead of sixty-four.
        const totalWindows = Math.max(
          1,
          Math.ceil((bounds.hi - bounds.lo + 1) / ESTIMATE_COUNT_WINDOW),
        );
        perProbe = Math.max(1, Math.ceil(ESTIMATE_SAMPLE_ROWS / (totalWindows * PROBES_PER_WINDOW)));
      }

      if (cursor > bounds.hi) {
        const perRow = sampledRows > 0 ? sampleBytesSaved / sampledRows : 0;
        onDone(finalizeEstimate({
          sampledRows,
          sampleBytesSaved,
          candidateRows,
          estimatedBytesSaved: Math.round(perRow * candidateRows),
          sampleCoverage: candidateRows > 0 ? sampledRows / candidateRows : 0,
          probesTaken,
          lowConfidence: false,
        }));
        return { done: true };
      }

      const windowEnd = cursor + ESTIMATE_COUNT_WINDOW;
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM ai_agent_messages m
             JOIN ai_sessions s ON s.id = m.session_id
            WHERE m.id > ? AND m.id <= ?
              AND m.created_at < ?
              AND m.direction = 'output'
              AND m.message_kind IN ('tool', 'meta')
              AND (${SOURCE_PREDICATE})
              AND s.status NOT IN ('running', 'waiting_for_input')`,
        )
        .get(cursor, windowEnd, cutoff, ...ELIGIBLE_SOURCE_PREFIXES) as { n: number } | undefined;
      candidateRows += Number(row?.n ?? 0);

      // Sample from every window, and from several points WITHIN each window,
      // so the estimate reflects the whole id range rather than eight
      // contiguous runs of one session apiece.
      const probeStride = Math.max(1, Math.floor(ESTIMATE_COUNT_WINDOW / PROBES_PER_WINDOW));

      for (let probe = 0; probe < PROBES_PER_WINDOW; probe++) {
        if (sampleTaken >= ESTIMATE_SAMPLE_ROWS) break;

        const probeStart = cursor + probe * probeStride;
        if (probeStart > bounds.hi) break;
        const probeEnd = Math.min(probeStart + probeStride, windowEnd);

        const rows = db
          .prepare(SAMPLE_SQL)
          .all(probeStart, probeEnd, cutoff, ...ELIGIBLE_SOURCE_PREFIXES, perProbe) as CandidateRow[];
        if (rows.length > 0) probesTaken++;

        for (const r of rows) {
          sampleTaken++;
          sampledRows++;
          const rewritten = tombstoneRawContent(r.content, r.source, iso);
          if (rewritten !== null) sampleBytesSaved += r.content.length - rewritten.length;
        }
      }

      cursor = windowEnd;
      return { done: false };
    },
  };
}

/**
 * Synchronous convenience wrapper that drives the chunked estimate to
 * completion. Fine for tests and small stores; production callers should hand
 * `createToolOutputEstimateWork` to the background lane instead.
 */
export function estimateReclaimableBytes(
  db: SqliteDatabase,
  retentionDays: number,
  now: number = Date.now(),
): ReclaimEstimate {
  let out: ReclaimEstimate | null = null;
  const work = createToolOutputEstimateWork(retentionDays, (e) => { out = e; }, now);
  while (!work.chunk(db).done) { /* drive to completion */ }
  return out ?? finalizeEstimate({
    sampledRows: 0,
    sampleBytesSaved: 0,
    candidateRows: 0,
    estimatedBytesSaved: 0,
    sampleCoverage: 0,
    probesTaken: 0,
    lowConfidence: false,
  });
}

/**
 * Build the chunked background work. The caller hands this to
 * `SQLiteDatabase.runBackground` so it inherits the coordinator's yielding and
 * hot-lane priority.
 */
export function createToolOutputRetentionWork(
  options: RetentionOptions,
  onDone: (result: RetentionResult) => void,
) {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const startedAt = now();
  const cutoff = cutoffIso(options.retentionDays, startedAt);
  const stampIso = new Date(startedAt).toISOString();
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;

  const progress: RetentionProgress = { scanned: 0, rewritten: 0, bytesSaved: 0 };
  let lastId = options.startAfterId ?? 0;

  return {
    name: 'tool-output-retention',
    chunk(db: SqliteDatabase): { done: boolean } {
      if (progress.scanned >= maxRows) {
        onDone({ ...progress, durationMs: now() - startedAt, cutoffIso: cutoff, stoppedEarly: true, lastId });
        return { done: true };
      }

      const rows = db
        .prepare(CANDIDATE_SQL)
        .all(lastId, ...ELIGIBLE_SOURCE_PREFIXES, CHUNK_ROWS) as CandidateRow[];

      if (rows.length === 0) {
        log(
          'info',
          `[ToolRetention] complete: scanned=${progress.scanned} rewritten=${progress.rewritten} `
            + `saved=${(progress.bytesSaved / 1024 / 1024).toFixed(1)}MB`,
        );
        onDone({ ...progress, durationMs: now() - startedAt, cutoffIso: cutoff, stoppedEarly: false, lastId });
        return { done: true };
      }

      const update = db.prepare('UPDATE ai_agent_messages SET content = ? WHERE id = ?');
      let reachedWindow = false;
      for (const row of rows) {
        const createdAt = row.created_at ?? '';
        // A row dated after "now" (clock skew, a synced row) would otherwise
        // hold the cursor in place forever. Walk past it untouched.
        const futureDated = createdAt > stampIso;
        if (createdAt >= cutoff && !futureDated) {
          // Still inside the retention window. Leave the cursor before this
          // row so the next run starts here once it has aged.
          reachedWindow = true;
          break;
        }
        lastId = row.id;
        progress.scanned++;
        if (futureDated) continue;
        const rewritten = tombstoneRawContent(row.content, row.source, stampIso);
        if (rewritten === null) continue;
        update.run(rewritten, row.id);
        progress.rewritten++;
        progress.bytesSaved += row.content.length - rewritten.length;
      }

      options.onProgress?.({ ...progress });
      if (reachedWindow) {
        log(
          'info',
          `[ToolRetention] complete: scanned=${progress.scanned} rewritten=${progress.rewritten} `
            + `saved=${(progress.bytesSaved / 1024 / 1024).toFixed(1)}MB`,
        );
        onDone({ ...progress, durationMs: now() - startedAt, cutoffIso: cutoff, stoppedEarly: false, lastId });
        return { done: true };
      }
      return { done: false };
    },
  };
}

/* ==========================================================================
 * Prune lane -- delete rows that render nothing at all.
 *
 * The tombstone lane above rewrites a row's payload and keeps the row, because
 * the tool card must still render in sequence. A frame the transcript has no
 * branch for has no card to keep: tombstoning it preserves the row's fixed cost
 * (~167 bytes of index per row across four full-table indexes, plus b-tree
 * overhead) and reclaims only its content, which for these shapes is a couple
 * of hundred bytes. Deleting is what actually recovers them.
 *
 * The decision of WHAT renders nothing is not made here. It lives in
 * `@nimbalyst/runtime/storage/rawMessagePrune`, which derives it from the
 * parsers themselves -- see that module's header for why a destructive path is
 * allowed to trust it. This file only does row selection, batching and lane
 * discipline, exactly as the tombstone lane does.
 *
 * One thing row selection DOES decide, because only it can: whether a delta row
 * is really superseded. Those reasons' premise is "a later row holds this
 * content", and a turn the user cancelled -- or one whose CLI died mid-stream --
 * never wrote that row, leaving the deltas as the only surviving record of the
 * response. The classifier is pure and per-row and cannot see that; the proofs
 * below establish it from the row set, and rows they cannot prove are kept.
 *
 * Both proofs are SCOPED, and that scoping is the correction that matters. A
 * session-wide "some later `item.completed` exists" is not a proof: for
 * completed turn A, cancelled turn B, completed turn C, C's row is later than
 * B's deltas and vouches for a response nobody ever stored. Codex stamps an
 * item id on both the delta and its completion, so its proof is per item.
 * Headless deltas carry no id at all, so their proof is per turn, with turn
 * boundaries read from the session's input rows -- which this lane can never
 * delete, since it selects `direction = 'output'` only.
 * ========================================================================== */

/**
 * Rows examined per prune chunk. Higher than the tombstone lane's 250 because
 * the per-row work is a prefilter and usually not even a JSON.parse, where the
 * tombstone lane parses, walks slots and re-serializes every candidate.
 */
const PRUNE_CHUNK_ROWS = 1000;

export interface PruneProgress {
  scanned: number;
  deleted: number;
  bytesFreed: number;
  /** Per-reason counts, so a run can say what it removed and on what grounds. */
  byReason: Record<PruneReason, number>;
  /**
   * Headless delta rows SPARED because their own turn never stored a final
   * message. Reported rather than silently skipped: this is the whole
   * cancelled/crashed-turn population, and a run that cannot say how big it was
   * cannot be checked against the loss it is claiming not to cause.
   */
  keptAwaitingTurnFinal: number;
  /**
   * Codex delta rows SPARED because no `item/completed` for their item id was
   * found later in the session -- or because the row named no item id at all.
   * Counted separately from `keptAwaitingTurnFinal` because it is a different
   * population proven a different way, and a single number would hide which
   * proof did the sparing.
   */
  keptAwaitingItemCompleted: number;
}

export interface PruneResult extends PruneProgress {
  durationMs: number;
  cutoffIso: string;
  stoppedEarly: boolean;
}

export type PruneOptions = Omit<RetentionOptions, 'onProgress'> & {
  onProgress?: (p: PruneProgress) => void;
  /**
   * Drop the age filter entirely.
   *
   * The tombstone lane's cutoff answers "might the user still want to read
   * this?", which is a real question about tool output and the reason that lane
   * would never take this flag. It is not a real question here: a
   * `thinking_tokens` tick or a superseded `agentMessage/delta` produces no
   * transcript event on the day it is written, and the session-status guard --
   * which is what actually protects a turn in flight -- applies either way.
   *
   * Off by default regardless, so age is dropped only when a caller says so.
   */
  ignoreAge?: boolean;
};

function emptyByReason(): Record<PruneReason, number> {
  return {
    claudeCodeTransient: 0,
    codexAppServerStatus: 0,
    codexAgentMessageDelta: 0,
    codexCommandOutputDelta: 0,
    codexItemStartedNonRendering: 0,
    headlessAgentTextDelta: 0,
    grokAcpTextDelta: 0,
    grokAvailableCommands: 0,
  };
}

/**
 * Prune candidates.
 *
 * Deliberately WIDER than `CANDIDATE_SQL`: that one restricts to
 * `message_kind IN ('tool','meta')` because only those carry tool output, but
 * the frames this lane removes are classified as `system` (claude-code
 * `thinking_tokens`, codex status notifications) as well as `meta` (codex
 * deltas, and codex notifications written before the relabel). Narrowing by
 * `message_kind` here would silently skip the single largest population.
 *
 * Every other guard is the same, and for the same reasons: output only, older
 * than the cutoff, known source, and never a session the user is mid-turn on.
 */
function pruneCandidateSql(ignoreAge: boolean): string {
  return `
  SELECT m.id, m.session_id, m.source, m.content
  FROM ai_agent_messages m
  JOIN ai_sessions s ON s.id = m.session_id
  WHERE m.id > ?
    ${ignoreAge ? '' : 'AND m.created_at < ?'}
    AND m.direction = 'output'
    AND (${SOURCE_PREDICATE})
    AND s.status NOT IN ('running', 'waiting_for_input')
  ORDER BY m.id ASC
  LIMIT ?
`;
}

interface PruneCandidateRow {
  id: number;
  session_id: string;
  source: string;
  content: string;
}

/**
 * Where each of a session's turns BEGINS.
 *
 * Every provider logs the user's prompt as a `direction = 'input'` row before
 * the turn runs, so the input rows are the session's turn boundaries. That is
 * the finest turn identity available for a headless delta, which carries no
 * turn or item id of its own.
 *
 * Not filtered by source. A turn started under any provider still ends the
 * previous one, and admitting them all only ever moves a boundary EARLIER,
 * which spares more rows. Erring toward more boundaries is the fail-closed
 * direction.
 *
 * These rows are also the one piece of evidence this lane provably cannot
 * destroy: `pruneCandidateSql` selects `direction = 'output'` only.
 */
const TURN_STARTS_SQL = `
  SELECT m.id AS id
  FROM ai_agent_messages m
  WHERE m.session_id = ?
    AND m.direction = 'input'
  ORDER BY m.id ASC
`;

/**
 * Every turn-final assistant message stored for one (session, source).
 *
 * `HeadlessCliAgentProvider.storeAssistantResponse` is the only writer of this
 * row, and it tags it `metadata.eventType = 'item.completed'` -- a DOT, the
 * synthesized Codex-shaped envelope, not to be confused with codex's own
 * `item/completed` method below. Matching the metadata column rather than
 * sniffing `content` keeps the proof on the field the writer set deliberately,
 * and keeps it working if the stored envelope is ever reshaped.
 *
 * The whole list rather than the newest one: the newest is what let a later
 * turn's completion vouch for an earlier cancelled turn's deltas. Pairing each
 * delta with the FIRST completion after it, and requiring that completion to
 * fall before the next turn boundary, is what makes the proof the delta's own
 * turn's.
 *
 * `source` is matched exactly, not by prefix: both rows come from the same
 * `getProviderName()` call, so a mixed-provider session can never have one
 * provider's completion vouch for another provider's deltas.
 */
const TURN_FINALS_SQL = `
  SELECT m.id AS id
  FROM ai_agent_messages m
  WHERE m.session_id = ?
    AND m.source = ?
    AND m.direction = 'output'
    AND json_extract(m.metadata, '$.eventType') = 'item.completed'
  ORDER BY m.id ASC
`;

/**
 * Every codex item that reached `item/completed`, with the row id that recorded
 * it, for one (session, source).
 *
 * Codex stamps `params.itemId` on a delta and `params.item.id` on the matching
 * completion, so this is an exact per-item proof and needs no turn arithmetic.
 * On the measured install all 161 surviving `item/agentMessage/delta` rows pair
 * with a completion for their own item, so the guard costs nothing real and
 * only closes the case where the turn died mid-message.
 *
 * `json_extract` over `content` sits in the SELECT list behind a `json_valid`
 * guard, never in the WHERE clause. SQLite raises on malformed JSON rather than
 * returning null, and it does not promise to evaluate `AND` terms left to
 * right, so a `WHERE json_extract(content, ...)` term could hit a row this
 * filter was meant to exclude and abort the whole pass. Select-list expressions
 * are only evaluated for rows that already passed WHERE.
 *
 * ## What the scoping costs
 *
 * Re-measured on the shape the session-wide lookup was measured against:
 * 230,000 rows, 400 sessions of 500 rows plus one pathological 20,000-row
 * session, half the rows a 4 KB payload, every session seeded with deltas so
 * both proofs run for all of them.
 *
 *   per session, memoised     old 3.2 us  ->  turn proof 140 us, item proof 102 us
 *   pathological 20k session  old 4.8 ms  ->  turn proof 4.2 ms, item proof 3.0 ms
 *   whole run, 400 sessions   old 0.6 ms  ->  90 ms
 *
 * The typical session is ~44x dearer because the old query stopped at the first
 * hit walking the session index backwards and these read the session through.
 * The pathological session is unchanged-to-cheaper: nothing could short-circuit
 * there before either. It stays per SESSION and memoised, not per row, and 90 ms
 * spread across a background pass that walks the whole table is not a cost worth
 * trading a cancelled turn's only copy for.
 *
 * The number to watch is the per-chunk one: `PRUNE_CHUNK_ROWS` delta rows in
 * 1,000 DISTINCT sessions would be ~240 ms in a single chunk, over the
 * coordinator's 50 ms warning. Deltas arrive in runs of dozens per session, so a
 * chunk realistically touches a handful; if that warning ever fires from this
 * lane, this is why.
 */
const ITEM_COMPLETIONS_SQL = `
  SELECT m.id AS id,
         CASE WHEN json_valid(m.content)
              THEN json_extract(m.content, '$.params.item.id') END AS item_id
  FROM ai_agent_messages m
  WHERE m.session_id = ?
    AND m.source = ?
    AND m.direction = 'output'
    AND json_extract(m.metadata, '$.eventType') = 'item/completed'
  ORDER BY m.id ASC
`;

/**
 * Distinct (session, source) pairs whose proof lists are held at once.
 *
 * Each entry is a handful of integer arrays or a small id map, but the run
 * walks the whole table and would otherwise accumulate one per session for
 * thousands of sessions. Candidates arrive in `id` order and a session's rows
 * are largely contiguous, so dropping the whole cache on overflow costs at most
 * a re-query for a session that interleaves with many others.
 */
const MAX_CACHED_SESSION_PROOFS = 64;

/** Index of the first entry strictly greater than `value` in an ascending list. */
function upperBound(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] > value) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Build the chunked prune work for `SQLiteDatabase.runBackground`.
 *
 * The progress callback fires per chunk rather than only at the end. That is
 * deliberate: `.claude/rules/destructive-data-paths.md` requires a destructive
 * pass to report before the process can die, and the #1347 recovery event was
 * invisible for nine months precisely because it was only computed if the same
 * process reached the end.
 */
export function createRawMessagePruneWork(
  options: PruneOptions,
  onDone: (result: PruneResult) => void,
) {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const startedAt = now();
  const ignoreAge = options.ignoreAge === true;
  const cutoff = cutoffIso(options.retentionDays, startedAt);
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  const sql = pruneCandidateSql(ignoreAge);
  const ageArgs = ignoreAge ? [] : [cutoff];

  const progress: PruneProgress = {
    scanned: 0,
    deleted: 0,
    bytesFreed: 0,
    byReason: emptyByReason(),
    keptAwaitingTurnFinal: 0,
    keptAwaitingItemCompleted: 0,
  };
  let lastId = 0;
  let announced = false;

  /**
   * Proof lists per (session, source), memoised for the run. One pair of
   * lookups per distinct session rather than one per row: `PRUNE_CHUNK_ROWS` is
   * 1,000 and a single session contributes hundreds of delta rows, so the
   * unmemoised form would be an N+1 over the widest table in the database.
   *
   * Safe to cache: neither an `item.completed` row, an `item/completed` row nor
   * an input row is ever prunable -- the classifier returns null for the first
   * two and the candidate SQL admits only `direction = 'output'` -- so this lane
   * cannot delete its own evidence. The table is append-only, so the answer
   * cannot change under us mid-run.
   *
   * Both maps are cleared together on overflow, so a session can never hold one
   * half of its proof from before the drop and the other half from after.
   */
  const turnProofs = new Map<string, { turnStarts: number[]; turnFinals: number[] }>();
  const itemCompletions = new Map<string, Map<string, number>>();

  const proofKey = (row: PruneCandidateRow) => `${row.session_id}\u001f${row.source}`;

  function evictIfFull(): void {
    if (turnProofs.size + itemCompletions.size <= MAX_CACHED_SESSION_PROOFS) return;
    turnProofs.clear();
    itemCompletions.clear();
  }

  /**
   * True when an `item.completed` for this row's OWN turn was stored after it.
   *
   * "Own turn" is the span from the row up to the next input row. A completion
   * at or beyond that boundary belongs to a LATER turn and says nothing about
   * this one -- which is exactly what a session-wide lookup got wrong for a
   * cancelled turn sitting between two completed ones.
   */
  function ownTurnStoredFinal(db: SqliteDatabase, row: PruneCandidateRow): boolean {
    const key = proofKey(row);
    let proof = turnProofs.get(key);
    if (!proof) {
      evictIfFull();
      proof = {
        turnStarts: (db.prepare(TURN_STARTS_SQL).all(row.session_id) as Array<{ id: number }>)
          .map((r) => Number(r.id)),
        turnFinals: (db.prepare(TURN_FINALS_SQL).all(row.session_id, row.source) as Array<{ id: number }>)
          .map((r) => Number(r.id)),
      };
      turnProofs.set(key, proof);
    }

    // A session with no input row at all has no turn structure to scope
    // against, and scoping is the entire point -- answering from the session as
    // a whole is the bug this replaced. The prompt row is written best-effort
    // (`logAgentMessageBestEffort`), so its absence means the evidence is
    // missing, not that there were no turns. Keep.
    if (proof.turnStarts.length === 0) return false;

    // Strictly later, so a delta can only be dropped by a completion that came
    // after it; no completion after it at all is the fail-closed answer.
    const nextFinal = proof.turnFinals[upperBound(proof.turnFinals, row.id)];
    if (nextFinal === undefined) return false;
    // No turn starts AFTER this row means it belongs to the session's last
    // turn, so the completion it found can only be that turn's.
    const nextTurnStart = proof.turnStarts[upperBound(proof.turnStarts, row.id)];
    return nextTurnStart === undefined || nextFinal < nextTurnStart;
  }

  /**
   * True when an `item/completed` for this row's OWN item was stored after it.
   *
   * A delta that names no item id is unproven by construction, and kept.
   */
  function ownItemCompleted(db: SqliteDatabase, row: PruneCandidateRow): boolean {
    const itemId = readCodexDeltaItemId(row.content);
    if (!itemId) return false;

    const key = proofKey(row);
    let completions = itemCompletions.get(key);
    if (!completions) {
      evictIfFull();
      completions = new Map<string, number>();
      const rows = db
        .prepare(ITEM_COMPLETIONS_SQL)
        .all(row.session_id, row.source) as Array<{ id: number; item_id: string | null }>;
      for (const completion of rows) {
        if (typeof completion.item_id === 'string' && completion.item_id) {
          completions.set(completion.item_id, Number(completion.id));
        }
      }
      itemCompletions.set(key, completions);
    }

    const completedAt = completions.get(itemId);
    return completedAt !== undefined && row.id < completedAt;
  }

  /**
   * Whether a reason resting on a later row may be acted on, tallying a spare
   * against the counter for whichever proof failed. A reason with no such
   * premise needs nothing proven: the frame's own shape settles it.
   */
  function supersessionProven(
    db: SqliteDatabase,
    row: PruneCandidateRow,
    reason: PruneReason,
  ): boolean {
    switch (PRUNE_REASON_SUPERSESSION_PROOF.get(reason)) {
      case 'headlessTurnFinal':
        if (ownTurnStoredFinal(db, row)) return true;
        progress.keptAwaitingTurnFinal++;
        return false;
      case 'codexItemCompleted':
        if (ownItemCompleted(db, row)) return true;
        progress.keptAwaitingItemCompleted++;
        return false;
      default:
        return true;
    }
  }

  return {
    name: 'raw-message-prune',
    chunk(db: SqliteDatabase): { done: boolean } {
      if (!announced) {
        announced = true;
        log(
          'info',
          '[RawPrune] starting: deleting non-rendering frames '
            + (ignoreAge ? 'at any age' : `older than ${cutoff}`),
        );
      }

      if (progress.scanned >= maxRows) {
        onDone({ ...progress, durationMs: now() - startedAt, cutoffIso: cutoff, stoppedEarly: true });
        return { done: true };
      }

      const rows = db
        .prepare(sql)
        .all(lastId, ...ageArgs, ...ELIGIBLE_SOURCE_PREFIXES, PRUNE_CHUNK_ROWS) as PruneCandidateRow[];

      if (rows.length === 0) {
        const breakdown = Object.entries(progress.byReason)
          .map(([reason, n]) => `${reason}=${n}`).join(' ');
        log(
          'info',
          `[RawPrune] complete: scanned=${progress.scanned} deleted=${progress.deleted} `
            + `freed=${(progress.bytesFreed / 1024 / 1024).toFixed(1)}MB ${breakdown} `
            + `keptAwaitingTurnFinal=${progress.keptAwaitingTurnFinal} `
            + `keptAwaitingItemCompleted=${progress.keptAwaitingItemCompleted}`,
        );
        onDone({
          ...progress,
          durationMs: now() - startedAt,
          cutoffIso: ignoreAge ? '' : cutoff,
          stoppedEarly: false,
        });
        return { done: true };
      }

      const doomed: number[] = [];
      for (const row of rows) {
        lastId = row.id;
        progress.scanned++;
        const reason = classifyPrunableRawMessage(row.content, row.source);
        if (reason === null) continue;
        // "Superseded by a later row" is only true if that row exists AND
        // belongs to this delta's own turn or item. A cancelled or crashed turn
        // never wrote one, and its deltas are then the only copy of what the
        // assistant said.
        if (!supersessionProven(db, row, reason)) continue;
        doomed.push(row.id);
        progress.byReason[reason]++;
        // Measured in JS from the string we already hold. Asking SQL for
        // LENGTH(CAST(content AS BLOB)) alongside the column materializes every
        // candidate row's payload a second time, and the candidate set here is
        // most of the table.
        progress.bytesFreed += Buffer.byteLength(row.content, 'utf8');
      }

      if (doomed.length > 0) {
        // One statement per chunk rather than per row: the FTS delete trigger
        // fires either way, and a single bounded IN-list keeps the write inside
        // the coordinator's slow-chunk budget.
        const placeholders = doomed.map(() => '?').join(',');
        db.prepare(`DELETE FROM ai_agent_messages WHERE id IN (${placeholders})`).run(...doomed);
        progress.deleted += doomed.length;
      }

      options.onProgress?.({ ...progress, byReason: { ...progress.byReason } });
      return { done: false };
    },
  };
}

/* ==========================================================================
 * Init-dedup lane -- collapse repeated system/init frames to one per session.
 * ========================================================================== */

/**
 * `system/init` is the claude-code session header: model, cwd, tool list, MCP
 * servers, slash commands. No transcript consumer renders it -- the raw-message
 * parsers ignore every system subtype except `permission_denied` -- but it is
 * kept on purpose for forensics, because it carries the SDK session id and the
 * tool/MCP context a later investigation needs.
 *
 * The SDK re-emits it on every resume, so a session accumulates copies of a
 * ~10 KB blob: 24,154 rows across 4,523 sessions on the measured install, 223
 * MB, averaging 5.3 per session. Keeping the newest one per session preserves
 * the entire forensic value -- it is the most complete and most recent picture
 * of that session's environment -- and returns 170 MB.
 *
 * This is a narrower lane than the prune above and does not share its
 * classifier, because the decision is not "does this frame render" (it does
 * not, either way) but "is this copy redundant with a later one". That is a
 * fact about the ROW SET, not about the row, so it needs the group-by.
 */
const INIT_DEDUP_SQL = `
  SELECT m.id, LENGTH(CAST(m.content AS BLOB)) AS bytes
  FROM ai_agent_messages m
  JOIN ai_sessions s ON s.id = m.session_id
  WHERE m.session_id = ?
    AND m.direction = 'output'
    AND m.source LIKE 'claude-code%'
    AND m.message_kind = 'system'
    AND m.content LIKE '{"type":"system"%'
    AND json_extract(m.content, '$.subtype') = 'init'
    AND s.status NOT IN ('running', 'waiting_for_input')
  ORDER BY m.id ASC
`;

/** Sessions examined per chunk. Each one runs a small indexed lookup. */
const INIT_DEDUP_SESSIONS_PER_CHUNK = 200;

export interface InitDedupResult {
  sessionsScanned: number;
  deleted: number;
  bytesFreed: number;
  durationMs: number;
}

/**
 * Build the chunked init-dedup work for `SQLiteDatabase.runBackground`.
 *
 * Sessions are walked in `id` order via a bounded cursor so no chunk can turn
 * into an unbounded scan, matching every other lane in this file.
 */
export function createInitDedupWork(
  options: { log?: (level: 'info' | 'warn', msg: string) => void; now?: () => number },
  onDone: (result: InitDedupResult) => void,
) {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const startedAt = now();

  let sessionsScanned = 0;
  let deleted = 0;
  let bytesFreed = 0;
  let lastSessionId = '';

  return {
    name: 'claude-code-init-dedup',
    chunk(db: SqliteDatabase): { done: boolean } {
      const sessions = db
        .prepare(
          `SELECT id FROM ai_sessions
            WHERE id > ? AND status NOT IN ('running', 'waiting_for_input')
            ORDER BY id ASC LIMIT ?`,
        )
        .all(lastSessionId, INIT_DEDUP_SESSIONS_PER_CHUNK) as Array<{ id: string }>;

      if (sessions.length === 0) {
        log(
          'info',
          `[InitDedup] complete: sessions=${sessionsScanned} deleted=${deleted} `
            + `freed=${(bytesFreed / 1024 / 1024).toFixed(1)}MB`,
        );
        onDone({ sessionsScanned, deleted, bytesFreed, durationMs: now() - startedAt });
        return { done: true };
      }

      const select = db.prepare(INIT_DEDUP_SQL);
      for (const session of sessions) {
        lastSessionId = session.id;
        sessionsScanned++;

        const inits = select.all(session.id) as Array<{ id: number; bytes: number }>;
        if (inits.length < 2) continue;

        // Keep the last one: highest id is the newest, so it reflects the
        // session's final tool/MCP environment rather than its first.
        const doomed = inits.slice(0, -1);
        const placeholders = doomed.map(() => '?').join(',');
        db.prepare(`DELETE FROM ai_agent_messages WHERE id IN (${placeholders})`)
          .run(...doomed.map((r) => r.id));
        deleted += doomed.length;
        bytesFreed += doomed.reduce((sum, r) => sum + r.bytes, 0);
      }

      return { done: false };
    },
  };
}
