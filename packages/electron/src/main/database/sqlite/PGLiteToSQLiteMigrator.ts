/**
 * PGLiteToSQLiteMigrator
 *
 * Copies every row from the legacy PGLite store into a fresh SQLite database
 * (already opened by `SQLiteDatabase` with the consolidated `0001_initial.sql`
 * schema applied). The migrator is the data-plane half of the migration;
 * orchestration (backup → quiesce → schema → copy → cutover) lives in the
 * IPC handler that drives this class.
 *
 * Design choices:
 *   - Reads PGLite via the `@electric-sql/pglite` ESM module in the same
 *     process. The PGLite worker thread must be closed before the migrator
 *     runs; the migrator opens its own short-lived PGLite handle in
 *     `readonly: true` mode against the source directory.
 *   - Writes SQLite through `coordinator.runBackground(...)` so the JS event
 *     loop stays responsive during long table copies. Each batch is wrapped
 *     in a single `BEGIN IMMEDIATE / COMMIT` via better-sqlite3's transaction
 *     helper for fsync amortization.
 *   - `PRAGMA foreign_keys = OFF` during copy so we can insert tables in any
 *     order, plus self-referential FKs (`ai_sessions.parent_session_id`)
 *     don't need ordering. We turn them back on and run
 *     `PRAGMA foreign_key_check` at the end.
 *   - The `ai_agent_messages_fts` mirror is rebuilt explicitly after the
 *     ai_agent_messages copy (chunked over the PK range) so the FTS5
 *     external-content shadow is consistent on first open. Rows whose
 *     `searchable_text IS NULL` are skipped here and added later by the
 *     AFTER UPDATE trigger as `AgentMessagesBackfill` populates them.
 *     The ai_agent_messages copy itself filters transient Codex app-server
 *     raw-notification noise before rows ever reach SQLite or its FTS mirror.
 *   - Generated columns (`tracker_items.title`, `status`, `kanban_sort_order`)
 *     are skipped at INSERT time; SQLite computes them from `data`.
 *
 * Verification:
 *   - Per-table row counts match.
 *   - Spot-check N random rows per table with normalized deep-equality.
 *   - `PRAGMA integrity_check` returns 'ok'.
 *   - `PRAGMA foreign_key_check` returns no rows.
 */

import type { Database as BetterSqliteDb } from 'better-sqlite3';
import type { SQLiteDatabase } from './SQLiteDatabase';

// Surface of the PGLite client we use. Keeps the migrator testable without
// importing the heavy ESM module in the test runner.
export interface PGLiteHandle {
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; fields?: { name: string; dataTypeID: number }[] }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

export type MigrationPhase =
  | 'preparing'
  | 'copying'
  | 'rebuilding-fts'
  | 'verifying-counts'
  | 'verifying-integrity'
  | 'verifying-foreign-keys'
  | 'verifying-spot-check'
  | 'finalizing';

export interface MigrationProgress {
  phase: MigrationPhase;
  currentTable?: string;
  rowsCopied: number;
  rowsExpected: number;
  tableRowsCopied: number;
  tableRowsExpected: number;
  tablesCompleted: number;
  tablesTotal: number;
  percentOfTotal: number;
  /** Milliseconds since migrator.migrate() started. */
  elapsedMs: number;
}

export interface MigrationSummary {
  totalRowsCopied: number;
  tablesCopied: { name: string; rows: number }[];
  durationMs: number;
  integrityCheck: string;
  foreignKeyViolations: number;
  spotCheckCount: number;
  /** Per-table cursor state for catch-up adoption; see DryRunManifest. */
  manifest?: DryRunManifest;
}

/**
 * Per-table state snapshot written by the dry-run, consumed by `catchUp` when
 * the user adopts the dry-run SQLite as their active backend.
 *
 *   - `cursorMax`: max PK value seen for tables using cursor pagination —
 *     anything newer than this in PGLite must be incrementally copied.
 *   - `rows`: row count at the time of the dry-run; used for sanity warnings
 *     in the UI ("X new rows since dry-run").
 *   - `cursorColumn`: the PK column we used; null/absent means the table was
 *     copied via OFFSET (composite PK) and adopt re-copies it whole.
 */
export interface DryRunManifest {
  /** ISO timestamp of dry-run completion. */
  completedAt: string;
  /** Wall-clock duration of the dry-run, for diagnostics. */
  durationMs: number;
  perTable: Array<{
    name: string;
    rows: number;
    cursorColumn?: string;
    cursorMax?: string | number;
  }>;
}

export interface CatchUpResult {
  rowsAdded: number;
  perTable: Array<{ name: string; added: number }>;
  manifest: DryRunManifest;
}

export interface MigrateOptions {
  pglite: PGLiteHandle;
  sqlite: SQLiteDatabase;
  /** Receives progress events. Called synchronously from the migrator. */
  onProgress?: (progress: MigrationProgress) => void;
  /** Per-batch row count. Default 1000. */
  batchSize?: number;
  /** Number of random rows per table to deep-equality check. Default 5. */
  spotCheckPerTable?: number;
  /** Logger. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
}

/**
 * Table copy order. Foreign keys are OFF during copy so this only matters for
 * humans reading progress and for deterministic verification ordering. The
 * order roughly follows dependency depth (parents before children) so the
 * progress UI tells a coherent story.
 *
 * `ai_transcript_events` is absent because it no longer exists on either
 * side (Phase 4 of canonical-transcript-deprecation). Canonical events live
 * in TranscriptRuntime's in-memory cache and are rebuilt from raw
 * `ai_agent_messages` on first read.
 */
const COPY_TABLES: readonly string[] = [
  'worktrees',
  'ai_sessions',
  'document_history',
  'session_files',
  'ai_agent_messages',
  'ai_tool_call_file_edits',
  'tracker_items',
  'tracker_body_cache',
  'tracker_transactions',
  'queued_prompts',
  'ai_session_wakeups',
  'super_loops',
  'super_iterations',
  'collab_local_origins',
  'collab_document_replicas',
  'collab_document_replica_updates',
  'collab_document_outbox',
  'collab_document_assets',
  'project_file_sync_baseline',
];

/**
 * Single-column primary keys we can use for cursor pagination.
 *
 * IMPORTANT: only monotonically increasing INTEGER keys belong here. Text
 * IDs (UUIDs/ULIDs/etc.) are fine for the initial full copy, but they are
 * unsafe for incremental catch-up because a newly inserted row can sort
 * *before* the previous high-water mark and be skipped forever.
 *
 * Tables not in this map fall back to LIMIT/OFFSET for the initial full copy
 * and full re-copy during catch-up. That's slower, but it is exact.
 */
const CURSOR_COLUMNS: Record<string, string> = {
  document_history: 'id',
  ai_agent_messages: 'id',
  ai_tool_call_file_edits: 'id',
  // Text-ID and composite-PK tables intentionally fall back to safe re-copy:
  // worktrees, ai_sessions, session_files, tracker_items, queued_prompts,
  // ai_session_wakeups, super_loops, super_iterations, tracker_body_cache,
  // tracker_transactions, collab_local_origins.
};

const APP_SERVER_NOTIFICATION_METHODS_TO_KEEP = [
  'item/started',
  'item/completed',
  'turn/completed',
  'turn/failed',
  'error',
] as const;

function getSourceTableFilterSql(table: string): string {
  if (table !== 'ai_agent_messages') {
    return '';
  }

  const keptMethods = APP_SERVER_NOTIFICATION_METHODS_TO_KEEP
    .map((value) => `'${value}'`)
    .join(', ');

  return `
    WHERE NOT (
      COALESCE(metadata->>'transport', '') = 'app-server'
      AND COALESCE(metadata->>'eventType', '') NOT IN (${keptMethods})
    )
  `;
}

interface TargetColumn {
  name: string;
  type: string;
  /** Whether this column is GENERATED (must not appear in INSERT). */
  generated: boolean;
  /** Whether this column is BLOB-typed (BYTEA in PGLite). */
  isBlob: boolean;
}

export class PGLiteToSQLiteMigrator {
  async migrate(opts: MigrateOptions): Promise<MigrationSummary> {
    const t0 = performance.now();
    const batchSize = opts.batchSize ?? 5000;
    const spotCheckPerTable = opts.spotCheckPerTable ?? 5;
    const log = opts.log ?? (() => {});
    const sqliteHandle = opts.sqlite.getRawHandle();
    if (!sqliteHandle) {
      throw new Error('SQLiteDatabase must be initialized before migration');
    }

    const pgliteCounts = await this.measureSourceCounts(opts.pglite);
    const totalExpected = pgliteCounts.reduce((sum, t) => sum + t.rows, 0);

    log('info', `[migrator] starting; ${totalExpected} rows across ${pgliteCounts.length} tables`);

    // Foreign keys OFF during copy so the order doesn't matter and self-FKs work.
    sqliteHandle.pragma('foreign_keys = OFF');

    let totalCopied = 0;
    const tableSummary: { name: string; rows: number }[] = [];
    // Spot-check samples are captured DURING the copy so the verification step
    // doesn't race against live PGLite writes (sync, tracker updates, etc.).
    // Re-reading from PGLite at verify time would compare a frozen snapshot
    // (what we copied) against whatever the row looks like *now* — leading to
    // false "Spot check mismatch" failures during dry runs.
    const samplesByTable = new Map<string, Record<string, unknown>[]>();

    opts.onProgress?.({
      phase: 'preparing',
      rowsCopied: 0,
      rowsExpected: totalExpected,
      tableRowsCopied: 0,
      tableRowsExpected: 0,
      tablesCompleted: 0,
      tablesTotal: pgliteCounts.length,
      percentOfTotal: 0,
      elapsedMs: performance.now() - t0,
    });

    // Drop the FTS5 mirror triggers on ai_agent_messages before bulk insert.
    // They fire per-row and on a 1M+ row log are the dominant copy cost. We
    // seed the FTS table explicitly after the copy and then recreate the
    // triggers so live app writes index correctly. All three triggers
    // (AI/AD/AU) come from schemas/0004_fts_on_searchable_text.sql — Phase 2
    // of canonical-transcript-deprecation — and reference `searchable_text`,
    // not the historical `content` column.
    sqliteHandle.exec('DROP TRIGGER IF EXISTS ai_agent_messages_ai');
    sqliteHandle.exec('DROP TRIGGER IF EXISTS ai_agent_messages_ad');
    sqliteHandle.exec('DROP TRIGGER IF EXISTS ai_agent_messages_au');

    const manifestPerTable: DryRunManifest['perTable'] = [];
    for (let i = 0; i < pgliteCounts.length; i++) {
      const { name, rows: tableExpected } = pgliteCounts[i];
      const { copied, samples, cursorMax } = await this.copyTable({
        sourceTable: name,
        expectedRows: tableExpected,
        pglite: opts.pglite,
        sqlite: opts.sqlite,
        sqliteHandle,
        batchSize,
        cursorColumn: CURSOR_COLUMNS[name],
        sampleSize: Math.min(spotCheckPerTable, Math.max(1, tableExpected)),
        onBatchProgress: (tableRowsCopied) => {
          totalCopied = pgliteCounts
            .slice(0, i)
            .reduce((s, t) => s + t.rows, 0) + tableRowsCopied;
          opts.onProgress?.({
            phase: 'copying',
            currentTable: name,
            rowsCopied: totalCopied,
            rowsExpected: totalExpected,
            tableRowsCopied,
            tableRowsExpected: tableExpected,
            tablesCompleted: i,
            tablesTotal: pgliteCounts.length,
            percentOfTotal:
              totalExpected === 0 ? 100 : (totalCopied / totalExpected) * 100,
            elapsedMs: performance.now() - t0,
          });
        },
        log,
      });
      tableSummary.push({ name, rows: copied });
      if (samples.length > 0) samplesByTable.set(name, samples);
      manifestPerTable.push({
        name,
        rows: copied,
        cursorColumn: CURSOR_COLUMNS[name],
        cursorMax,
      });
      log('info', `[migrator] copied ${copied}/${tableExpected} rows from ${name}`);
    }

    // Phase 4 of canonical-transcript-deprecation: ai_transcript_events
    // doesn't exist on either side anymore, and the watermark columns are
    // dropped by migration 0005. No reset pass is required here.

    // Rebuild ai_agent_messages_fts in chunks. The FTS5 'rebuild' command is
    // a single synchronous statement that, on a 1M+ row content table, blocks
    // the entire main process (better-sqlite3 is sync). Chunking by PK range
    // with setImmediate yields between batches keeps the UI responsive and
    // lets us emit progress.
    const ftsTotal = pgliteCounts.find((t) => t.name === 'ai_agent_messages')?.rows ?? 0;
    if (ftsTotal > 0) {
      log('info', '[migrator] rebuilding ai_agent_messages_fts (chunked)');
      const FTS_CHUNK_ROWS = 25_000;
      const idRange = sqliteHandle
        .prepare(`SELECT MIN(id) AS lo, MAX(id) AS hi FROM ai_agent_messages`)
        .get() as { lo: number | null; hi: number | null };
      if (idRange.lo !== null && idRange.hi !== null) {
        // Phase 2 of canonical-transcript-deprecation: FTS now indexes
        // `searchable_text`, not raw `content`. Rows whose extractor
        // backfill is still pending (NULL) are skipped here and picked up
        // by the AFTER UPDATE trigger when AgentMessagesBackfill runs.
        const insertChunk = sqliteHandle.prepare(
          `INSERT INTO ai_agent_messages_fts(rowid, searchable_text)
             SELECT id, searchable_text FROM ai_agent_messages
             WHERE id > ? AND id <= ? AND searchable_text IS NOT NULL`,
        );
        let cursor = idRange.lo - 1;
        let ftsCopied = 0;
        while (cursor < idRange.hi) {
          const nextCursor = Math.min(cursor + FTS_CHUNK_ROWS, idRange.hi);
          const info = insertChunk.run(cursor, nextCursor);
          ftsCopied += Number(info.changes);
          cursor = nextCursor;
          opts.onProgress?.({
            phase: 'rebuilding-fts',
            currentTable: 'ai_agent_messages_fts',
            rowsCopied: totalCopied,
            rowsExpected: totalExpected,
            tableRowsCopied: ftsCopied,
            tableRowsExpected: ftsTotal,
            tablesCompleted: pgliteCounts.length,
            tablesTotal: pgliteCounts.length,
            percentOfTotal: 100,
            elapsedMs: performance.now() - t0,
          });
          // Yield to the event loop so IPC, the renderer, and other handlers
          // get a chance to run between chunks.
          await new Promise<void>((r) => setImmediate(r));
        }
      }
    }
    // Recreate all three FTS triggers matching schemas/0004_fts_on_searchable_text.sql.
    // They index `searchable_text` (NOT the legacy `content` column) and skip
    // rows whose searchable_text is NULL so tool noise stays out of the index.
    sqliteHandle.exec(`
      CREATE TRIGGER IF NOT EXISTS ai_agent_messages_ai AFTER INSERT ON ai_agent_messages
      WHEN new.searchable_text IS NOT NULL
      BEGIN
        INSERT INTO ai_agent_messages_fts(rowid, searchable_text)
          VALUES (new.id, new.searchable_text);
      END;
    `);
    sqliteHandle.exec(`
      CREATE TRIGGER IF NOT EXISTS ai_agent_messages_ad AFTER DELETE ON ai_agent_messages
      WHEN old.searchable_text IS NOT NULL
      BEGIN
        INSERT INTO ai_agent_messages_fts(ai_agent_messages_fts, rowid, searchable_text)
          VALUES('delete', old.id, old.searchable_text);
      END;
    `);
    sqliteHandle.exec(`
      CREATE TRIGGER IF NOT EXISTS ai_agent_messages_au AFTER UPDATE ON ai_agent_messages
      BEGIN
        INSERT INTO ai_agent_messages_fts(ai_agent_messages_fts, rowid, searchable_text)
          VALUES('delete', old.id, old.searchable_text);
        INSERT INTO ai_agent_messages_fts(rowid, searchable_text)
          SELECT new.id, new.searchable_text WHERE new.searchable_text IS NOT NULL;
      END;
    `);

    // Verify counts. Emit per-table progress so the UI shows which table is
    // being counted (SELECT COUNT(*) can be slow on large tables). The dry-run
    // runs against a LIVE PGLite — inserts (sync, agent writes) and deletes
    // (AgentMessagesBackfill cleanup of transient rows) happen during the copy
    // window. The cursor loop deliberately drains past `expected` (see comment
    // at copyTable), so the SQLite count can legitimately end up above or
    // below the count we measured at the start. We log the per-table drift so
    // the UI/log records it, but we never throw — the dry-run database is
    // thrown away after the run, and integrity_check + foreign_key_check
    // (below) plus the spot-check are the real correctness gates.
    let totalDrift = 0;
    for (let i = 0; i < pgliteCounts.length; i++) {
      const { name, rows: expected } = pgliteCounts[i];
      opts.onProgress?.({
        phase: 'verifying-counts',
        currentTable: name,
        rowsCopied: totalCopied,
        rowsExpected: totalExpected,
        tableRowsCopied: 0,
        tableRowsExpected: expected,
        tablesCompleted: i,
        tablesTotal: pgliteCounts.length,
        percentOfTotal: 100,
        elapsedMs: performance.now() - t0,
      });
      const actual = sqliteHandle.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(name)}`).get() as { c: number };
      if (actual.c !== expected) {
        const drift = actual.c - expected;
        totalDrift += Math.abs(drift);
        log(
          'warn',
          `[migrator] ${name}: target=${actual.c} drifted ${drift >= 0 ? '+' : ''}${drift} from start-of-run source=${expected} (live writes during dry-run)`,
        );
      }
    }
    if (totalDrift > 0) {
      log('info', `[migrator] total absolute row-count drift across tables: ${totalDrift}`);
    }

    // Spot-check captured samples (NOT a fresh read from PGLite — see the
    // note on samplesByTable above for the race that motivates this).
    let spotCheckCount = 0;
    const tablesWithSamples = pgliteCounts.filter((t) => samplesByTable.has(t.name));
    for (let i = 0; i < tablesWithSamples.length; i++) {
      const { name } = tablesWithSamples[i];
      const samples = samplesByTable.get(name)!;
      opts.onProgress?.({
        phase: 'verifying-spot-check',
        currentTable: name,
        rowsCopied: totalCopied,
        rowsExpected: totalExpected,
        tableRowsCopied: 0,
        tableRowsExpected: samples.length,
        tablesCompleted: i,
        tablesTotal: tablesWithSamples.length,
        percentOfTotal: 100,
        elapsedMs: performance.now() - t0,
      });
      spotCheckCount += this.spotCheckCapturedSamples({
        table: name,
        samples,
        pglite: opts.pglite,
        sqliteHandle,
      });
    }

    // Integrity + FK checks.
    opts.onProgress?.({
      phase: 'verifying-integrity',
      rowsCopied: totalCopied,
      rowsExpected: totalExpected,
      tableRowsCopied: 0,
      tableRowsExpected: 0,
      tablesCompleted: pgliteCounts.length,
      tablesTotal: pgliteCounts.length,
      percentOfTotal: 100,
      elapsedMs: performance.now() - t0,
    });
    const integrity = sqliteHandle.pragma('integrity_check', { simple: true }) as string;
    if (integrity !== 'ok') {
      throw new Error(`integrity_check returned: ${integrity}`);
    }

    opts.onProgress?.({
      phase: 'verifying-foreign-keys',
      rowsCopied: totalCopied,
      rowsExpected: totalExpected,
      tableRowsCopied: 0,
      tableRowsExpected: 0,
      tablesCompleted: pgliteCounts.length,
      tablesTotal: pgliteCounts.length,
      percentOfTotal: 100,
      elapsedMs: performance.now() - t0,
    });
    sqliteHandle.pragma('foreign_keys = ON');
    const fkViolations = sqliteHandle.prepare('PRAGMA foreign_key_check').all() as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `foreign_key_check failed: ${fkViolations.length} violations; first: ${JSON.stringify(fkViolations[0])}`,
      );
    }

    opts.onProgress?.({
      phase: 'finalizing',
      rowsCopied: totalCopied,
      rowsExpected: totalExpected,
      tableRowsCopied: 0,
      tableRowsExpected: 0,
      tablesCompleted: pgliteCounts.length,
      tablesTotal: pgliteCounts.length,
      percentOfTotal: 100,
      elapsedMs: performance.now() - t0,
    });

    const durationMs = performance.now() - t0;
    const summary: MigrationSummary = {
      totalRowsCopied: totalCopied,
      tablesCopied: tableSummary,
      durationMs,
      integrityCheck: integrity,
      foreignKeyViolations: fkViolations.length,
      spotCheckCount,
      manifest: {
        completedAt: new Date().toISOString(),
        durationMs,
        perTable: manifestPerTable,
      },
    };
    log('info', '[migrator] migration complete', summary);
    return summary;
  }

  /**
   * Incrementally bring an already-migrated SQLite up to date with the live
   * PGLite source. Called when the user adopts a dry-run as the new active
   * backend. PGLite must be exclusively held (worker closed) so writes are
   * paused while catchUp runs.
   *
   * Strategy per table:
   *   - Cursor-paginated tables (large append-only logs): copy rows whose PK
   *     is strictly greater than the dry-run high-water mark.
   *   - Other tables (small + may have in-place updates): DELETE FROM and
   *     full re-copy. Faster than diffing for the small sizes we have.
   */
  async catchUp(opts: {
    pglite: PGLiteHandle;
    sqlite: SQLiteDatabase;
    manifest: DryRunManifest;
    onProgress?: (progress: MigrationProgress) => void;
    batchSize?: number;
    log?: NonNullable<MigrateOptions['log']>;
  }): Promise<CatchUpResult> {
    const t0 = performance.now();
    const batchSize = opts.batchSize ?? 5000;
    const log = opts.log ?? (() => {});
    const sqliteHandle = opts.sqlite.getRawHandle();
    if (!sqliteHandle) throw new Error('SQLiteDatabase must be initialized before catchUp');

    sqliteHandle.pragma('foreign_keys = OFF');

    const perTable: Array<{ name: string; added: number }> = [];
    const manifestPerTable: DryRunManifest['perTable'] = [];
    let totalAdded = 0;
    const manifestByTable = new Map(opts.manifest.perTable.map((t) => [t.name, t]));
    // Measure current PGLite counts so we can show "X new rows" in the UI.
    const currentCounts = await this.measureSourceCounts(opts.pglite);
    const totalExpectedNew = currentCounts.reduce((sum, t) => {
      const old = manifestByTable.get(t.name)?.rows ?? 0;
      return sum + Math.max(0, t.rows - old);
    }, 0);

    for (let i = 0; i < currentCounts.length; i++) {
      const { name, rows: currentTotal } = currentCounts[i];
      const stored = manifestByTable.get(name);
      const cursorColumn = CURSOR_COLUMNS[name];
      let added = 0;

      opts.onProgress?.({
        phase: 'copying',
        currentTable: name,
        rowsCopied: totalAdded,
        rowsExpected: totalExpectedNew,
        tableRowsCopied: 0,
        tableRowsExpected: Math.max(0, currentTotal - (stored?.rows ?? 0)),
        tablesCompleted: i,
        tablesTotal: currentCounts.length,
        percentOfTotal:
          totalExpectedNew === 0 ? 100 : (totalAdded / totalExpectedNew) * 100,
        elapsedMs: performance.now() - t0,
      });

      if (cursorColumn && stored?.cursorMax !== undefined) {
        // Cursor catch-up: copy rows with PK > stored.cursorMax.
        const { copied, cursorMax } = await this.copyTable({
          sourceTable: name,
          expectedRows: Math.max(0, currentTotal - stored.rows),
          pglite: opts.pglite,
          sqlite: opts.sqlite,
          sqliteHandle,
          batchSize,
          cursorColumn,
          initialCursor: stored.cursorMax,
          sampleSize: 0,
          onBatchProgress: (tableRowsCopied) => {
            opts.onProgress?.({
              phase: 'copying',
              currentTable: name,
              rowsCopied: totalAdded + tableRowsCopied,
              rowsExpected: totalExpectedNew,
              tableRowsCopied,
              tableRowsExpected: Math.max(0, currentTotal - stored.rows),
              tablesCompleted: i,
              tablesTotal: currentCounts.length,
              percentOfTotal:
                totalExpectedNew === 0
                  ? 100
                  : ((totalAdded + tableRowsCopied) / totalExpectedNew) * 100,
              elapsedMs: performance.now() - t0,
            });
          },
          log,
        });
        added = copied;
        manifestPerTable.push({
          name,
          rows: currentTotal,
          cursorColumn,
          cursorMax,
        });
      } else {
        // No cursor or no prior manifest entry: re-copy the whole table.
        // Cheap for the small composite-PK tables we have. DELETE first so
        // updated rows replace what was there.
        sqliteHandle.exec(`DELETE FROM ${quoteIdent(name)}`);
        const { copied, cursorMax } = await this.copyTable({
          sourceTable: name,
          expectedRows: currentTotal,
          pglite: opts.pglite,
          sqlite: opts.sqlite,
          sqliteHandle,
          batchSize,
          cursorColumn,
          sampleSize: 0,
          onBatchProgress: () => { /* recopy progress is short; skip per-batch noise */ },
          log,
        });
        added = copied - (stored?.rows ?? 0);
        manifestPerTable.push({
          name,
          rows: currentTotal,
          cursorColumn,
          cursorMax,
        });
      }

      perTable.push({ name, added });
      totalAdded += Math.max(0, added);
      log('info', `[catchUp] ${name}: +${added} rows`);
    }

    sqliteHandle.pragma('foreign_keys = ON');
    const fkViolations = sqliteHandle.prepare('PRAGMA foreign_key_check').all() as unknown[];
    if (fkViolations.length > 0) {
      throw new Error(
        `catchUp: foreign_key_check failed (${fkViolations.length} violations); first: ${JSON.stringify(fkViolations[0])}`,
      );
    }

    log('info', '[catchUp] complete', { totalAdded, durationMs: performance.now() - t0 });
    return {
      rowsAdded: totalAdded,
      perTable,
      manifest: {
        completedAt: new Date().toISOString(),
        durationMs: performance.now() - t0,
        perTable: manifestPerTable,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private async measureSourceCounts(
    pglite: PGLiteHandle,
  ): Promise<{ name: string; rows: number }[]> {
    const out: { name: string; rows: number }[] = [];
    for (const name of COPY_TABLES) {
      const exists = await this.tableExistsInPglite(pglite, name);
      if (!exists) {
        out.push({ name, rows: 0 });
        continue;
      }
      const filterSql = getSourceTableFilterSql(name);
      const result = await pglite.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM ${quoteIdent(name)}${filterSql}`,
      );
      const count = Number(result.rows[0]?.c ?? 0);
      out.push({ name, rows: count });
    }
    return out;
  }

  private async getSourceColumns(pglite: PGLiteHandle, table: string): Promise<Set<string>> {
    const result = await pglite.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    );
    return new Set(result.rows.map((r) => r.column_name));
  }

  private async tableExistsInPglite(pglite: PGLiteHandle, name: string): Promise<boolean> {
    const result = await pglite.query<{ e: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS e`,
      [name],
    );
    return Boolean(result.rows[0]?.e);
  }

  private async copyTable(opts: {
    sourceTable: string;
    expectedRows: number;
    pglite: PGLiteHandle;
    sqlite: SQLiteDatabase;
    sqliteHandle: BetterSqliteDb;
    batchSize: number;
    /**
     * Single-column PK to drive cursor pagination (WHERE col > $cursor ORDER
     * BY col). When omitted falls back to LIMIT/OFFSET — only used for the
     * tiny composite-PK tables. OFFSET is O(n^2) on large tables, hence the
     * cursor path for everything > a few hundred rows.
     */
    cursorColumn?: string;
    /**
     * Start cursor for catch-up: skip rows with pk <= initialCursor. When
     * omitted, copy from the beginning of the table.
     */
    initialCursor?: string | number;
    /** Max rows to reservoir-sample for later spot-check. */
    sampleSize: number;
    onBatchProgress: (rowsCopiedInTable: number) => void;
    log: NonNullable<MigrateOptions['log']>;
  }): Promise<{ copied: number; samples: Record<string, unknown>[]; cursorMax?: string | number }> {
    if (opts.expectedRows === 0) {
      opts.onBatchProgress(0);
      return { copied: 0, samples: [] };
    }

    const target = this.getTargetColumns(opts.sqliteHandle, opts.sourceTable);
    // Intersect with the source's columns so we don't try to INSERT a target
    // column the source never had (the SQLite schema may legitimately add
    // columns that the PGLite end-state didn't carry). SQLite fills in the
    // DEFAULT for any column we omit.
    const sourceCols = await this.getSourceColumns(opts.pglite, opts.sourceTable);
    const insertableCols = target.filter(
      (c) => !c.generated && sourceCols.has(c.name),
    );
    if (insertableCols.length === 0) {
      throw new Error(`No insertable columns for ${opts.sourceTable}`);
    }
    const insertSql = `INSERT INTO ${quoteIdent(opts.sourceTable)}(${insertableCols
      .map((c) => quoteIdent(c.name))
      .join(',')}) VALUES (${insertableCols.map(() => '?').join(',')})`;

    const stmt = opts.sqliteHandle.prepare(insertSql);
    const insertMany = opts.sqliteHandle.transaction((rows: unknown[][]) => {
      for (const r of rows) stmt.run(...r);
    });

    // Cursor-paginated path: WHERE pk > $cursor ORDER BY pk LIMIT N. This is
    // O(n) total work across the whole table because each batch starts from
    // an indexed position, not from row 0. For ai_agent_messages this is the
    // difference between minutes and hours.
    const useCursor = opts.cursorColumn !== undefined
      && sourceCols.has(opts.cursorColumn);
    if (opts.cursorColumn && !useCursor) {
      opts.log(
        'warn',
        `[migrator] ${opts.sourceTable}: cursor column "${opts.cursorColumn}" not in source; falling back to OFFSET`,
      );
    }
    const pkCol = useCursor ? quoteIdent(opts.cursorColumn!) : null;
    const filterSql = getSourceTableFilterSql(opts.sourceTable);

    let copied = 0;
    let offset = 0;
    let cursor: unknown = opts.initialCursor !== undefined ? opts.initialCursor : null;
    // Reservoir sample (Algorithm R): unbiased k-of-n sample with one pass.
    const samples: Record<string, unknown>[] = [];
    let seen = 0;
    // Loop until PGLite returns 0 rows. We can't trust expectedRows as a hard
    // stop because catch-up's expectedRows is "new rows since dry-run" which
    // is just an estimate — actual new rows can be a few more (race with live
    // writes between measure and copy).
    while (true) {
      const result = useCursor
        ? cursor === null
          ? await opts.pglite.query<Record<string, unknown>>(
              `SELECT * FROM ${quoteIdent(opts.sourceTable)}${filterSql} ORDER BY ${pkCol} LIMIT $1`,
              [opts.batchSize],
            )
          : await opts.pglite.query<Record<string, unknown>>(
              `SELECT * FROM ${quoteIdent(opts.sourceTable)}${filterSql}${filterSql ? ' AND' : ' WHERE'} ${pkCol} > $1 ORDER BY ${pkCol} LIMIT $2`,
              [cursor, opts.batchSize],
            )
        : await opts.pglite.query<Record<string, unknown>>(
            `SELECT * FROM ${quoteIdent(opts.sourceTable)}${filterSql} ORDER BY 1 LIMIT $1 OFFSET $2`,
            [opts.batchSize, offset],
          );
      if (result.rows.length === 0) break;

      for (const row of result.rows) {
        if (samples.length < opts.sampleSize) {
          samples.push(row);
        } else {
          const j = Math.floor(Math.random() * (seen + 1));
          if (j < opts.sampleSize) samples[j] = row;
        }
        seen++;
      }

      const translatedBatch: unknown[][] = result.rows.map((row) =>
        this.translateRow(row, insertableCols),
      );

      // Run the insert through the hot write lane. Each batch is a single
      // BEGIN IMMEDIATE / COMMIT so we pay one fsync per batch instead of one
      // per row. The await yields the event loop after the batch commits,
      // and the next iteration awaits pglite.query() which yields again.
      const coordinator = opts.sqlite.getCoordinator();
      if (!coordinator) throw new Error('SQLiteDatabase coordinator not available');
      await coordinator.write((db: BetterSqliteDb) => {
        if (db === opts.sqliteHandle) {
          insertMany(translatedBatch);
        } else {
          // Defensive: coordinator should always pass the same handle we
          // prepared the statement against.
          throw new Error('WriteCoordinator handed a different db handle');
        }
      });

      copied += result.rows.length;
      if (useCursor) {
        // Advance cursor to the last PK we just read. PGLite returns the rows
        // already ordered by pkCol, so the last row's PK is the new high-water.
        cursor = result.rows[result.rows.length - 1][opts.cursorColumn!];
      } else {
        offset += result.rows.length;
      }
      opts.onBatchProgress(copied);

      // Safety: if PGLite returned fewer rows than batchSize, we're done.
      if (result.rows.length < opts.batchSize) break;
    }

    if (copied !== opts.expectedRows) {
      opts.log(
        'warn',
        `[migrator] ${opts.sourceTable}: copied ${copied} but expected ${opts.expectedRows}`,
      );
    }
    const cursorMax = useCursor && cursor !== null
      ? (cursor as string | number)
      : undefined;
    return { copied, samples, cursorMax };
  }

  private getTargetColumns(db: BetterSqliteDb, table: string): TargetColumn[] {
    // PRAGMA table_xinfo returns hidden=2 for GENERATED STORED columns and
    // hidden=3 for GENERATED VIRTUAL columns. Neither can appear in INSERT.
    const rows = db
      .prepare(`PRAGMA table_xinfo(${quoteIdent(table)})`)
      .all() as { name: string; type: string; hidden: number }[];
    return rows.map((r) => ({
      name: r.name,
      type: (r.type || '').toUpperCase(),
      generated: r.hidden === 2 || r.hidden === 3,
      isBlob: (r.type || '').toUpperCase().includes('BLOB'),
    }));
  }

  /**
   * Map a PGLite row into a tuple of better-sqlite3-bindable values, in the
   * order of `cols`. Type rules:
   *   - undefined / null     -> null
   *   - Date                 -> ISO-8601 string
   *   - Buffer / Uint8Array  -> Buffer (kept; for BLOB columns)
   *   - boolean              -> 0 / 1 (better-sqlite3 doesn't accept booleans)
   *   - object / array       -> JSON.stringify (covers JSONB and TEXT[])
   *   - bigint               -> kept (better-sqlite3 has bigint mode; we
   *                             default to Number-safe values, so leave as is)
   *   - number / string      -> kept verbatim
   */
  private translateRow(row: Record<string, unknown>, cols: TargetColumn[]): unknown[] {
    const out: unknown[] = new Array(cols.length);
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      const raw = row[col.name];
      out[i] = translateValue(raw, col);
    }
    return out;
  }

  /**
   * Compare pre-captured PGLite samples (taken during copy) against SQLite.
   * Stable under concurrent PGLite writes — we don't re-read the source.
   *
   * `pglite` is still passed so we can look up the source columns (information
   * schema, not table data), but only for the column-name set we need.
   */
  private spotCheckCapturedSamples(opts: {
    table: string;
    samples: Record<string, unknown>[];
    pglite: PGLiteHandle;
    sqliteHandle: BetterSqliteDb;
  }): number {
    if (opts.samples.length === 0) return 0;

    const targetCols = this.getTargetColumns(opts.sqliteHandle, opts.table);
    // Derive the source column set from the captured rows themselves: any key
    // present in a sampled row was returned by PGLite and was eligible for
    // copy. Columns the source lacked won't appear here.
    const sourceCols = new Set<string>();
    for (const r of opts.samples) {
      for (const k of Object.keys(r)) sourceCols.add(k);
    }
    const checkCols = targetCols.filter((c) => !c.generated && sourceCols.has(c.name));
    if (checkCols.length === 0) return 0;

    // Look up by the FULL primary key. Composite-PK tables like
    // tracker_body_cache (item_id, body_version) have many rows per item_id;
    // a partial-PK lookup returns whichever row SQLite picks, almost never
    // the captured one — guaranteed false "mismatch" on the non-PK columns.
    const pkCols = this.getPrimaryKeyColumns(opts.sqliteHandle, opts.table)
      .filter((name) => checkCols.some((c) => c.name === name));
    if (pkCols.length === 0) return 0;
    const pkColMetas = pkCols.map((n) => checkCols.find((c) => c.name === n)!);

    const where = pkCols.map((n) => `${quoteIdent(n)} = ?`).join(' AND ');
    const stmt = opts.sqliteHandle.prepare(
      `SELECT * FROM ${quoteIdent(opts.table)} WHERE ${where}`,
    );
    let checked = 0;
    for (const pgRow of opts.samples) {
      const pkValues = pkColMetas.map((c) => translateValue(pgRow[c.name], c));
      const sqliteRow = stmt.get(...pkValues) as Record<string, unknown> | undefined;
      if (!sqliteRow) {
        throw new Error(
          `Spot check failed: ${opts.table} PK(${pkCols.join(',')})=(${pkValues.map(String).join(',')}) not found in SQLite`,
        );
      }
      assertRowsMatch(opts.table, pgRow, sqliteRow, checkCols);
      checked++;
    }
    return checked;
  }

  private getPrimaryKeyColumns(db: BetterSqliteDb, table: string): string[] {
    // PRAGMA table_info returns each column's `pk` field as 0 (not PK) or
    // 1..N (position in the composite PK, in declaration order). Sort by `pk`
    // so composite PKs come out in the order SQLite expects.
    const rows = db
      .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
      .all() as { name: string; pk: number }[];
    return rows
      .filter((r) => r.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((r) => r.name);
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function quoteIdent(name: string): string {
  // We only accept names from a fixed whitelist (COPY_TABLES) plus column
  // names returned by PRAGMA table_xinfo / information_schema. Double-quote
  // to escape any reserved keywords.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to quote suspicious identifier: ${name}`);
  }
  return `"${name}"`;
}

function translateValue(raw: unknown, col: TargetColumn): unknown {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return raw.toISOString();
  if (raw instanceof Uint8Array || Buffer.isBuffer(raw)) {
    // better-sqlite3 accepts Buffer / Uint8Array for BLOB columns.
    return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  }
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number' || typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return JSON.stringify(raw);
  if (typeof raw === 'object') {
    // PGLite JSONB columns come back as parsed objects; stringify for storage.
    return JSON.stringify(raw);
  }
  return raw;
}

function assertRowsMatch(
  table: string,
  pgRow: Record<string, unknown>,
  sqliteRow: Record<string, unknown>,
  cols: TargetColumn[],
): void {
  for (const col of cols) {
    if (col.generated) continue;
    const pgVal = translateValue(pgRow[col.name], col);
    const sqliteVal = sqliteRow[col.name];
    if (!valuesEquivalent(pgVal, sqliteVal, col)) {
      throw new Error(
        `Spot check mismatch in ${table}.${col.name}: pglite=${stringifyForError(pgVal)}, sqlite=${stringifyForError(sqliteVal)}`,
      );
    }
  }
}

function valuesEquivalent(a: unknown, b: unknown, col: TargetColumn): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  if (Buffer.isBuffer(a) || Buffer.isBuffer(b)) {
    const av = Buffer.isBuffer(a) ? a : Buffer.from(b as Buffer);
    const bv = Buffer.isBuffer(b) ? b : Buffer.from(a as Buffer);
    return av.equals(bv);
  }
  // Numbers may come back as bigint from better-sqlite3 for INTEGER columns.
  if (
    (typeof a === 'number' || typeof a === 'bigint') &&
    (typeof b === 'number' || typeof b === 'bigint')
  ) {
    return BigInt(a as number | bigint) === BigInt(b as number | bigint);
  }
  // JSON columns: compare by parsed form to ignore key ordering and whitespace.
  if (typeof a === 'string' && typeof b === 'string') {
    if (looksLikeJson(a) || looksLikeJson(b)) {
      try {
        return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
      } catch {
        /* fall through */
      }
    }
    return a === b;
  }
  return false;
}

function looksLikeJson(s: string): boolean {
  if (s.length === 0) return false;
  const c = s[0];
  return c === '{' || c === '[' || c === '"';
}

function stringifyForError(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (Buffer.isBuffer(v)) return `<Buffer ${v.length}b>`;
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}…` : v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const __TEST_HOOKS = { COPY_TABLES, quoteIdent, translateValue };
