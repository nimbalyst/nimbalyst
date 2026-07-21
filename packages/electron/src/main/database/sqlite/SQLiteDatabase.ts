/**
 * SQLiteDatabase
 *
 * better-sqlite3 implementation with the same async surface as
 * `PGLiteDatabaseWorker` (`query`, `queryReadOnly`, `exec`, `getStats`,
 * `verifyBackup`, `setBackupService`, `createBackup`, `close`, `isInitialized`,
 * `getDB`). Call sites in services/IPC don't change shape; SQL itself needs
 * translation (JSONB → JSON, `$1` → `?`) — that happens callsite-by-callsite
 * during the service-layer audit, not here.
 *
 * Architecture:
 *   - Single connection, opened on the main thread (better-sqlite3 is sync).
 *   - WAL + foreign_keys + bounded WAL size, set on open.
 *   - All writes route through `WriteCoordinator` so we get batched fsync and
 *     a serialized write lane. Background work (FTS rebuild, bulk import,
 *     migrator) uses `coordinator.runBackground(...)`.
 *   - Read path bypasses the coordinator and runs synchronously inline.
 *     `queryReadOnly` wraps the call in `PRAGMA query_only = ON` plus a
 *     JS-level timeout that calls `db.interrupt()` on overrun.
 *   - DatabaseInstrumentation records every call; slow ones land in
 *     `_perf_slow_queries`.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AppDatabaseBackupService } from '../PGLiteDatabaseWorker';
import {
  DatabaseInstrumentation,
  type QueryKind,
} from './DatabaseInstrumentation';
import { WriteCoordinator } from './WriteCoordinator';
import { runMigrations } from './MigrationRunner';
import { translateAndBind, translateSql } from './dialectTranslator';

// better-sqlite3 ships its own types. We import the constructor lazily inside
// `open()` so this module can be statically imported in environments where
// the native binding hasn't been compiled (e.g. some test runners). The
// production main process always has the binding.
type SqliteCtor = typeof import('better-sqlite3');
type SqliteDatabaseHandle = import('better-sqlite3').Database;

let cachedBetterSqlite: SqliteCtor | null = null;
function loadBetterSqlite(): SqliteCtor {
  if (cachedBetterSqlite) return cachedBetterSqlite;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('better-sqlite3') as SqliteCtor | { default: SqliteCtor };
  cachedBetterSqlite = (mod as { default?: SqliteCtor }).default ?? (mod as SqliteCtor);
  return cachedBetterSqlite;
}

/**
 * Optional override for the native better-sqlite3 binding path. Set by
 * vitest.globalSetup.ts so unit tests can load a Node-ABI prebuild without
 * disturbing the Electron-ABI binary in `node_modules/.../build/Release/`
 * that the dev server depends on.
 */
function nativeBindingOverride(): string | undefined {
  return process.env.NIMBALYST_BETTER_SQLITE3_NATIVE || undefined;
}

export interface SQLiteDatabaseOptions {
  /** Directory holding `nimbalyst.sqlite` and its WAL/SHM siblings. */
  dbDir: string;
  /** Directory holding the migration SQL files. */
  schemaDir: string;
  /** Slow-query log threshold in ms. Default 100. */
  slowQueryThresholdMs?: number;
  /** Sample rate for non-slow query recording. Slow queries always recorded. */
  sampleRate?: number;
  /** Logger. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
}

export interface QueryResult<T = unknown> {
  rows: T[];
}

export class SQLiteDatabase {
  private db: SqliteDatabaseHandle | null = null;
  private coordinator: WriteCoordinator | null = null;
  private instrumentation: DatabaseInstrumentation;
  private backupService: AppDatabaseBackupService | null = null;
  private opts: SQLiteDatabaseOptions;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(opts: SQLiteDatabaseOptions) {
    this.opts = opts;
    this.instrumentation = new DatabaseInstrumentation({
      slowQueryThresholdMs: opts.slowQueryThresholdMs ?? 100,
      sampleRate: opts.sampleRate,
      log: (level, msg) => this.opts.log?.(level === 'info' ? 'info' : 'warn', msg),
    });
  }

  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    if (this.initialized) return;
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  private async doInitialize(): Promise<void> {
    const t0 = performance.now();
    fs.mkdirSync(this.opts.dbDir, { recursive: true });
    const dbPath = path.join(this.opts.dbDir, 'nimbalyst.sqlite');

    const Sqlite = loadBetterSqlite();
    const nativeBinding = nativeBindingOverride();
    const handle = new Sqlite(
      dbPath,
      nativeBinding ? { fileMustExist: false, nativeBinding } : { fileMustExist: false },
    );

    // Pragmas: WAL gives us concurrent reads + crash recovery; NORMAL fsync
    // is the standard for desktop apps (FULL is overkill for non-financial
    // workloads). foreign_keys ON matches PGLite default behavior.
    handle.pragma('journal_mode = WAL');
    handle.pragma('synchronous = NORMAL');
    handle.pragma('foreign_keys = ON');
    // Cap WAL growth before auto-checkpoint kicks in. SQLite auto-checkpoints
    // every 1000 pages of WAL; bumping it gives us better write-batching while
    // keeping the WAL recoverable.
    handle.pragma('wal_autocheckpoint = 2000');
    handle.pragma('temp_store = MEMORY');
    // 64 MB cache is comfortable for typical session DBs without exploding
    // RSS on machines under pressure.
    handle.pragma('cache_size = -64000');
    handle.function('to_timestamp', (seconds: number) =>
      new Date(Number(seconds) * 1000).toISOString(),
    );
    handle.function('jsonb_strip_nulls', (value: unknown) =>
      JSON.stringify(stripNullsFromJsonLike(value)),
    );

    this.db = handle;
    this.opts.log?.('info', `[SQLite] opened ${dbPath}`);

    // Schema bootstrap. The migrator runs inside its own transaction; if it
    // throws we leave the file half-formed for diagnosis (caller should
    // delete and retry).
    const migrationResult = runMigrations(handle, this.opts.schemaDir);
    this.opts.log?.(
      'info',
      `[SQLite] migrations: applied=${migrationResult.applied.join(',') || 'none'}, skipped=${migrationResult.skipped.join(',') || 'none'}`,
    );

    this.instrumentation.bind(handle);

    this.coordinator = new WriteCoordinator(handle, {
      log: (level, msg) => this.opts.log?.(level, msg),
      onBatch: (info) => this.instrumentation.recordCoordinatorBatch(info),
      onChunk: (info) => this.instrumentation.recordCoordinatorChunk(info),
      onSlowChunk: (info) => this.instrumentation.recordSlowBgChunk(info),
    });

    this.initialized = true;
    const dt = performance.now() - t0;
    this.opts.log?.('info', `[SQLite] initialized in ${dt.toFixed(0)}ms`);
  }

  setBackupService(svc: AppDatabaseBackupService): void {
    this.backupService = svc;
  }

  /**
   * Run a SQL statement. Routes through the WriteCoordinator when the leading
   * verb is DML/DDL; otherwise treated as a read and run synchronously inline.
   */
  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    if (!this.initialized || !this.db) {
      throw new Error('SQLiteDatabase not initialized. Call initialize() first.');
    }
    // No-op explicit transaction control statements. Callers like
    // PGLiteAgentMessagesStore issue `BEGIN`/`COMMIT`/`ROLLBACK` around
    // multi-statement writes to get PG-style atomicity. On SQLite those
    // writes route through WriteCoordinator, which already wraps every batch
    // tick in a transaction — an inner BEGIN throws "cannot start a
    // transaction within a transaction". Statements that land in the same
    // tick are still atomic-by-coincidence, which matches what these stores
    // need (back-to-back INSERT + UPDATE arrive within the ~5ms batch
    // window). True multi-statement atomicity across awaited boundaries
    // should use `runBackground` instead, not BEGIN/COMMIT.
    const trimmed = sql.trim().toLowerCase();
    if (trimmed === 'begin' || trimmed === 'commit' || trimmed === 'rollback'
      || trimmed.startsWith('begin ') || trimmed.startsWith('begin;')
      || trimmed.startsWith('commit ') || trimmed.startsWith('commit;')
      || trimmed.startsWith('rollback ') || trimmed.startsWith('rollback;')) {
      return { rows: [] } as QueryResult<T>;
    }
    const kind = classifyKind(sql);
    if (kind === 'read') {
      return this.runRead<T>(sql, params, /*readOnly*/ false);
    }
    return this.runWrite<T>(sql, params);
  }

  /**
   * Read-only query with a bounded timeout. Used by the extension
   * `host.data.query` IPC and the MCP `database_query` tool.
   * Enforces read-only via `PRAGMA query_only = ON` for the duration of the
   * call. Timeout is enforced by a JS-side timer that calls `db.interrupt()`.
   */
  async queryReadOnly<T = unknown>(
    sql: string,
    params: unknown[] = [],
    timeoutMs = 5000,
  ): Promise<QueryResult<T>> {
    if (!this.initialized || !this.db) {
      throw new Error('SQLiteDatabase not initialized. Call initialize() first.');
    }
    const bounded = Math.max(1, Math.min(timeoutMs, 30_000));
    let interruptTimer: ReturnType<typeof setTimeout> | undefined;
    const db = this.db;
    db.pragma('query_only = ON');
    let timedOut = false;
    interruptTimer = setTimeout(() => {
      timedOut = true;
      try {
        db.exec('SELECT raise_application_error');
      } catch {
        // raise_application_error doesn't exist in SQLite -- we use this as
        // a no-op; the real interrupt comes from the next line.
      }
      try {
        // db.interrupt() is the documented way to cancel an in-flight call.
        // Available on better-sqlite3 v11+.
        (db as unknown as { interrupt?: () => void }).interrupt?.();
      } catch {
        /* ignore */
      }
    }, bounded);
    try {
      return await this.runRead<T>(sql, params, /*readOnly*/ true);
    } catch (err) {
      if (timedOut) {
        throw new Error(`canceling statement due to statement timeout (${bounded}ms)`);
      }
      throw err;
    } finally {
      if (interruptTimer) clearTimeout(interruptTimer);
      try {
        db.pragma('query_only = OFF');
      } catch {
        /* db may have been closed; ignore */
      }
    }
  }

  /**
   * Execute a statement with no return value. Routes writes through the
   * WriteCoordinator; treats SELECT-shape as a no-op-bearing read.
   */
  async exec(sql: string, _timeoutMs = 30_000): Promise<void> {
    if (!this.initialized || !this.db) {
      throw new Error('SQLiteDatabase not initialized. Call initialize() first.');
    }
    const kind = classifyKind(sql);
    if (kind === 'read') {
      const t0 = performance.now();
      const stack = captureStack();
      const handle = this.instrumentation.beginInFlight(sql, stack);
      try {
        this.db.exec(sql);
      } finally {
        handle.end();
        this.instrumentation.recordQuery({
          sql,
          kind: 'read',
          durationMs: performance.now() - t0,
          stack,
        });
      }
      return;
    }
    await this.runWriteExec(sql);
  }

  runTransaction<T = unknown>(
    statements: Array<{ sql: string; params?: unknown[]; expectedRowCount?: 1 }>,
  ): Promise<Array<{ rows: T[] }>>;
  runTransaction(
    statements: Array<{ sql: string; params?: unknown[] }>,
  ): Promise<void>;
  async runTransaction<T = unknown>(
    statements: Array<{ sql: string; params?: unknown[]; expectedRowCount?: 1 }>,
  ): Promise<Array<{ rows: T[] }> | void> {
    if (!this.initialized || !this.db) {
      throw new Error('SQLiteDatabase not initialized. Call initialize() first.');
    }
    if (statements.length === 0) throw new Error('transaction requires at least one statement');
    for (const [index, statement] of statements.entries()) {
      if (!statement || typeof statement.sql !== 'string') {
        throw new Error(`transaction statement ${index} sql must be a string`);
      }
      if (
        statement.expectedRowCount !== undefined
        && statement.expectedRowCount !== 1
      ) {
        throw new Error(`transaction statement ${index} has invalid expected row count`);
      }
    }
    const db = this.db;
    const run = db.transaction(() => {
      const results: Array<{ rows: T[] }> = [];
      for (const statement of statements) {
        const adapted = adaptSqlForSQLite(statement.sql, statement.params ?? []);
        const prepared = db.prepare(adapted.sql);
        if (stmtReturnsRows(prepared)) {
          const rows = prepared.all(...adapted.params) as T[];
          if (statement.expectedRowCount === 1 && rows.length !== 1) {
            throw new Error(
              `transaction expected row count mismatch at statement ${results.length}: expected 1, got ${rows.length}`,
            );
          }
          results.push({ rows });
        } else {
          if (statement.expectedRowCount === 1) {
            throw new Error(`transaction statement ${results.length} requires RETURNING`);
          }
          prepared.run(...adapted.params);
          results.push({ rows: [] });
        }
      }
      return results;
    });
    return run();
  }

  /**
   * Run a long-running write operation through the coordinator's background
   * lane. Use for FTS rebuilds, bulk imports, the PGLite→SQLite migrator.
   * See WriteCoordinator.runBackground for the chunk contract.
   */
  runBackground = <T>(work: Parameters<WriteCoordinator['runBackground']>[0]): Promise<T | undefined> => {
    if (!this.coordinator) throw new Error('SQLiteDatabase not initialized');
    return this.coordinator.runBackground(work) as Promise<T | undefined>;
  };

  async getStats(): Promise<unknown> {
    if (!this.initialized || !this.db) {
      throw new Error('SQLiteDatabase not initialized.');
    }
    const dbPath = path.join(this.opts.dbDir, 'nimbalyst.sqlite');
    let dbBytes = 0;
    try {
      dbBytes = fs.statSync(dbPath).size;
    } catch {
      /* ignore */
    }
    let walBytes = 0;
    try {
      walBytes = fs.statSync(`${dbPath}-wal`).size;
    } catch {
      /* ignore */
    }
    const snapshot = this.instrumentation.getSnapshot();
    return {
      backend: 'sqlite' as const,
      dbBytes,
      walBytes,
      pageCount: (this.db.pragma('page_count', { simple: true }) as number) ?? null,
      pageSize: (this.db.pragma('page_size', { simple: true }) as number) ?? null,
      queryStats: snapshot,
    };
  }

  async verifyBackup(backupPath: string): Promise<{
    valid: boolean;
    error?: string;
    hasData?: boolean;
    sessionCount?: number;
    historyCount?: number;
  }> {
    try {
      const Sqlite = loadBetterSqlite();
      const nativeBinding = nativeBindingOverride();
      const handle = new Sqlite(
        backupPath,
        nativeBinding
          ? { fileMustExist: true, readonly: true, nativeBinding }
          : { fileMustExist: true, readonly: true },
      );
      const integrity = (handle.pragma('integrity_check', { simple: true }) as string) ?? '';
      if (integrity !== 'ok') {
        handle.close();
        return { valid: false, error: `integrity_check returned: ${integrity}` };
      }
      const sessionCount = (handle.prepare('SELECT COUNT(*) AS c FROM ai_sessions').get() as
        | { c: number }
        | undefined)?.c ?? 0;
      const historyCount = (handle.prepare('SELECT COUNT(*) AS c FROM document_history').get() as
        | { c: number }
        | undefined)?.c ?? 0;
      handle.close();
      return {
        valid: true,
        hasData: sessionCount > 0 || historyCount > 0,
        sessionCount,
        historyCount,
      };
    } catch (err) {
      return { valid: false, error: (err as Error).message };
    }
  }

  async createBackup(): Promise<{ success: boolean; error?: string }> {
    if (!this.backupService) {
      return { success: false, error: 'Backup service not initialized' };
    }
    return this.backupService.createBackup();
  }

  getBackupService(): AppDatabaseBackupService | null {
    return this.backupService;
  }

  /** Read-only access to the underlying better-sqlite3 handle, mainly for tests. */
  getRawHandle(): SqliteDatabaseHandle | null {
    return this.db;
  }

  getDB(): {
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>;
    exec: (sql: string) => Promise<void>;
  } {
    if (!this.initialized) {
      throw new Error('SQLiteDatabase not initialized. Call initialize() first.');
    }
    return {
      query: <T = unknown>(sql: string, params?: unknown[]) => this.query<T>(sql, params),
      exec: (sql: string) => this.exec(sql),
    };
  }

  getInstrumentation(): DatabaseInstrumentation {
    return this.instrumentation;
  }

  getCoordinator(): WriteCoordinator | null {
    return this.coordinator;
  }

  async close(): Promise<void> {
    this.coordinator?.close();
    this.coordinator = null;
    if (this.db) {
      try {
        // Final checkpoint so the WAL is fully merged before close.
        this.db.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        /* ignore */
      }
      this.db.close();
      this.db = null;
    }
    this.initialized = false;
    this.initPromise = null;
  }

  // --------------------------------------------------------------------------
  // Internal: read + write code paths.
  // --------------------------------------------------------------------------

  private async runRead<T>(
    sql: string,
    params: unknown[],
    readOnly: boolean,
  ): Promise<QueryResult<T>> {
    if (!this.db) throw new Error('not open');
    const adapted = adaptSqlForSQLite(sql, params);
    const stack = captureStack();
    const inFlight = this.instrumentation.beginInFlight(adapted.sql, stack);
    const t0 = performance.now();
    try {
      const stmt = this.db.prepare(adapted.sql);
      let rows: T[] = [];
      if (stmtReturnsRows(stmt)) {
        rows = stmt.all(...adapted.params) as T[];
      } else {
        // Some "read" callers pass writes by mistake. In read-only mode the
        // PRAGMA blocks them at the engine level; in normal mode we just
        // execute and return no rows.
        stmt.run(...adapted.params);
      }
      const durationMs = performance.now() - t0;
      this.instrumentation.recordQuery({
        sql: adapted.sql,
        params: adapted.params,
        kind: 'read',
        durationMs,
        rowsReturned: rows.length,
        stack,
      });
      return { rows };
    } catch (err) {
      const durationMs = performance.now() - t0;
      this.instrumentation.recordQuery({
        sql: adapted.sql,
        params: adapted.params,
        kind: 'read',
        durationMs,
        error: err as Error,
        stack,
      });
      // If this was a read-only PRAGMA rejection, re-throw with a clearer msg.
      if (readOnly && /attempt to write a readonly/i.test((err as Error).message)) {
        throw new Error('queryReadOnly received a non-SELECT statement');
      }
      throw err;
    } finally {
      inFlight.end();
    }
  }

  // EXPERIMENT (2026-05-28): bypass WriteCoordinator for hot-lane writes.
  // The coordinator's batched-fsync design adds a setTimeout(batchWindowMs)
  // hop to every write; in the test workload that hop turned into 100-228 ms
  // of wall-clock delay (see _perf_slow_queries from a SQLite e2e run) which
  // in turn blocks unrelated read IPC behind it. Routing writes directly
  // through better-sqlite3 lets each write commit inline, paying its own
  // fsync (cheap under WAL+NORMAL) but never queueing behind a batch tick.
  // runBackground / bg-lane code still uses the coordinator unchanged.
  private async runWrite<T>(sql: string, params: unknown[]): Promise<QueryResult<T>> {
    if (!this.db) throw new Error('not open');
    const adapted = adaptSqlForSQLite(sql, params);
    const stack = captureStack();
    const inFlight = this.instrumentation.beginInFlight(adapted.sql, stack);
    const t0 = performance.now();
    try {
      const stmt = this.db.prepare(adapted.sql);
      let result: QueryResult<T>;
      if (stmtReturnsRows(stmt)) {
        result = { rows: stmt.all(...adapted.params) as T[] };
      } else {
        const info = stmt.run(...adapted.params);
        result = { rows: [], rowsAffected: info.changes } as unknown as QueryResult<T>;
      }
      this.instrumentation.recordQuery({
        sql: adapted.sql,
        params: adapted.params,
        kind: 'write',
        durationMs: performance.now() - t0,
        rowsReturned: result.rows.length,
        stack,
      });
      return result;
    } catch (err) {
      this.instrumentation.recordQuery({
        sql: adapted.sql,
        params: adapted.params,
        kind: 'write',
        durationMs: performance.now() - t0,
        error: err as Error,
        stack,
      });
      throw err;
    } finally {
      inFlight.end();
    }
  }

  private async runWriteExec(sql: string): Promise<void> {
    if (!this.db) throw new Error('not open');
    const adapted = adaptSqlForSQLite(sql, []);
    const stack = captureStack();
    const inFlight = this.instrumentation.beginInFlight(adapted.sql, stack);
    const t0 = performance.now();
    try {
      this.db.exec(adapted.sql);
      this.instrumentation.recordQuery({
        sql: adapted.sql,
        kind: 'write',
        durationMs: performance.now() - t0,
        stack,
      });
    } catch (err) {
      this.instrumentation.recordQuery({
        sql: adapted.sql,
        kind: 'write',
        durationMs: performance.now() - t0,
        error: err as Error,
        stack,
      });
      throw err;
    } finally {
      inFlight.end();
    }
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function classifyKind(sql: string): QueryKind {
  const trimmed = sql.replace(/^\s+/, '').toLowerCase();
  if (
    trimmed.startsWith('insert') ||
    trimmed.startsWith('update') ||
    trimmed.startsWith('delete') ||
    trimmed.startsWith('replace') ||
    trimmed.startsWith('alter') ||
    trimmed.startsWith('create') ||
    trimmed.startsWith('drop') ||
    trimmed.startsWith('truncate') ||
    trimmed.startsWith('begin') ||
    trimmed.startsWith('commit') ||
    trimmed.startsWith('rollback') ||
    trimmed.startsWith('vacuum')
  ) {
    return 'write';
  }
  return 'read';
}

function stmtReturnsRows(stmt: import('better-sqlite3').Statement): boolean {
  // better-sqlite3 exposes `reader` to indicate the statement returns rows
  // (SELECT, RETURNING, PRAGMA-with-result).
  return (stmt as unknown as { reader: boolean }).reader === true;
}

function captureStack(): string | undefined {
  // Cheap stack capture; we strip the leading frames inside the instrumentation
  // when extracting the call site.
  const err = { stack: '' };
  Error.captureStackTrace(err, captureStack);
  return err.stack || undefined;
}

function stripNullsFromJsonLike(value: unknown): unknown {
  const parsed = typeof value === 'string' ? safeParseJson(value) : value;
  if (Array.isArray(parsed)) {
    return parsed.map(stripNullsFromJsonLike);
  }
  if (parsed && typeof parsed === 'object') {
    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter(([, child]) => child !== null)
      .map(([key, child]) => [key, stripNullsFromJsonLike(child)]);
    return Object.fromEntries(entries);
  }
  return parsed;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

interface SqlAdaptResult {
  sql: string;
  /**
   * Params for `stmt.run(...)` / `stmt.all(...)`. With named-bind translation
   * this is a single-element array containing the bind object; callers spread
   * it (`stmt.all(...adapted.params)`), which becomes `stmt.all(bindsObject)`
   * - the form better-sqlite3 accepts for `$pN` placeholders.
   */
  params: unknown[];
}

/**
 * Adapt PG-flavored SQL into better-sqlite3-friendly SQL with bound params.
 *
 * Two input shapes are supported:
 *   1. PG-style: `WHERE id = $1` + array params - translated via
 *      dialectTranslator (handles `$N`, `NOW()`, jsonb_set, ANY array,
 *      to_jsonb, jsonb_build_object, INTERVAL math, type casts). Returns
 *      `[bindsObject]` as the param array for spread-call.
 *   2. Pre-translated: SQL already uses `$pN` named binds + the params
 *      array's only element is a plain object (the bind map). We pass
 *      through unchanged so internal callsites (the store adapter's FTS
 *      helpers, the migrator's ad-hoc queries) don't get double-translated.
 *
 * Additional rewrites that the dialectTranslator deliberately doesn't own
 * (because they're rare and SQLite-engine-specific rather than dialect):
 *   - `DROP TABLE ... CASCADE` -> `DROP TABLE ...` (SQLite cascade is implicit)
 *   - `REINDEX TABLE x` -> `REINDEX x`
 *   - `POSITION(needle IN haystack)` -> `instr(haystack, needle)`
 */
function adaptSqlForSQLite(sql: string, params: unknown[]): SqlAdaptResult {
  if (isAlreadyNamedBinds(params)) {
    return {
      sql: applyPostTranslationRewrites(sql),
      params: [normalizeBindObject(params[0] as Record<string, unknown>)],
    };
  }
  // SQL with no `$N` placeholders is either a `?`-style native bind from a
  // test/migrator call, or a param-free statement that may still contain
  // PG-isms like `NOW() - INTERVAL '1 day'`. Always run the SQL-level
  // translation (it's a no-op on `?`); only the bind-conversion path is
  // skipped when there are no `$N` to rewrite.
  if (!HAS_POSITIONAL_DOLLAR_PARAM.test(sql)) {
    const translated = translateSql(sql);
    return {
      sql: applyPostTranslationRewrites(translated.sql),
      params: params.map(normalizeBindValue),
    };
  }
  const { sql: translatedSql, binds } = translateAndBind(sql, params);
  return {
    sql: applyPostTranslationRewrites(translatedSql),
    params: [normalizeBindObject(binds)],
  };
}

/**
 * better-sqlite3 only accepts numbers, strings, bigints, buffers, and null.
 * Stores frequently pass Date/boolean/undefined/plain-object/array values
 * directly into bind params; normalize them at this single boundary so the
 * call sites don't each have to know the difference.
 */
function normalizeBindValue(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  }
  if (typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'bigint') {
    return raw;
  }
  if (Array.isArray(raw) || (typeof raw === 'object' && raw !== null)) {
    return JSON.stringify(raw);
  }
  return raw;
}

function normalizeBindObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    out[k] = normalizeBindValue(obj[k]);
  }
  return out;
}

const HAS_POSITIONAL_DOLLAR_PARAM = /\$\d+/;

function applyPostTranslationRewrites(sql: string): string {
  return sql
    .replace(/POSITION\((.+?)\s+IN\s+(.+?)\)/gi, 'instr($2, $1)')
    .replace(/DROP TABLE IF EXISTS ([a-zA-Z_][a-zA-Z0-9_]*) CASCADE/gi, 'DROP TABLE IF EXISTS $1')
    .replace(/REINDEX TABLE ([a-zA-Z_][a-zA-Z0-9_]*)/gi, 'REINDEX $1');
}

function isAlreadyNamedBinds(params: unknown[]): boolean {
  return (
    params.length === 1 &&
    params[0] !== null &&
    typeof params[0] === 'object' &&
    !Array.isArray(params[0]) &&
    !(params[0] instanceof Date) &&
    !(params[0] instanceof Buffer) &&
    !(params[0] instanceof Uint8Array)
  );
}
