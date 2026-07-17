/**
 * SQLite Worker IPC Protocol
 *
 * Shared message-type definitions used by both ends of the worker boundary:
 *
 *   - `sqliteWorker.ts` (runs inside a `worker_threads` Worker; owns the
 *     better-sqlite3 connection, WriteCoordinator, Instrumentation, the
 *     backup service, and the migration pipeline).
 *
 *   - `SQLiteDatabaseWorker.ts` (runs on the main thread; mirrors the public
 *     surface of the in-process `SQLiteDatabase` so existing call sites that
 *     awaited `query/exec/queryReadOnly` keep compiling untouched).
 *
 * Every request carries a unique `id` so responses can resolve the matching
 * pending promise on the main side. Every response carries the same `id`
 * back plus a `success` flag; on failure the response includes a serialized
 * error (`message`, optional `name`, optional `stack`, optional `code`) so
 * the proxy can rethrow a real `Error` with the original message.
 *
 * Worker-initiated events (progress, backup status, slow-query notifications)
 * are sent without an `id` and use the `event` field; the proxy fans them out
 * to subscribers it has registered locally.
 */

// ============================================================================
// Common envelope shapes
// ============================================================================

export interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
  code?: string;
}

export interface RequestEnvelope<T extends string = string, P = unknown> {
  id: string;
  type: T;
  payload?: P;
}

export interface OkResponse<T = unknown> {
  id: string;
  success: true;
  data: T;
}

export interface ErrResponse {
  id: string;
  success: false;
  error: SerializedError;
}

export type ResponseEnvelope<T = unknown> = OkResponse<T> | ErrResponse;

export interface EventEnvelope<T extends string = string, P = unknown> {
  // Discriminates from RequestEnvelope/ResponseEnvelope. The proxy listens
  // for messages WITHOUT an `id` and routes by `event`.
  event: T;
  payload: P;
}

// ============================================================================
// Bridge — bidirectional channel from the worker back to main.
//
// The migration pipeline needs to read source rows from the live PGLite worker
// (which lives in a *different* worker_threads thread, not addressable from
// this one) and to ask main to close that worker before cutover. We model
// those as worker-initiated requests: the worker posts an `event` with a
// unique `bridgeId`; main runs the requested action and posts a
// `BridgeResponseEnvelope` back. The worker resolves the pending promise.
// ============================================================================

export interface BridgeRequestEnvelope<T extends string = string, P = unknown> {
  event: T;
  bridgeId: string;
  payload: P;
}

export interface BridgeResponseEnvelope {
  bridgeResponse: true;
  bridgeId: string;
  success: boolean;
  data?: unknown;
  error?: SerializedError;
}

export interface PgliteReadRequestPayload {
  sql: string;
  params?: unknown[];
  timeoutMs?: number;
}

export interface PgliteReadResponsePayload<T = unknown> {
  rows: T[];
}

export type WorkerControlAction = 'closePglite';

export interface WorkerControlRequestPayload {
  action: WorkerControlAction;
}

// ============================================================================
// Init / lifecycle
// ============================================================================

export interface InitPayload {
  /** Directory holding nimbalyst.sqlite and its WAL/SHM siblings. */
  dbDir: string;
  /** Directory holding migration SQL files. */
  schemaDir: string;
  /** Slow-query log threshold in ms. */
  slowQueryThresholdMs?: number;
  /** Sample rate (0..1). */
  sampleRate?: number;
}

export interface InitResult {
  /** Wall-clock time spent in initialize() in ms. */
  initMs: number;
  /** Applied schema migrations. */
  appliedMigrations: string[];
  /** Skipped (already-applied) schema migrations. */
  skippedMigrations: string[];
}

// ============================================================================
// Query / exec
// ============================================================================

export interface QueryPayload {
  sql: string;
  params?: unknown[];
}

export interface QueryReadOnlyPayload extends QueryPayload {
  /** Bounded JS-side timeout in ms; falls back to 5000 in the worker. */
  timeoutMs?: number;
}

export interface QueryResult<T = unknown> {
  rows: T[];
  /** Set on writes; better-sqlite3 reports affected row count from .run(). */
  rowsAffected?: number;
}

export interface ExecPayload {
  sql: string;
}

export interface TransactionPayload {
  statements: Array<{ sql: string; params?: unknown[] }>;
}

// ============================================================================
// Stats / instrumentation
// ============================================================================

export interface GetStatsResult {
  backend: 'sqlite';
  dbBytes: number;
  walBytes: number;
  pageCount: number | null;
  pageSize: number | null;
  queryStats: unknown; // Instrumentation.getSnapshot() payload
}

export interface GetSlowQueriesPayload {
  limit?: number;
}

export interface GetPerformancePayload {
  slowLimit?: number;
}

export interface GetPerformanceResult {
  snapshot: unknown;
  slowQueries: unknown[];
}

// ============================================================================
// Backup
// ============================================================================

export interface CreateBackupResult {
  success: boolean;
  error?: string;
}

export interface VerifyBackupPayload {
  backupPath: string;
}

export interface VerifyBackupResult {
  valid: boolean;
  error?: string;
  hasData?: boolean;
  sessionCount?: number;
  historyCount?: number;
}

export interface BackupStatus {
  // Mirrors AppDatabaseBackupService.getBackupStatus() payload. Loose-typed at
  // the boundary because the existing PGLite shape is broader than what the
  // SQLite backup service currently returns; the dashboard renderer is the
  // only consumer and is already defensive about missing fields.
  [key: string]: unknown;
}

// ============================================================================
// Migration — orchestrator / dry-run / adopter all driven by the worker.
// ============================================================================

export interface MigrationPreflightResult {
  ok: boolean;
  reason?: string;
  pgliteDirBytes: number;
  freeBytes: number;
  requiredBytes: number;
}

export interface StartMigrationPayload {
  userDataPath: string;
  schemaDir: string;
}

export interface StartDryRunPayload {
  userDataPath: string;
  schemaDir: string;
}

export interface AdoptDryRunPayload {
  userDataPath: string;
  schemaDir: string;
}

export interface DryRunStatusResult {
  available: boolean;
  completedAt?: string;
  totalRows?: number;
}

// ============================================================================
// Dashboard helpers — replace `getRawHandle()` callsites on main with named ops
// ============================================================================

export interface PragmaReadPayload {
  name: string;
}

export interface PragmaReadResult {
  value: unknown;
}

export interface DashboardTableStatsResult {
  tableStats: Array<{
    name: string;
    rowCount: number;
    size: string;
    sizeBytes: number;
  }>;
  totalSize: string;
  totalSizeBytes: number;
  walStats: {
    fileCount: number;
    totalBytes: number;
    totalSize: string;
    minWalSize: string;
    maxWalSize: string;
    checkpointTimeout: string;
    description: string;
  } | null;
  basicStats: GetStatsResult;
}

// ============================================================================
// Request type union (string literal → payload mapping is documented per case
// in sqliteWorker.ts; we don't attempt full type indexing here because TS
// support for keyed dispatch inside the worker is more friction than value.)
// ============================================================================

export type WorkerRequestType =
  | 'init'
  | 'close'
  | 'isInitialized'
  | 'query'
  | 'queryReadOnly'
  | 'exec'
  | 'transaction'
  | 'getStats'
  | 'getSlowQueries'
  | 'getPerformance'
  | 'createBackup'
  | 'verifyBackup'
  | 'getBackupStatus'
  | 'cleanupBackups'
  | 'migrationPreflight'
  | 'migrationStart'
  | 'migrationStartDryRun'
  | 'migrationDryRunStatus'
  | 'migrationAdoptDryRun'
  | 'migrationRollback'
  | 'pragmaRead'
  | 'dashboardTableStats'
  | 'walCheckpoint';

export type WorkerEventType =
  | 'db:migration:phase'
  | 'db:migration:progress'
  | 'db:migration:complete'
  | 'db:migration:failed'
  | 'db:migration:cutoverSuccess'
  | 'pgliteReadRequest'
  | 'workerControlRequest'
  | 'log';
