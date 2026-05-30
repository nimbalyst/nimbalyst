/**
 * DatabaseInstrumentation
 *
 * Per-query-shape stats, slow-query persistence, latency histogram, in-flight
 * registry. Owned by SQLiteDatabase; fed by WriteCoordinator hooks.
 *
 * The plan's Observability section is the spec. This module covers everything
 * except the Database Browser Performance tab (UI side) and the PostHog
 * pipeline (separate wiring step).
 */

import type { Database as SqliteDatabase } from 'better-sqlite3';

export type QueryKind = 'read' | 'write' | 'migration';

export interface RecordedQuery {
  sql: string;
  params?: unknown[];
  kind: QueryKind;
  durationMs: number;
  rowsAffected?: number;
  rowsReturned?: number;
  error?: Error;
  /** Caller-supplied stack (V8 stack frame at top of app code). Optional in prod. */
  stack?: string;
}

export interface SlowQueryRecord {
  id: number;
  shape: string;
  sqlSample: string;
  paramsSample: string | null;
  durationMs: number;
  kind: QueryKind;
  rowsReturned: number | null;
  rowsAffected: number | null;
  callSite: string | null;
  errorMessage: string | null;
  recordedAt: string; // ISO
}

export interface QueryShapeAggregate {
  shape: string;
  count: number;
  totalMs: number;
  p50: number;
  p95: number;
  p99: number;
  maxMs: number;
  lastCallSite: string | null;
  lastSeenAt: string;
}

export interface HistogramBuckets {
  read: HistogramRow;
  write: HistogramRow;
  migration: HistogramRow;
}

export interface HistogramRow {
  lt1ms: number;
  lt10ms: number;
  lt100ms: number;
  lt1s: number;
  gt1s: number;
}

export interface InFlightQuery {
  id: number;
  shape: string;
  startedAt: number;
  callSite: string | null;
}

export interface InFlightHandle {
  end(): void;
}

export interface InstrumentationSnapshot {
  windowMs: number;
  byShape: QueryShapeAggregate[];
  byTable: Record<string, { reads: number; writes: number; totalMs: number; p99: number }>;
  histogram: HistogramBuckets;
  inFlight: InFlightQuery[];
  coordinator: {
    batches: number;
    fsyncs: number;
    avgBatchSize: number;
    bgOps: number;
    slowBgChunks: number;
  };
  walPageBytes: number | null;
  /** Total recorded queries during the window (not just slow ones). */
  totalQueries: number;
}

export interface DatabaseInstrumentationOptions {
  /** Sample rate for non-slow queries. Slow queries are always recorded. Default 1.0. */
  sampleRate?: number;
  /** Queries >= this many ms are persisted to _perf_slow_queries. Default 100. */
  slowQueryThresholdMs?: number;
  /** Max rows kept in _perf_slow_queries before pruning. Default 10_000. */
  slowQueryMaxRows?: number;
  /** Rolling window for in-memory aggregates. Default 5 min. */
  windowMs?: number;
  /** Logger. Tests can pass a no-op. */
  log?: (level: 'info' | 'warn', msg: string) => void;
}

interface ShapeBucket {
  samples: number[];
  totalMs: number;
  count: number;
  lastCallSite: string | null;
  lastSeenAt: number;
}

const HIST_KINDS: QueryKind[] = ['read', 'write', 'migration'];

function emptyHistRow(): HistogramRow {
  return { lt1ms: 0, lt10ms: 0, lt100ms: 0, lt1s: 0, gt1s: 0 };
}

export class DatabaseInstrumentation {
  private db: SqliteDatabase | null = null;
  private sampleRate: number;
  private slowQueryThresholdMs: number;
  private slowQueryMaxRows: number;
  private windowMs: number;
  private log: (level: 'info' | 'warn', msg: string) => void;

  private shapes = new Map<string, ShapeBucket>();
  private tableStats = new Map<
    string,
    { reads: number; writes: number; totalMs: number; maxMs: number; samples: number[] }
  >();
  private histogram: HistogramBuckets = {
    read: emptyHistRow(),
    write: emptyHistRow(),
    migration: emptyHistRow(),
  };
  private totalQueries = 0;

  private inFlight = new Map<number, InFlightQuery>();
  private nextInFlightId = 1;

  // Coordinator counters
  private batches = 0;
  private fsyncs = 0;
  private batchSizeTotal = 0;
  private bgOps = 0;
  private slowBgChunks = 0;

  private insertSlowStmt: ReturnType<SqliteDatabase['prepare']> | null = null;
  private pruneSlowStmt: ReturnType<SqliteDatabase['prepare']> | null = null;

  constructor(opts: DatabaseInstrumentationOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 1.0;
    this.slowQueryThresholdMs = opts.slowQueryThresholdMs ?? 100;
    this.slowQueryMaxRows = opts.slowQueryMaxRows ?? 10_000;
    this.windowMs = opts.windowMs ?? 5 * 60 * 1000;
    this.log = opts.log ?? (() => {});
  }

  /**
   * Bind to a SQLite database. Creates the `_perf_slow_queries` table if
   * missing and prepares the insert/prune statements. Called once during
   * SQLiteDatabase init AFTER the schema has been bootstrapped.
   */
  bind(db: SqliteDatabase): void {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS _perf_slow_queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shape TEXT NOT NULL,
        sql_sample TEXT NOT NULL,
        params_sample TEXT,
        duration_ms REAL NOT NULL,
        kind TEXT NOT NULL,
        rows_returned INTEGER,
        rows_affected INTEGER,
        call_site TEXT,
        error_message TEXT,
        recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_perf_slow_recorded_at
        ON _perf_slow_queries(recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_perf_slow_shape
        ON _perf_slow_queries(shape);
    `);
    this.insertSlowStmt = db.prepare(`
      INSERT INTO _perf_slow_queries
        (shape, sql_sample, params_sample, duration_ms, kind, rows_returned, rows_affected, call_site, error_message)
      VALUES (@shape, @sqlSample, @paramsSample, @durationMs, @kind, @rowsReturned, @rowsAffected, @callSite, @errorMessage)
    `);
    this.pruneSlowStmt = db.prepare(`
      DELETE FROM _perf_slow_queries
      WHERE id IN (
        SELECT id FROM _perf_slow_queries
        ORDER BY id ASC
        LIMIT MAX(0, (SELECT COUNT(*) FROM _perf_slow_queries) - ?)
      )
    `);
  }

  setSampleRate(rate: number): void {
    this.sampleRate = Math.min(1, Math.max(0, rate));
  }

  setSlowThresholdMs(ms: number): void {
    this.slowQueryThresholdMs = Math.max(0, ms);
  }

  recordQuery(opts: RecordedQuery): void {
    this.totalQueries += 1;
    const isSlow = opts.durationMs >= this.slowQueryThresholdMs;
    const sampled = isSlow || Math.random() < this.sampleRate;

    // Histogram is cheap and useful even for un-sampled queries.
    this.recordHistogram(opts.kind, opts.durationMs);

    if (!sampled) return;

    const shape = normalizeSql(opts.sql);
    const callSite = opts.stack ? extractCallSite(opts.stack) : null;
    const now = Date.now();

    let bucket = this.shapes.get(shape);
    if (!bucket) {
      bucket = { samples: [], totalMs: 0, count: 0, lastCallSite: null, lastSeenAt: now };
      this.shapes.set(shape, bucket);
    }
    bucket.count += 1;
    bucket.totalMs += opts.durationMs;
    bucket.lastCallSite = callSite;
    bucket.lastSeenAt = now;
    bucket.samples.push(opts.durationMs);
    // Keep buckets bounded -- last N samples is enough for p99 against
    // the rolling window.
    if (bucket.samples.length > 1000) bucket.samples.shift();

    const table = extractPrimaryTable(opts.sql);
    if (table) {
      let t = this.tableStats.get(table);
      if (!t) {
        t = { reads: 0, writes: 0, totalMs: 0, maxMs: 0, samples: [] };
        this.tableStats.set(table, t);
      }
      if (opts.kind === 'read') t.reads += 1;
      else t.writes += 1;
      t.totalMs += opts.durationMs;
      if (opts.durationMs > t.maxMs) t.maxMs = opts.durationMs;
      t.samples.push(opts.durationMs);
      if (t.samples.length > 1000) t.samples.shift();
    }

    if (isSlow) {
      this.persistSlowQuery(opts, shape, callSite);
      // Surface the exact SQL + duration + call site in main.log so we don't
      // have to guess which query is hot. Shape-normalized so logs aren't
      // flooded with literal-only variants.
      this.log(
        'warn',
        `[DBInstr] SLOW ${opts.kind} ${opts.durationMs.toFixed(1)}ms${opts.rowsReturned != null ? ` rows=${opts.rowsReturned}` : ''} site=${callSite ?? '?'} sql=${shape.length > 240 ? shape.slice(0, 240) + '...' : shape}`,
      );
    }
  }

  beginInFlight(sql: string, stack?: string): InFlightHandle {
    const id = this.nextInFlightId++;
    const entry: InFlightQuery = {
      id,
      shape: normalizeSql(sql),
      startedAt: Date.now(),
      callSite: stack ? extractCallSite(stack) : null,
    };
    this.inFlight.set(id, entry);
    return {
      end: () => {
        this.inFlight.delete(id);
      },
    };
  }

  recordCoordinatorBatch(info: { batchSize: number; durationMs: number; fsynced: boolean }): void {
    this.batches += 1;
    this.batchSizeTotal += info.batchSize;
    if (info.fsynced) this.fsyncs += 1;
  }

  recordCoordinatorChunk(info: { name: string; durationMs: number; chunkIndex: number }): void {
    // Just tracking that something ran; the slow-chunk hook below is the
    // signal we care about.
    if (info.chunkIndex === 0) this.bgOps += 1;
  }

  recordSlowBgChunk(info: { name: string; durationMs: number; chunkIndex: number }): void {
    this.slowBgChunks += 1;
    this.log(
      'warn',
      `[DBInstr] slow bg chunk ${info.name}#${info.chunkIndex} ran ${info.durationMs.toFixed(1)}ms`,
    );
  }

  getSnapshot(): InstrumentationSnapshot {
    const byShape: QueryShapeAggregate[] = [];
    for (const [shape, b] of this.shapes) {
      const sorted = [...b.samples].sort((a, b2) => a - b2);
      byShape.push({
        shape,
        count: b.count,
        totalMs: Math.round(b.totalMs),
        p50: pct(sorted, 50),
        p95: pct(sorted, 95),
        p99: pct(sorted, 99),
        maxMs: sorted.length ? Math.round(sorted[sorted.length - 1]) : 0,
        lastCallSite: b.lastCallSite,
        lastSeenAt: new Date(b.lastSeenAt).toISOString(),
      });
    }
    byShape.sort((a, b2) => b2.totalMs - a.totalMs);

    const byTable: InstrumentationSnapshot['byTable'] = {};
    for (const [name, t] of this.tableStats) {
      const sorted = [...t.samples].sort((a, b2) => a - b2);
      byTable[name] = {
        reads: t.reads,
        writes: t.writes,
        totalMs: Math.round(t.totalMs),
        p99: pct(sorted, 99),
      };
    }

    return {
      windowMs: this.windowMs,
      byShape,
      byTable,
      histogram: this.histogram,
      inFlight: [...this.inFlight.values()],
      coordinator: {
        batches: this.batches,
        fsyncs: this.fsyncs,
        avgBatchSize: this.batches > 0 ? this.batchSizeTotal / this.batches : 0,
        bgOps: this.bgOps,
        slowBgChunks: this.slowBgChunks,
      },
      walPageBytes: null,
      totalQueries: this.totalQueries,
    };
  }

  getSlowQueries(limit = 50, since?: Date): SlowQueryRecord[] {
    if (!this.db) return [];
    const params: unknown[] = [];
    let where = '';
    if (since) {
      where = 'WHERE recorded_at >= ?';
      params.push(since.toISOString());
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT id, shape, sql_sample, params_sample, duration_ms, kind,
                rows_returned, rows_affected, call_site, error_message, recorded_at
         FROM _perf_slow_queries
         ${where}
         ORDER BY recorded_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      shape: r.shape as string,
      sqlSample: r.sql_sample as string,
      paramsSample: (r.params_sample as string | null) ?? null,
      durationMs: r.duration_ms as number,
      kind: r.kind as QueryKind,
      rowsReturned: (r.rows_returned as number | null) ?? null,
      rowsAffected: (r.rows_affected as number | null) ?? null,
      callSite: (r.call_site as string | null) ?? null,
      errorMessage: (r.error_message as string | null) ?? null,
      recordedAt: r.recorded_at as string,
    }));
  }

  /** Reset rolling counters. Tests call this between cases. */
  reset(): void {
    this.shapes.clear();
    this.tableStats.clear();
    this.histogram = {
      read: emptyHistRow(),
      write: emptyHistRow(),
      migration: emptyHistRow(),
    };
    this.totalQueries = 0;
    this.batches = 0;
    this.fsyncs = 0;
    this.batchSizeTotal = 0;
    this.bgOps = 0;
    this.slowBgChunks = 0;
  }

  private recordHistogram(kind: QueryKind, ms: number): void {
    const row = this.histogram[kind];
    if (!row) return;
    if (ms < 1) row.lt1ms += 1;
    else if (ms < 10) row.lt10ms += 1;
    else if (ms < 100) row.lt100ms += 1;
    else if (ms < 1000) row.lt1s += 1;
    else row.gt1s += 1;
  }

  private persistSlowQuery(opts: RecordedQuery, shape: string, callSite: string | null): void {
    if (!this.insertSlowStmt || !this.pruneSlowStmt || !this.db) return;
    // recordQuery (and therefore this method) runs INSIDE queryReadOnly's
    // `PRAGMA query_only = ON` scope when the slow query was a read. Writing
    // to `_perf_slow_queries` under that pragma raises "attempt to write a
    // readonly database" -- so flip query_only off for just the duration of
    // the persist, then restore. This is safe because everything here runs
    // synchronously on a single-threaded better-sqlite3 connection.
    const db = this.db;
    let wasReadOnly = false;
    try {
      wasReadOnly = Number(db.pragma('query_only', { simple: true })) > 0;
      if (wasReadOnly) db.pragma('query_only = OFF');
      try {
        this.insertSlowStmt.run({
          shape,
          sqlSample: opts.sql.length > 2000 ? opts.sql.slice(0, 2000) + '...' : opts.sql,
          paramsSample: opts.params ? safeStringifyParams(opts.params) : null,
          durationMs: opts.durationMs,
          kind: opts.kind,
          rowsReturned: opts.rowsReturned ?? null,
          rowsAffected: opts.rowsAffected ?? null,
          callSite,
          errorMessage: opts.error ? String(opts.error.message ?? opts.error) : null,
        });
        // Cheap pruning -- only DELETE when we're plausibly over the cap.
        if (Math.random() < 0.01) {
          this.pruneSlowStmt.run(this.slowQueryMaxRows);
        }
      } finally {
        if (wasReadOnly) {
          try { db.pragma('query_only = ON'); } catch { /* db may be closing */ }
        }
      }
    } catch (err) {
      this.log('warn', `[DBInstr] failed to persist slow query: ${(err as Error).message}`);
    }
  }
}

/**
 * Normalize a SQL string into a shape key by replacing literals with `?` and
 * collapsing whitespace. Cheap regex pass, not a real parser.
 */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/'([^']|'')*'/g, '?')
    .replace(/"([^"]|"")*"/g, '?')
    // Positional params must be replaced before the bare-number rule, otherwise
    // the digit inside `$1` is eaten first and we end up with `$?`.
    .replace(/\$\d+/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const TABLE_PATTERNS = [
  /^select\b.+?\bfrom\s+([a-z_][a-z0-9_]*)/i,
  /^insert\s+into\s+([a-z_][a-z0-9_]*)/i,
  /^update\s+([a-z_][a-z0-9_]*)/i,
  /^delete\s+from\s+([a-z_][a-z0-9_]*)/i,
  /^create\s+(?:virtual\s+)?(?:table|index|trigger)\b.*?\b(?:on\s+)?([a-z_][a-z0-9_]*)/i,
  /^alter\s+table\s+([a-z_][a-z0-9_]*)/i,
  /^drop\s+(?:table|index|trigger)\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_]*)/i,
];

export function extractPrimaryTable(sql: string): string | null {
  const trimmed = sql.replace(/\s+/g, ' ').trim();
  for (const re of TABLE_PATTERNS) {
    const m = trimmed.match(re);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

export function extractCallSite(stack: string): string | null {
  const lines = stack.split('\n');
  // First line is the Error message; skip it and the database-layer frames.
  for (const line of lines) {
    if (!line.includes('    at ')) continue;
    if (/SQLiteDatabase\.|DatabaseInstrumentation\.|WriteCoordinator\./.test(line)) continue;
    if (/node_modules\/better-sqlite3\//.test(line)) continue;
    return line.trim();
  }
  return null;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

function safeStringifyParams(params: unknown[]): string {
  try {
    return JSON.stringify(params).slice(0, 1024);
  } catch {
    return String(params).slice(0, 1024);
  }
}

// Kinds are exposed for callers that need to iterate the histogram safely.
export { HIST_KINDS };
