/**
 * SQLiteDatabaseProxy
 *
 * Main-thread proxy that mirrors the public surface of `SQLiteDatabase` but
 * forwards every call to a `worker_threads` Worker. Reasoning: better-sqlite3
 * is synchronous on the calling thread. Running it on main blocks the
 * Electron IPC loop while any query is in flight — the dashboard scans on a
 * 7.5 GB DB demonstrated this with multi-second freezes. The PGLite backend
 * lived in a worker for exactly this reason; SQLite gets the same treatment.
 *
 * Surface kept compatible with `SQLiteDatabase` so existing call sites
 * (`database.query / queryReadOnly / exec / getStats / verifyBackup /
 * createBackup / setBackupService / close / isInitialized / initialize`)
 * continue to compile unchanged.
 *
 * Surface NOT exposed (worker-internal): `getRawHandle`, `getInstrumentation`,
 * `getCoordinator`, `runBackground`, `prepare`. Callers that used those
 * have been migrated to the explicit `pragmaRead` / `dashboardTableStats` /
 * `getPerformance` methods below.
 *
 * Worker lifecycle: a single Worker is spawned by `initialize()`. It lives
 * for the app lifetime. `close()` shuts it down. Each `query/exec/etc.` call
 * issues a uuid-keyed request; the response handler resolves the matching
 * promise. Errors crossing the boundary are reconstructed into real Errors
 * so try/catch in callers behaves the same as before.
 */

import { Worker } from 'worker_threads';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { app, BrowserWindow } from 'electron';
import { logger } from '../../utils/logger';
import { getPackageRoot } from '../../utils/appPaths';
import type { AppDatabaseBackupService } from '../PGLiteDatabaseWorker';
import type {
  InitPayload,
  QueryResult,
  ResponseEnvelope,
  WorkerRequestType,
  SerializedError,
  MigrationPreflightResult,
  DryRunStatusResult,
  PgliteReadRequestPayload,
  TransactionPayload,
  WorkerControlRequestPayload,
} from './worker/workerProtocol';
import type { MigrationSummary } from './PGLiteToSQLiteMigrator';
import type { DryRunResult } from './MigrationDryRunner';
import type { AdoptResult } from './MigrationAdopter';

/**
 * Read surface satisfied by the live PGLite worker. The proxy hands every
 * `pgliteReadRequest` event from the SQLite worker to this callback so the
 * migration pipeline running inside the SQLite worker can pull rows from
 * PGLite (which lives in a different worker_threads thread).
 */
export interface LivePgliteReader {
  queryReadOnly<T = unknown>(
    sql: string,
    params?: unknown[],
    timeoutMs?: number,
  ): Promise<{ rows: T[] }>;
}

/**
 * Control hooks the migration pipeline can ask main to run. Currently only
 * `closePglite`; new actions go through the same `workerControlRequest` event
 * channel so we don't proliferate one-off message types.
 */
export interface MigrationControlHandler {
  closePglite: () => Promise<void>;
  onCutoverSuccess?: (info: { sqliteDir: string; pgliteMigratedDir: string }) => Promise<void> | void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /**
   * Timeout handle, cleared on response or rejection so we don't leak a
   * 60-second timer per query into the Node timer wheel. Under sustained AI
   * streaming load (1000s of writes/reads per session) the leaked timers
   * dominate event-loop CPU even after the queries themselves resolve.
   */
  timer?: ReturnType<typeof setTimeout>;
}

export interface SQLiteDatabaseProxyOptions {
  /** Directory holding `nimbalyst.sqlite` and its WAL/SHM siblings. */
  dbDir: string;
  /** Directory holding the migration SQL files. */
  schemaDir: string;
  /** Slow-query log threshold in ms. Default 100. */
  slowQueryThresholdMs?: number;
  /** Sample rate (0..1) for the instrumentation rolling window. */
  sampleRate?: number;
  /** Request timeout in ms (default 60s; init uses 120s). */
  requestTimeoutMs?: number;
}

function serializeBridgeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return {
      message: err.message,
      name: err.name,
      stack: err.stack,
      code: (err as { code?: string }).code,
    };
  }
  return { message: String(err) };
}

/** Resolve the on-disk path to the SQLite worker bundle. */
function resolveWorkerPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'sqlite-worker.bundle.js');
  }
  return path.join(getPackageRoot(), 'out', 'sqlite-worker.bundle.js');
}

export class SQLiteDatabaseProxy {
  private worker: Worker | null = null;
  private pending = new Map<string, PendingRequest>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private opts: SQLiteDatabaseProxyOptions;
  /**
   * Per the PGLite worker pattern: the backup service is wired on the worker
   * side at init. The setBackupService() method exists for API parity with
   * SQLiteDatabase but is a no-op — the worker constructs SQLiteBackupService
   * during `init` because that service needs the raw handle.
   */
  private backupServiceFacade: AppDatabaseBackupService;
  private pgliteReader: LivePgliteReader | null = null;
  private migrationControl: MigrationControlHandler | null = null;

  constructor(opts: SQLiteDatabaseProxyOptions) {
    this.opts = opts;
    this.backupServiceFacade = this.makeBackupFacade();
  }

  /**
   * Inject the live PGLite reader the worker uses to pull source rows during
   * migration. Must be set before calling `startMigration` / `startDryRun` /
   * `adoptDryRun`; preflight and dryRunStatus tolerate it being unset.
   */
  setPgliteReader(reader: LivePgliteReader): void {
    this.pgliteReader = reader;
  }

  /** Inject the control handler used for `closePglite` / cutover hooks. */
  setMigrationControl(handler: MigrationControlHandler): void {
    this.migrationControl = handler;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Spawn the worker without sending `init`. Used by migration callers that
   * need the worker thread for the orchestrator/dry-runner/adopter but don't
   * want to open the live SQLite handle yet (or ever, when PGLite is still
   * the active backend).
   */
  ensureWorkerSpawned(): void {
    if (!this.worker) this.createWorker();
  }

  private async doInitialize(): Promise<void> {
    this.ensureWorkerSpawned();
    const payload: InitPayload = {
      dbDir: this.opts.dbDir,
      schemaDir: this.opts.schemaDir,
      slowQueryThresholdMs: this.opts.slowQueryThresholdMs,
      sampleRate: this.opts.sampleRate,
    };
    await this.send('init', payload, 120_000);
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.worker) {
      try {
        await this.send('close', undefined, 30_000);
      } catch (err) {
        logger.main.warn('[SQLiteProxy] close request failed', err);
      }
      try {
        await this.worker.terminate();
      } catch {
        /* ignore */
      }
      this.worker = null;
    }
    // Fail any in-flight pending requests so callers don't hang.
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error('SQLiteDatabaseProxy closed'));
    }
    this.pending.clear();
    this.initialized = false;
    this.initPromise = null;
  }

  // --------------------------------------------------------------------------
  // Query surface (parity with SQLiteDatabase)
  // --------------------------------------------------------------------------

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return (await this.send('query', { sql, params })) as QueryResult<T>;
  }

  async queryReadOnly<T = unknown>(
    sql: string,
    params: unknown[] = [],
    timeoutMs?: number,
  ): Promise<QueryResult<T>> {
    // Bound the timeout aggressively on the main side so an inflight callback
    // can't outlast a sensible UI window. Worker enforces its own timeout via
    // `db.interrupt()` for the actual statement.
    const requestTimeout = (timeoutMs ?? 5000) + 5000;
    return (await this.send(
      'queryReadOnly',
      { sql, params, timeoutMs },
      requestTimeout,
    )) as QueryResult<T>;
  }

  async exec(sql: string): Promise<void> {
    await this.send('exec', { sql });
  }

  runTransaction<T = unknown>(
    statements: TransactionPayload['statements'],
  ): Promise<Array<QueryResult<T>>>;
  runTransaction(
    statements: Array<{ sql: string; params?: unknown[] }>,
  ): Promise<void>;
  async runTransaction<T = unknown>(
    statements: TransactionPayload['statements'],
  ): Promise<Array<QueryResult<T>> | void> {
    return (await this.send('transaction', { statements })) as Array<QueryResult<T>>;
  }

  async getStats(): Promise<unknown> {
    return this.send('getStats');
  }

  async verifyBackup(backupPath: string): Promise<{
    valid: boolean;
    error?: string;
    hasData?: boolean;
    sessionCount?: number;
    historyCount?: number;
  }> {
    return (await this.send('verifyBackup', { backupPath })) as {
      valid: boolean;
      error?: string;
      hasData?: boolean;
      sessionCount?: number;
      historyCount?: number;
    };
  }

  async createBackup(): Promise<{ success: boolean; error?: string }> {
    return (await this.send('createBackup')) as { success: boolean; error?: string };
  }

  /** Read-side backup status (returns null when no backup has run yet). */
  async getBackupStatusAsync(): Promise<unknown> {
    return this.send('getBackupStatus');
  }

  /** Parity with SQLiteDatabase; on the proxy the backup service lives in the worker. */
  setBackupService(_svc: AppDatabaseBackupService): void {
    // Intentional no-op. See backupServiceFacade for the read-side façade.
  }

  getBackupService(): AppDatabaseBackupService {
    return this.backupServiceFacade;
  }

  /** Mirrors `SQLiteDatabase.getDB()` so `AppDatabase`-typed callers compile. */
  getDB(): {
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>;
    exec: (sql: string) => Promise<void>;
  } {
    if (!this.initialized) {
      throw new Error('SQLiteDatabaseProxy not initialized. Call initialize() first.');
    }
    return {
      query: <T = unknown>(sql: string, params?: unknown[]) => this.query<T>(sql, params ?? []),
      exec: (sql: string) => this.exec(sql),
    };
  }

  // --------------------------------------------------------------------------
  // Dashboard / performance helpers (replace previous getRawHandle uses)
  // --------------------------------------------------------------------------

  async pragmaRead(name: string): Promise<unknown> {
    const r = (await this.send('pragmaRead', { name })) as { value: unknown };
    return r.value;
  }

  async dashboardTableStats(): Promise<unknown> {
    return this.send('dashboardTableStats');
  }

  async getSlowQueries(limit = 50): Promise<unknown[]> {
    return (await this.send('getSlowQueries', { limit })) as unknown[];
  }

  async getPerformance(slowLimit = 50): Promise<{ snapshot: unknown; slowQueries: unknown[] }> {
    return (await this.send('getPerformance', { slowLimit })) as {
      snapshot: unknown;
      slowQueries: unknown[];
    };
  }

  async walCheckpoint(): Promise<unknown> {
    return this.send('walCheckpoint');
  }

  // --------------------------------------------------------------------------
  // Migration surface — drives MigrationOrchestrator / MigrationDryRunner /
  // MigrationAdopter inside the worker. Progress events are fanned out to
  // BrowserWindows on the existing `db:migration:*` channels via the
  // event-handling block in createWorker().
  // --------------------------------------------------------------------------

  async migrationPreflight(args: {
    userDataPath: string;
    schemaDir: string;
  }): Promise<MigrationPreflightResult> {
    this.ensureWorkerSpawned();
    return (await this.send('migrationPreflight', args, 60_000)) as MigrationPreflightResult;
  }

  async startMigration(args: {
    userDataPath: string;
    schemaDir: string;
  }): Promise<{ summary: MigrationSummary }> {
    this.ensureWorkerSpawned();
    // Migration can take a very long time on large DBs; bound generously.
    // Worker side guards against concurrent starts.
    return (await this.send('migrationStart', args, 60 * 60 * 1000)) as {
      summary: MigrationSummary;
    };
  }

  async startDryRun(args: {
    userDataPath: string;
    schemaDir: string;
  }): Promise<{ result: DryRunResult }> {
    this.ensureWorkerSpawned();
    return (await this.send('migrationStartDryRun', args, 60 * 60 * 1000)) as {
      result: DryRunResult;
    };
  }

  async dryRunStatus(args: {
    userDataPath: string;
    schemaDir: string;
  }): Promise<DryRunStatusResult> {
    this.ensureWorkerSpawned();
    return (await this.send('migrationDryRunStatus', args, 30_000)) as DryRunStatusResult;
  }

  async adoptDryRun(args: {
    userDataPath: string;
    schemaDir: string;
  }): Promise<{ result: AdoptResult }> {
    this.ensureWorkerSpawned();
    return (await this.send('migrationAdoptDryRun', args, 60 * 60 * 1000)) as {
      result: AdoptResult;
    };
  }

  async rollback(args: { userDataPath: string }): Promise<{ restoredFrom: string }> {
    this.ensureWorkerSpawned();
    return (await this.send('migrationRollback', args, 60_000)) as { restoredFrom: string };
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private createWorker(): void {
    const workerPath = resolveWorkerPath();
    logger.main.info('[SQLiteProxy] spawning worker', { workerPath, dbDir: this.opts.dbDir });
    this.worker = new Worker(workerPath);

    this.worker.on(
      'message',
      (
        msg:
          | ResponseEnvelope
          | { event: string; payload: unknown }
          | { event: string; bridgeId: string; payload: unknown },
      ) => {
        if ('event' in msg) {
          this.handleWorkerEvent(msg as { event: string; bridgeId?: string; payload: unknown });
          return;
        }
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (msg.success) {
          pending.resolve(msg.data);
        } else {
          const err = new Error(msg.error.message);
          if (msg.error.name) err.name = msg.error.name;
          if (msg.error.stack) err.stack = msg.error.stack;
          if (msg.error.code) (err as { code?: string }).code = msg.error.code;
          pending.reject(err);
        }
      },
    );

    this.worker.on('error', (err) => {
      logger.main.error('[SQLiteProxy] worker error', err);
      for (const [, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    });

    this.worker.on('exit', (code) => {
      if (code !== 0) {
        logger.main.warn('[SQLiteProxy] worker exited with code', code);
      }
      for (const [, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error(`SQLite worker exited (code ${code})`));
      }
      this.pending.clear();
      this.worker = null;
      this.initialized = false;
    });
  }

  private send(
    type: WorkerRequestType,
    payload?: unknown,
    timeoutMs = this.opts.requestTimeoutMs ?? 60_000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error('SQLite worker not running'));
        return;
      }
      const id = uuidv4();
      // Bus-drop guard. Worker may also enforce its own timeout (queryReadOnly
      // calls db.interrupt() when its bounded timer fires), so this is mostly
      // a safety net for "the worker thread died without exit". The timer is
      // cleared inline by the response handler — without that, every query
      // leaks a 60s timer into the wheel and CPU saturates under streaming
      // load.
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`SQLite worker request '${type}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, payload });
    });
  }

  /**
   * Route an event-shaped message from the worker.
   * Branches:
   *   - `log`: forward to the main-process logger.
   *   - `db:migration:*`: fan out to BrowserWindows on the matching IPC
   *     channel so the renderer sees the same payload it always has.
   *   - `db:migration:cutoverSuccess`: invoke the registered control hook and
   *     persist the backend flag (the worker side already renamed pglite-db/
   *     and ran the data copy).
   *   - `pgliteReadRequest`: run the SQL against the injected PGLite reader
   *     and post a `bridgeResponse` back to the worker.
   *   - `workerControlRequest`: run the requested action (e.g. close PGLite)
   *     via the injected control handler and post a `bridgeResponse` back.
   */
  private handleWorkerEvent(msg: {
    event: string;
    bridgeId?: string;
    payload: unknown;
  }): void {
    if (msg.event === 'log') {
      const { level, msg: line, meta } = msg.payload as {
        level: 'info' | 'warn' | 'error';
        msg: string;
        meta?: unknown;
      };
      if (level === 'error') logger.main.error(line, meta);
      else if (level === 'warn') logger.main.warn(line, meta);
      else logger.main.info(line, meta);
      return;
    }
    if (
      msg.event === 'db:migration:phase'
      || msg.event === 'db:migration:progress'
      || msg.event === 'db:migration:complete'
      || msg.event === 'db:migration:failed'
    ) {
      this.broadcastToWindows(msg.event, msg.payload);
      return;
    }
    if (msg.event === 'db:migration:cutoverSuccess') {
      const info = msg.payload as { sqliteDir: string; pgliteMigratedDir: string };
      const hook = this.migrationControl?.onCutoverSuccess;
      if (hook) {
        Promise.resolve(hook(info)).catch((err) =>
          logger.main.warn('[SQLiteProxy] onCutoverSuccess hook threw', err),
        );
      }
      return;
    }
    if (msg.event === 'pgliteReadRequest') {
      if (!msg.bridgeId) return;
      const bridgeId = msg.bridgeId;
      const p = msg.payload as PgliteReadRequestPayload;
      const reader = this.pgliteReader;
      if (!reader) {
        this.respondToBridge(bridgeId, false, undefined, {
          message: 'No PGLite reader registered on SQLiteDatabaseProxy',
        });
        return;
      }
      reader
        .queryReadOnly(p.sql, p.params, p.timeoutMs)
        .then((result) => this.respondToBridge(bridgeId, true, result))
        .catch((err) =>
          this.respondToBridge(bridgeId, false, undefined, serializeBridgeError(err)),
        );
      return;
    }
    if (msg.event === 'workerControlRequest') {
      if (!msg.bridgeId) return;
      const bridgeId = msg.bridgeId;
      const p = msg.payload as WorkerControlRequestPayload;
      const handler = this.migrationControl;
      if (!handler) {
        this.respondToBridge(bridgeId, false, undefined, {
          message: 'No migration control handler registered on SQLiteDatabaseProxy',
        });
        return;
      }
      if (p.action === 'closePglite') {
        handler
          .closePglite()
          .then(() => this.respondToBridge(bridgeId, true, { ok: true }))
          .catch((err) =>
            this.respondToBridge(bridgeId, false, undefined, serializeBridgeError(err)),
          );
      } else {
        this.respondToBridge(bridgeId, false, undefined, {
          message: `Unknown worker control action: ${String(p.action)}`,
        });
      }
      return;
    }
  }

  /** Post a bridge response back to the worker. */
  private respondToBridge(
    bridgeId: string,
    success: boolean,
    data?: unknown,
    error?: SerializedError,
  ): void {
    if (!this.worker) return;
    this.worker.postMessage({ bridgeResponse: true, bridgeId, success, data, error });
  }

  /** Fan out to every live BrowserWindow. */
  private broadcastToWindows(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(channel, payload);
      } catch {
        // Window may have closed between the isDestroyed check and the send.
      }
    }
  }

  /**
   * Read-only façade over the worker-hosted backup service. Anything that
   * needs to mutate backup state (rotate, restore, cleanup) must add a
   * worker request — those code paths are intentionally narrow.
   */
  private makeBackupFacade(): AppDatabaseBackupService {
    const self = this;
    return {
      async initialize() {
        // No-op; the worker initializes backup during 'init'.
      },
      async createBackup() {
        return self.createBackup();
      },
      async restoreFromBackup() {
        // Restore needs a multi-step dance: close worker → swap files →
        // re-open. Not currently driven from main; we wire it when the
        // restore UI is brought back. Keeping the surface async so callers
        // continue to compile.
        return { success: false, error: 'Restore-from-backup not yet wired through worker.' };
      },
      hasBackups() {
        // Best-effort. Backup metadata lives in the worker, but the file
        // presence check we used historically only needs the directory.
        return false;
      },
      getBackupStatus() {
        // Synchronous accessor that callers (dashboard) hit per refresh. We
        // return null here; the renderer should fetch the status async via
        // the dashboardTableStats response which the worker bundles.
        return null;
      },
      async cleanupOldCorruptedBackups() {
        await self.send('cleanupBackups');
      },
    } as unknown as AppDatabaseBackupService;
  }
}
