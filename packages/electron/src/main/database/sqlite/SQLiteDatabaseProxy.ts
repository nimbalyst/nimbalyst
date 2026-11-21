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
 * Worker lifecycle: a single Worker is spawned by `initialize()`. `close()`
 * shuts it down. If the live worker dies unexpectedly (GitHub #1988: an
 * `ERR_WORKER_OUT_OF_MEMORY` exit left every database call failing until the
 * app restarted), the proxy respawns and re-inits it with capped backoff; see
 * `startRecovery`. Each `query/exec/etc.` call
 * issues a uuid-keyed request; the response handler resolves the matching
 * promise. Errors crossing the boundary are reconstructed into real Errors
 * so try/catch in callers behaves the same as before.
 */

import { serializeBridgeError } from './worker/migrationReadBridge';
import type { CutoverVerification } from './cutoverVerification';
import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDatabaseMaintenanceSettings } from '../../utils/store';
import { app, BrowserWindow } from 'electron';
import { observeMigrationProgress } from '../migrationOperation';
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
  StartMigrationPayload,
  AdoptDryRunPayload,
  DryRunStatusResult,
  PgliteReadRequestPayload,
  WorkerControlRequestPayload,
} from './worker/workerProtocol';
import type { MigrationSummary } from './PGLiteToSQLiteMigrator';
import type { DryRunResult } from './MigrationDryRunner';
import type { AdoptResult } from './MigrationAdopter';
import { emitMigrationOutcome } from './migrationEventMapper';
import { MIGRATION_OUTCOME_EVENT, type MigrationOutcome } from './migrationOutcome';

/**
 * Read surface satisfied by the live PGLite worker. The proxy hands every
 * `pgliteReadRequest` event from the SQLite worker to this callback so the
 * migration pipeline running inside the SQLite worker can pull rows from
 * PGLite (which lives in a different worker_threads thread).
 */
export interface LivePgliteReader {
  assertAvailable?: () => void;
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

/**
 * Transport outcome codes set on `err.code` for requests that fail in the
 * proxy rather than in SQL. `AgentMessageWriteQueue` (runtime package) keys
 * its retain-or-reject decision on these exact strings, so keep them in sync
 * with `DB_REQUEST_NOT_SUBMITTED` / `DB_REQUEST_OUTCOME_UNKNOWN` there.
 *
 * - NOT_SUBMITTED: the request was never posted to a worker. It cannot have
 *   touched the database, so a caller may safely retry it.
 * - OUTCOME_UNKNOWN: the request was posted and its reply was lost (worker
 *   error, exit, or proxy timeout). The worker may have committed it; a
 *   timeout does not cancel worker execution. Never blindly replay.
 */
export const DB_REQUEST_NOT_SUBMITTED = 'DB_REQUEST_NOT_SUBMITTED';
export const DB_REQUEST_OUTCOME_UNKNOWN = 'DB_REQUEST_OUTCOME_UNKNOWN';

function transportError(message: string, code: string, cause?: unknown): Error {
  const err = new Error(message) as Error & { code?: string; cause?: unknown };
  err.code = code;
  if (cause !== undefined) err.cause = cause;
  return err;
}

/** Delays before each respawn attempt after an unexpected worker exit. */
const RECOVERY_BACKOFF_MS = [250, 1_000, 4_000, 15_000, 30_000];
/** Crash-recoveries allowed inside CRASH_WINDOW_MS before the proxy gives up. */
const MAX_CRASHES_IN_WINDOW = 5;
const CRASH_WINDOW_MS = 10 * 60_000;
/** After recovery is exhausted, explicit `initialize()` may retry this often. */
const MANUAL_RETRY_INTERVAL_MS = 60_000;
/** How long recovery waits for a worker that errored to actually exit. */
const EXIT_WAIT_MS = 5_000;

interface PendingRequest {
  /** Worker generation the request was posted to. */
  generation: number;
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


/**
 * Backup requests copy and scan the whole database, so their duration scales
 * with the store, not with a UI expectation: a 6.3 GB database takes ~44s for
 * the online copy alone. Under the default 60s request timeout the proxy gave
 * up, dropped the pending entry, and discarded the success response that
 * arrived later — so a backup that in fact completed was logged as failed and
 * never recorded in backup health. This ceiling is a bus-drop guard only.
 */
const BACKUP_REQUEST_TIMEOUT_MS = 30 * 60_000;

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
   * Incremented per spawned worker. Every event handler and pending entry is
   * tagged with it, so a late `exit`/`message` from a dead worker cannot
   * reject or resolve requests that belong to its replacement.
   */
  private generation = 0;
  /** Resolves when the current generation's worker emits `exit`. */
  private workerExited: Promise<void> = Promise.resolve();
  /**
   * True once `init` succeeded on this proxy. Only a proxy that was serving
   * the live database respawns; migration-only proxies (spawned through
   * `ensureWorkerSpawned()` without `init`) never open the live store as a
   * side effect of a crash.
   */
  private liveRole = false;
  private closing = false;
  private recoveryPromise: Promise<void> | null = null;
  private cancelRecoveryDelay: (() => void) | null = null;
  private crashTimes: number[] = [];
  private recoveryExhaustedAt: number | null = null;
  /** Latest heap sample posted by the worker; logged when it dies. */
  private lastHeapSample: unknown = null;
  /**
   * Per the PGLite worker pattern: the backup service is wired on the worker
   * side at init. The setBackupService() method exists for API parity with
   * SQLiteDatabase but is a no-op — the worker constructs SQLiteBackupService
   * during `init` because that service needs the raw handle.
   */
  private backupServiceFacade: AppDatabaseBackupService;
  private pgliteReader: LivePgliteReader | null = null;
  private migrationControl: MigrationControlHandler | null = null;
  private migrationObserver: ((event: string, payload: unknown) => void) | null = null;

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

  /**
   * Observe migration progress on the main process. Used by the boot-time
   * forced migration to drive the splash screen; the renderer path uses the
   * IPC broadcast instead.
   */
  setMigrationObserver(observer: (event: string, payload: unknown) => void): void {
    this.migrationObserver = observer;
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
    if (this.recoveryPromise) return this.recoveryPromise;
    if (this.initPromise) return this.initPromise;
    if (this.recoveryExhaustedAt !== null) {
      // Readiness callers (RepositoryManager's `ensureReady`) call this on
      // every write. After automatic recovery gave up, let them retry, but not
      // as a respawn per message.
      if (Date.now() - this.recoveryExhaustedAt < MANUAL_RETRY_INTERVAL_MS) {
        throw transportError(
          'SQLite worker is unavailable after repeated crashes',
          DB_REQUEST_NOT_SUBMITTED,
        );
      }
      if (!this.liveStoreExists()) {
        this.recoveryExhaustedAt = Date.now();
        throw transportError(
          `SQLite worker restart refused: ${this.liveStorePath()} is missing`,
          DB_REQUEST_NOT_SUBMITTED,
        );
      }
      this.recoveryExhaustedAt = null;
      this.crashTimes = [];
    }
    const p = this.doInitialize();
    this.initPromise = p;
    // A failed init must not be cached forever; the next caller retries.
    p.catch(() => {
      if (this.initPromise === p) this.initPromise = null;
    });
    return p;
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
    // backupCopiesKept is resolved here rather than in the worker:
    // electron-store needs the `electron` module, which a worker bundle
    // cannot resolve.
    await this.send('init', this.initPayload(), 120_000);
    this.initialized = true;
    this.liveRole = true;
  }

  private initPayload(): InitPayload {
    return {
      dbDir: this.opts.dbDir,
      schemaDir: this.opts.schemaDir,
      slowQueryThresholdMs: this.opts.slowQueryThresholdMs,
      sampleRate: this.opts.sampleRate,
      backupCopiesKept: getDatabaseMaintenanceSettings().backupCopiesKept,
    };
  }

  private liveStorePath(): string {
    return path.join(this.opts.dbDir, 'nimbalyst.sqlite');
  }

  private liveStoreExists(): boolean {
    try {
      return fs.existsSync(this.liveStorePath());
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // Fence recovery first: an explicit close must never be followed by a
    // respawn, and a recovery in its backoff delay must stop now.
    this.closing = true;
    this.liveRole = false;
    this.cancelRecoveryDelay?.();
    if (this.recoveryPromise) {
      // A recovery worker may be stuck in `init`. Terminate it rather than
      // wait out the 120s init timeout; the exit rejects that init and the
      // recovery loop sees `closing` and stops.
      const recovering = this.worker;
      if (recovering) {
        try { await recovering.terminate(); } catch { /* already gone */ }
      }
      await this.recoveryPromise.catch(() => {});
    }
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
      p.reject(transportError('SQLiteDatabaseProxy closed', DB_REQUEST_OUTCOME_UNKNOWN));
    }
    this.pending.clear();
    this.initialized = false;
    this.initPromise = null;
    this.recoveryExhaustedAt = null;
    this.crashTimes = [];
    this.closing = false;
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

  async runTransaction(statements: Array<{ sql: string; params?: unknown[]; expectedRows?: number }>): Promise<void> {
    await this.send('transaction', { statements });
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
    return (await this.send('verifyBackup', { backupPath }, BACKUP_REQUEST_TIMEOUT_MS)) as {
      valid: boolean;
      error?: string;
      hasData?: boolean;
      sessionCount?: number;
      historyCount?: number;
    };
  }

  async createBackup(): Promise<{ success: boolean; error?: string }> {
    return (await this.send(
      'createBackup',
      undefined,
      BACKUP_REQUEST_TIMEOUT_MS,
    )) as { success: boolean; error?: string };
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

  /** Apply a new backup-retention setting to the live service. */
  async setBackupCopiesKept(copiesKept: number): Promise<void> {
    await this.send('setBackupCopiesKept', { copiesKept });
  }

  /**
   * Estimate what the tool-output retention pass would reclaim, from a bounded
   * sample. Cheap enough for a confirmation prompt.
   */
  async toolRetentionEstimate(retentionDays: number): Promise<{
    sampledRows: number;
    sampleBytesSaved: number;
    candidateRows: number;
    estimatedBytesSaved: number;
  }> {
    return (await this.send('toolRetentionEstimate', { retentionDays })) as {
      sampledRows: number;
      sampleBytesSaved: number;
      candidateRows: number;
      estimatedBytesSaved: number;
    };
  }

  /**
   * Run the retention pass. Executes on the worker's background lane, so the
   * app stays responsive while it works.
   */
  async toolRetentionRun(retentionDays: number, maxRows?: number, startAfterId?: number): Promise<unknown> {
    return this.send('toolRetentionRun', { retentionDays, maxRows, startAfterId });
  }

  /**
   * Delete raw rows that render nothing, and collapse duplicate session/init
   * frames. Separate from `toolRetentionRun` because it removes rows rather
   * than rewriting payloads; see `createRawMessagePruneWork`.
   */
  async rawMessagePruneRun(
    retentionDays: number,
    maxRows?: number,
    ignoreAge?: boolean,
  ): Promise<unknown> {
    return this.send('rawMessagePruneRun', { retentionDays, maxRows, ignoreAge });
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

  async startMigration(args: StartMigrationPayload): Promise<{ summary: MigrationSummary }> {
    this.ensureWorkerSpawned();
    // Migration can take a very long time on large DBs; bound generously.
    // Worker side guards against concurrent starts.
    this.pgliteReader?.assertAvailable?.();
    return (await this.send('migrationStart', args, 60 * 60 * 1000)) as {
      summary: MigrationSummary;
    };
  }

  async startDryRun(args: {
    cancellation?: SharedArrayBuffer;
    userDataPath: string;
    schemaDir: string;
  }): Promise<{ result: DryRunResult }> {
    this.ensureWorkerSpawned();
    this.pgliteReader?.assertAvailable?.();
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

  async adoptDryRun(args: AdoptDryRunPayload): Promise<{ result: AdoptResult }> {
    this.ensureWorkerSpawned();
    this.pgliteReader?.assertAvailable?.();
    return (await this.send('migrationAdoptDryRun', args, 60 * 60 * 1000)) as {
      result: AdoptResult;
    };
  }

  async verifyCutover(receipt?: CutoverVerification): Promise<void> {
    await this.send('verifyCutover', { receipt }, 120_000);
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private createWorker(): void {
    const workerPath = resolveWorkerPath();
    logger.main.info('[SQLiteProxy] spawning worker', { workerPath, dbDir: this.opts.dbDir });
    const gen = ++this.generation;
    const worker = new Worker(workerPath);
    this.worker = worker;
    let markExited!: () => void;
    this.workerExited = new Promise<void>((resolve) => { markExited = resolve; });
    this.lastHeapSample = null;

    worker.on(
      'message',
      (
        msg:
          | ResponseEnvelope
          | { event: string; payload: unknown }
          | { event: string; bridgeId: string; payload: unknown },
      ) => {
        if (gen !== this.generation) return;
        if ('event' in msg) {
          this.handleWorkerEvent(msg as { event: string; bridgeId?: string; payload: unknown }, gen);
          return;
        }
        const pending = this.pending.get(msg.id);
        if (!pending || pending.generation !== gen) return;
        this.pending.delete(msg.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (msg.success) {
          pending.resolve(msg.data);
        } else {
          const err = new Error(msg.error.message);
          if (msg.error.name) err.name = msg.error.name;
          if (msg.error.stack) err.stack = msg.error.stack;
          if (msg.error.code) (err as { code?: string }).code = msg.error.code;
          // Carries `MigrationRefusedError`'s structured verdict across the
          // thread hop; without it a refusal arrives as an ordinary Error and
          // the boot path counts it as a failed attempt.
          if (msg.error.data !== undefined) (err as { data?: unknown }).data = msg.error.data;
          pending.reject(err);
        }
      },
    );

    worker.on('error', (err) => {
      logger.main.error('[SQLiteProxy] worker error', err);
      this.rejectPendingFor(
        gen,
        transportError(`SQLite worker error: ${err?.message ?? String(err)}`, DB_REQUEST_OUTCOME_UNKNOWN, err),
      );
      if (gen !== this.generation) return;
      // Stop admission now; `exit` follows. Recovery waits for that exit so
      // two threads never hold the database file open at once.
      this.worker = null;
      this.initialized = false;
      this.initPromise = null;
      this.onUnexpectedWorkerLoss(`error: ${err?.message ?? String(err)}`);
    });

    worker.on('exit', (code) => {
      markExited();
      this.rejectPendingFor(
        gen,
        transportError(`SQLite worker exited (code ${code})`, DB_REQUEST_OUTCOME_UNKNOWN),
      );
      if (gen !== this.generation) return;
      if (code !== 0 || (this.liveRole && !this.closing)) {
        logger.main.warn('[SQLiteProxy] worker exited with code', code, {
          generation: gen,
          lastHeapSample: this.lastHeapSample,
        });
      }
      this.worker = null;
      this.initialized = false;
      this.initPromise = null;
      // Exit code 0 is unexpected too: the live worker never exits on its own.
      this.onUnexpectedWorkerLoss(`exit code ${code}`);
    });
  }

  /** Reject every pending request posted to generation `gen`, exactly once. */
  private rejectPendingFor(gen: number, err: Error): void {
    for (const [id, p] of this.pending) {
      if (p.generation !== gen) continue;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
  }

  private onUnexpectedWorkerLoss(reason: string): void {
    if (!this.liveRole || this.closing) return;
    this.startRecovery(reason);
  }

  /**
   * Respawn and re-init the live worker after it died. Idempotent while a
   * recovery is running. Requests that arrive meanwhile wait in `send()`.
   *
   * Never creates a store: if `nimbalyst.sqlite` is gone, recovery refuses
   * rather than opening an empty database on top of whatever moved it
   * (restore, rollback, or the user). Never switches backend, restores a
   * backup, or reruns bootstrap.
   */
  private startRecovery(reason: string): void {
    if (this.recoveryPromise || this.closing) return;
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
    this.crashTimes.push(now);
    if (this.crashTimes.length > MAX_CRASHES_IN_WINDOW) {
      this.recoveryExhaustedAt = now;
      logger.main.error('[SQLiteProxy] worker crashed too often; automatic restart stopped', {
        crashes: this.crashTimes.length,
        windowMs: CRASH_WINDOW_MS,
        reason,
      });
      return;
    }
    logger.main.warn('[SQLiteProxy] live worker lost; starting recovery', {
      reason,
      crashesInWindow: this.crashTimes.length,
    });
    const exited = this.workerExited;
    const p = this.runRecovery(exited).then(
      () => {
        logger.main.info('[SQLiteProxy] live worker recovered', { generation: this.generation });
      },
      (err) => {
        if (!this.closing) {
          this.recoveryExhaustedAt = Date.now();
          logger.main.error('[SQLiteProxy] live worker recovery failed', err);
        }
        throw err;
      },
    ).finally(() => {
      if (this.recoveryPromise === p) this.recoveryPromise = null;
      this.cancelRecoveryDelay = null;
    });
    this.recoveryPromise = p;
    p.catch(() => {});
  }

  private async runRecovery(previousExit: Promise<void>): Promise<void> {
    await Promise.race([previousExit, this.delay(EXIT_WAIT_MS)]);
    for (let attempt = 0; attempt < RECOVERY_BACKOFF_MS.length; attempt++) {
      await this.delay(RECOVERY_BACKOFF_MS[attempt]);
      if (this.closing) throw transportError('SQLiteDatabaseProxy closed during recovery', DB_REQUEST_NOT_SUBMITTED);
      if (!this.liveStoreExists()) {
        throw transportError(
          `SQLite worker restart refused: ${this.liveStorePath()} is missing`,
          DB_REQUEST_NOT_SUBMITTED,
        );
      }
      try {
        this.createWorker();
        const worker = this.worker;
        await this.post('init', this.initPayload(), 120_000);
        if (this.closing) {
          throw transportError('SQLiteDatabaseProxy closed during recovery', DB_REQUEST_NOT_SUBMITTED);
        }
        if (this.worker !== worker) {
          // The new worker answered `init` and died before this ran: with main
          // busy, an out-of-memory death delivers the answer, `error` and
          // `exit` in one callback. Its exit could not start a recovery while
          // this one runs, so this attempt failed.
          throw new Error('SQLite worker died right after answering recovery init');
        }
        this.initialized = true;
        return;
      } catch (err) {
        logger.main.warn('[SQLiteProxy] recovery attempt failed', { attempt: attempt + 1, err });
        const w = this.worker;
        this.worker = null;
        if (w) {
          try { await w.terminate(); } catch { /* already gone */ }
        }
        if (this.closing) throw err;
      }
    }
    throw transportError(
      `SQLite worker recovery failed after ${RECOVERY_BACKOFF_MS.length} attempts`,
      DB_REQUEST_NOT_SUBMITTED,
    );
  }

  /** Cancellable delay; `close()` resolves it early through cancelRecoveryDelay. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      if (typeof timer.unref === 'function') timer.unref();
      const prevCancel = this.cancelRecoveryDelay;
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.cancelRecoveryDelay = () => {
        done();
        prevCancel?.();
      };
    });
  }

  private send(
    type: WorkerRequestType,
    payload?: unknown,
    timeoutMs = this.opts.requestTimeoutMs ?? 60_000,
  ): Promise<unknown> {
    if (this.recoveryPromise) {
      // The live worker is being replaced. Hold the request until the new
      // worker is ready instead of failing it; nothing has been posted yet,
      // so a failure here is NOT_SUBMITTED and safe for the caller to retry.
      const recovery = this.recoveryPromise;
      return new Promise((resolve, reject) => {
        // Once this request is rejected as NOT_SUBMITTED the caller may retry
        // it, so it must never be posted afterwards or the write runs twice.
        let abandoned = false;
        const timer = setTimeout(() => {
          abandoned = true;
          reject(transportError(
            `SQLite worker request '${type}' not sent: recovery still running after ${timeoutMs}ms`,
            DB_REQUEST_NOT_SUBMITTED,
          ));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        recovery.then(
          () => {
            clearTimeout(timer);
            if (abandoned) return;
            this.send(type, payload, timeoutMs).then(resolve, reject);
          },
          (err) => {
            clearTimeout(timer);
            if (abandoned) return;
            reject(transportError(
              `SQLite worker request '${type}' not sent: worker recovery failed`,
              DB_REQUEST_NOT_SUBMITTED,
              err,
            ));
          },
        );
      });
    }
    return this.post(type, payload, timeoutMs);
  }

  /** Post directly to the current worker, bypassing the recovery gate. */
  private post(
    type: WorkerRequestType,
    payload?: unknown,
    timeoutMs = this.opts.requestTimeoutMs ?? 60_000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(transportError('SQLite worker not running', DB_REQUEST_NOT_SUBMITTED));
        return;
      }
      const id = uuidv4();
      const generation = this.generation;
      // Bus-drop guard. Worker may also enforce its own timeout (queryReadOnly
      // calls db.interrupt() when its bounded timer fires), so this is mostly
      // a safety net for "the worker thread died without exit". The timer is
      // cleared inline by the response handler — without that, every query
      // leaks a 60s timer into the wheel and CPU saturates under streaming
      // load.
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          // A UI deadline must not release ownership while the worker is
          // still copying or renaming. These operations settle on reply/exit.
          if (['migrationStart', 'migrationStartDryRun', 'migrationAdoptDryRun'].includes(type)) return;
          this.pending.delete(id);
          // The worker keeps executing a timed-out request; it may commit.
          reject(transportError(
            `SQLite worker request '${type}' timed out after ${timeoutMs}ms`,
            DB_REQUEST_OUTCOME_UNKNOWN,
          ));
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { generation, resolve, reject, timer });
      worker.postMessage({ id, type, payload });
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
  private handleWorkerEvent(
    msg: {
      event: string;
      bridgeId?: string;
      payload: unknown;
    },
    gen: number = this.generation,
  ): void {
    if (msg.event === 'heapSample') {
      this.lastHeapSample = msg.payload;
      return;
    }
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
      observeMigrationProgress(msg.event, msg.payload);
      // Main-side observer. The boot-time forced migration drives the splash
      // screen, which is a plain data-URL BrowserWindow with no preload — it
      // cannot receive an ipcRenderer message, so the broadcast above never
      // reaches it.
      if (this.migrationObserver) {
        try {
          this.migrationObserver(msg.event, msg.payload);
        } catch (err) {
          logger.main.warn('[SQLiteProxy] migration observer threw', err);
        }
      }
      return;
    }
    if (msg.event === MIGRATION_OUTCOME_EVENT) {
      // The single point at which a migration becomes analytics. The worker
      // returns a typed result and never names an event; the mapper decides
      // what is emitted and guarantees one terminal event per operation.
      emitMigrationOutcome(msg.payload as MigrationOutcome);
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
        this.respondToBridge(gen, bridgeId, false, undefined, {
          message: 'No PGLite reader registered on SQLiteDatabaseProxy',
        });
        return;
      }
      reader
        .queryReadOnly(p.sql, p.params, p.timeoutMs)
        .then((result) => this.respondToBridge(gen, bridgeId, true, result))
        .catch((err) =>
          this.respondToBridge(gen, bridgeId, false, undefined, serializeBridgeError(err)),
        );
      return;
    }
    if (msg.event === 'workerControlRequest') {
      if (!msg.bridgeId) return;
      const bridgeId = msg.bridgeId;
      const p = msg.payload as WorkerControlRequestPayload;
      const handler = this.migrationControl;
      if (!handler) {
        this.respondToBridge(gen, bridgeId, false, undefined, {
          message: 'No migration control handler registered on SQLiteDatabaseProxy',
        });
        return;
      }
      if (p.action === 'closePglite') {
        handler
          .closePglite()
          .then(() => this.respondToBridge(gen, bridgeId, true, { ok: true }))
          .catch((err) =>
            this.respondToBridge(gen, bridgeId, false, undefined, serializeBridgeError(err)),
          );
      } else {
        this.respondToBridge(gen, bridgeId, false, undefined, {
          message: `Unknown worker control action: ${String(p.action)}`,
        });
      }
      return;
    }
  }

  /** Post a bridge response back to the worker. */
  private respondToBridge(
    gen: number,
    bridgeId: string,
    success: boolean,
    data?: unknown,
    error?: SerializedError,
  ): void {
    // A bridge answer for a dead worker must not reach its replacement.
    if (!this.worker || gen !== this.generation) return;
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
   * Façade over the worker-hosted backup service. Every mutating operation is
   * an explicit worker request — those code paths are intentionally narrow.
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
        // The whole restore -- close, stage, verify, swap, reopen -- happens
        // inside the worker, because the live `SQLiteDatabase` the recovery
        // transaction has to close and reopen only exists there. This used to
        // return "not yet wired", which meant `SQLiteBackupService.restoreFromBackup()`
        // was implemented, tested, and unreachable from a shipped build: a
        // SQLite install with three healthy rolling backups had no path to any
        // of them.
        //
        // The same ceiling `createBackup` uses, for the same reason: a restore
        // stages a full copy and runs `integrity_check` over it, so the
        // default 60s request timeout would drop the pending entry and report
        // a restore that in fact completed as a failure.
        return self.send('restoreBackup', undefined, BACKUP_REQUEST_TIMEOUT_MS) as Promise<{
          success: boolean;
          error?: string;
          source?: string;
        }>;
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
