/**
 * SQLite Worker Thread
 *
 * Owns the better-sqlite3 connection plus the per-connection state that
 * synchronously touches it: WriteCoordinator, DatabaseInstrumentation,
 * SQLiteBackupService. Also hosts the full PGLite -> SQLite migration
 * pipeline (orchestrator, dry-runner, adopter) so the synchronous bulk
 * copy never blocks the main thread.
 *
 * Cross-thread reads from PGLite go through a bidirectional bridge:
 *   - worker emits `pgliteReadRequest` (event) -> main runs queryReadOnly
 *     on the PGLite worker -> main posts a `bridgeResponse` back -> the
 *     worker resolves the pending promise.
 *   - same shape for `workerControlRequest` ({ action: 'closePglite' }).
 *
 * Migration progress events use the existing `db:migration:*` channels —
 * worker emits them, main fans them out to BrowserWindows so the renderer
 * code stays identical to the in-process version.
 *
 * Message protocol: see `workerProtocol.ts`. Each request gets a
 * `{success,data}|{success:false,error}` response keyed by id.
 */

import { parentPort } from 'worker_threads';
import { performance } from 'node:perf_hooks';
import inspector from 'node:inspector';
import * as path from 'path';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { PGlite } from '@electric-sql/pglite';
import { SQLiteDatabase } from '../SQLiteDatabase';
import { SQLiteBackupService } from '../../../services/database/SQLiteBackupService';
import { MigrationOrchestrator, type LivePgliteReader as OrchestratorLivePgliteReader } from '../MigrationOrchestrator';
import { MigrationDryRunner } from '../MigrationDryRunner';
import { MigrationAdopter } from '../MigrationAdopter';
import { MigrationProgressReporter } from '../MigrationProgressReporter';
import {
  type RequestEnvelope,
  type ResponseEnvelope,
  type BridgeResponseEnvelope,
  type SerializedError,
  type InitPayload,
  type QueryPayload,
  type QueryReadOnlyPayload,
  type ExecPayload,
  type TransactionPayload,
  type GetSlowQueriesPayload,
  type GetPerformancePayload,
  type VerifyBackupPayload,
  type PragmaReadPayload,
  type StartMigrationPayload,
  type StartDryRunPayload,
  type AdoptDryRunPayload,
  type PgliteReadRequestPayload,
  type PgliteReadResponsePayload,
  type WorkerControlRequestPayload,
} from './workerProtocol';
import { assertWithinResponseLimit, ResponseTooLargeError } from './responseSizeGuard';
import type { PGLiteHandle } from '../PGLiteToSQLiteMigrator';

if (!parentPort) {
  throw new Error('sqliteWorker must run as a worker_threads Worker');
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sqlite: SQLiteDatabase | null = null;
let backupService: SQLiteBackupService | null = null;
let initOpts: InitPayload | null = null;

// Migration flags so we can reject concurrent attempts inside the worker.
let migrationRunning = false;
let dryRunRunning = false;
let adoptRunning = false;

// Pending bridge requests (worker -> main). Resolved when main posts back
// a BridgeResponseEnvelope keyed by `bridgeId`. The timer is cleared on
// response so we don't leak one timer per bridge call into the event loop.
interface PendingBridge {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}
const pendingBridge = new Map<string, PendingBridge>();

// ---------------------------------------------------------------------------
// CPU profile auto-capture inside the worker.
//
// inspector.Session on main never sees this isolate, so if the worker pegs
// CPU (e.g. a busy query loop, an instrumentation hot path, a runaway timer)
// the main-side profile shows 100% idle and we have no signal. We poll
// event-loop utilization here -- when it stays >0.8 across two checks we
// capture a 5s profile to the same logs dir as main and emit a `log` event
// so it shows up in main.log. 60s cooldown.
// ---------------------------------------------------------------------------

let workerLogsDir: string | null = null;
let workerProfileInFlight = false;
let workerLastProfileAt = 0;
let workerHighEluStreak = 0;
const WORKER_PROFILE_TTL_MS = 60_000;
const WORKER_PROFILE_DURATION_MS = 5_000;
const WORKER_ELU_THRESHOLD = 0.8;
const WORKER_ELU_TRIGGER_SAMPLES = 2;

async function captureWorkerCpuProfile(triggerElu: number): Promise<void> {
  if (workerProfileInFlight || !workerLogsDir) return;
  const now = Date.now();
  if (now - workerLastProfileAt < WORKER_PROFILE_TTL_MS) return;
  workerProfileInFlight = true;
  workerLastProfileAt = now;

  // First: dump the top-10 query shapes by total time. This usually answers
  // "what's hot?" without anyone having to open the .cpuprofile.
  try {
    if (sqlite) {
      const snap = sqlite.getInstrumentation().getSnapshot() as {
        byShape: Array<{ shape: string; count: number; totalMs: number; p99: number; maxMs: number; lastCallSite: string | null }>;
      };
      const top = snap.byShape.slice(0, 10);
      log('warn', `[PERF] SQLite worker hot shapes (elu=${triggerElu.toFixed(2)}, top ${top.length} by totalMs):`);
      for (const s of top) {
        const shape = s.shape.length > 200 ? s.shape.slice(0, 200) + '...' : s.shape;
        log('warn', `[PERF]   ${s.totalMs}ms total / ${s.count} calls / p99=${s.p99}ms / max=${s.maxMs}ms / site=${s.lastCallSite ?? '?'} | ${shape}`);
      }
    }
  } catch (err) {
    log('warn', '[PERF] Failed to dump hot shapes: ' + (err instanceof Error ? err.message : String(err)));
  }

  const session = new inspector.Session();
  try {
    session.connect();
    const post = <T>(method: string, params?: object) =>
      new Promise<T>((resolve, reject) => {
        session.post(method, params, (err, result) => {
          if (err) reject(err); else resolve(result as T);
        });
      });
    await post('Profiler.enable');
    await post('Profiler.start');
    await new Promise<void>((r) => setTimeout(r, WORKER_PROFILE_DURATION_MS));
    const { profile } = await post<{ profile: object }>('Profiler.stop');

    await fs.promises.mkdir(workerLogsDir, { recursive: true });
    const filename = `cpu-sqlite-worker-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`;
    const fullPath = path.join(workerLogsDir, filename);
    await fs.promises.writeFile(fullPath, JSON.stringify(profile));
    log('info', '[PERF] Captured SQLite worker CPU profile', { triggerElu: triggerElu.toFixed(2), path: fullPath });
  } catch (err) {
    log('error', '[PERF] SQLite worker CPU profile capture failed', { err: err instanceof Error ? err.message : String(err) });
  } finally {
    try { session.disconnect(); } catch { /* already disconnected */ }
    workerProfileInFlight = false;
  }
}

function startWorkerCpuMonitor(): void {
  // performance.eventLoopUtilization tracks (busy / (idle + busy)). Reading
  // it without an arg returns the cumulative ELU since worker start; passing
  // the previous reading returns the delta since last call. Anything close to
  // 1.0 for sustained periods means this worker's event loop is saturated.
  let prev = performance.eventLoopUtilization();
  const timer = setInterval(() => {
    const next = performance.eventLoopUtilization();
    const delta = performance.eventLoopUtilization(next, prev);
    prev = next;
    const elu = delta.utilization;
    if (elu >= WORKER_ELU_THRESHOLD) {
      workerHighEluStreak++;
      if (workerHighEluStreak >= WORKER_ELU_TRIGGER_SAMPLES) {
        workerHighEluStreak = 0;
        void captureWorkerCpuProfile(elu);
      }
    } else {
      workerHighEluStreak = 0;
    }
  }, 10_000);
  if (typeof timer.unref === 'function') timer.unref();
}

// ---------------------------------------------------------------------------
// Outbound events + bridge requests.
// ---------------------------------------------------------------------------

function emit(event: string, payload: unknown): void {
  parentPort!.postMessage({ event, payload });
}

function log(level: 'info' | 'warn' | 'error', msg: string, meta?: unknown): void {
  emit('log', { level, msg, meta });
}

function bridgeRequest<T = unknown>(
  event: string,
  payload: unknown,
  timeoutMs = 60_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const bridgeId = uuidv4();
    const timer = setTimeout(() => {
      if (pendingBridge.has(bridgeId)) {
        pendingBridge.delete(bridgeId);
        reject(new Error(`Bridge request '${event}' timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    pendingBridge.set(bridgeId, {
      resolve: (v) => resolve(v as T),
      reject,
      timer,
    });
    parentPort!.postMessage({ event, bridgeId, payload });
  });
}

function serializeError(err: unknown): SerializedError {
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

function ensureInitialized(): SQLiteDatabase {
  if (!sqlite) throw new Error('SQLite worker not initialized');
  return sqlite;
}

function workerLogger(
  level: 'info' | 'warn' | 'error',
  msg: string,
  meta?: unknown,
): void {
  log(level, msg, meta);
}

function makeReporter(): MigrationProgressReporter {
  // Worker-side broadcast: forward each phase/progress/complete/failed event
  // to main via the same `db:migration:*` event name. Main maps them 1:1 to
  // BrowserWindow broadcasts on the matching channel.
  return new MigrationProgressReporter({
    broadcast: (channel, payload) => emit(channel, payload),
    log: (l, m, meta) => workerLogger(l === 'info' ? 'info' : 'warn', m, meta),
  });
}

function buildPgliteReader(): OrchestratorLivePgliteReader {
  return {
    async queryReadOnly<T>(
      sql: string,
      params?: unknown[],
      timeoutMs?: number,
    ): Promise<{ rows: T[] }> {
      // The bridge timeout is the per-request timeout plus a small headroom
      // so the worker doesn't bail before main has a chance to respond.
      const t = timeoutMs ?? 30_000;
      const result = await bridgeRequest<PgliteReadResponsePayload<T>>(
        'pgliteReadRequest',
        { sql, params, timeoutMs: t } as PgliteReadRequestPayload,
        t + 10_000,
      );
      return { rows: result.rows };
    },
  };
}

async function bridgeClosePglite(): Promise<void> {
  await bridgeRequest<{ ok: true }>(
    'workerControlRequest',
    { action: 'closePglite' } as WorkerControlRequestPayload,
    60_000,
  );
}

async function reopenClosedPglite(dataDir: string): Promise<PGLiteHandle> {
  const db = new PGlite({ dataDir });
  await (db as unknown as { waitReady: Promise<void> }).waitReady;
  return {
    async query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      return db.query<T>(sql, params as unknown[]) as Promise<{ rows: T[] }>;
    },
    async exec(sql: string): Promise<unknown> {
      return db.exec(sql);
    },
    async close(): Promise<void> {
      await db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Request dispatch.
// ---------------------------------------------------------------------------

async function handle(req: RequestEnvelope): Promise<unknown> {
  switch (req.type) {
    case 'init': {
      const opts = req.payload as InitPayload;
      initOpts = opts;
      // Logs dir is sibling of the data dir (matches main process layout:
      // userData/sqlite-db -> userData/logs).
      workerLogsDir = path.join(path.dirname(path.dirname(opts.dbDir)), 'logs');
      startWorkerCpuMonitor();
      const t0 = performance.now();
      sqlite = new SQLiteDatabase({
        dbDir: opts.dbDir,
        schemaDir: opts.schemaDir,
        slowQueryThresholdMs: opts.slowQueryThresholdMs,
        sampleRate: opts.sampleRate,
        log: (level, msg, meta) =>
          log(level === 'info' ? 'info' : level === 'warn' ? 'warn' : 'error', msg, meta),
      });
      await sqlite.initialize();
      const backupDir = path.join(path.dirname(opts.dbDir), 'sqlite-db.backups');
      backupService = new SQLiteBackupService({
        sqliteDir: opts.dbDir,
        backupDir,
        sqlite,
        log: (level, msg, meta) => log(level, msg, meta),
      });
      await backupService.initialize();
      sqlite.setBackupService(backupService);
      return { initMs: performance.now() - t0 };
    }

    case 'close': {
      if (sqlite) {
        await sqlite.close();
        sqlite = null;
      }
      backupService = null;
      return { closed: true };
    }

    case 'isInitialized':
      return { initialized: sqlite?.isInitialized() ?? false };

    case 'query': {
      const { sql, params } = req.payload as QueryPayload;
      return ensureInitialized().query(sql, params);
    }

    case 'queryReadOnly': {
      const { sql, params, timeoutMs } = req.payload as QueryReadOnlyPayload;
      return ensureInitialized().queryReadOnly(sql, params, timeoutMs);
    }

    case 'exec': {
      const { sql } = req.payload as ExecPayload;
      await ensureInitialized().exec(sql);
      return { ok: true };
    }

    case 'transaction': {
      const { statements } = req.payload as TransactionPayload;
      await ensureInitialized().runTransaction(statements);
      return { ok: true };
    }

    case 'getStats':
      return ensureInitialized().getStats();

    case 'getSlowQueries': {
      const { limit } = (req.payload ?? {}) as GetSlowQueriesPayload;
      return ensureInitialized().getInstrumentation().getSlowQueries(limit ?? 50);
    }

    case 'getPerformance': {
      const { slowLimit } = (req.payload ?? {}) as GetPerformancePayload;
      const inst = ensureInitialized().getInstrumentation();
      return {
        snapshot: inst.getSnapshot(),
        slowQueries: inst.getSlowQueries(slowLimit ?? 50),
      };
    }

    case 'createBackup':
      return backupService
        ? backupService.createBackup()
        : { success: false, error: 'Backup service not initialized' };

    case 'verifyBackup': {
      const { backupPath } = req.payload as VerifyBackupPayload;
      return ensureInitialized().verifyBackup(backupPath);
    }

    case 'getBackupStatus':
      return backupService ? backupService.getBackupStatus() : null;

    case 'cleanupBackups':
      if (backupService) {
        await backupService.cleanupOldCorruptedBackups();
      }
      return { ok: true };

    case 'pragmaRead': {
      const { name } = req.payload as PragmaReadPayload;
      const handle = ensureInitialized().getRawHandle();
      if (!handle) throw new Error('SQLite handle unavailable');
      return { value: handle.pragma(name, { simple: true }) };
    }

    case 'dashboardTableStats':
      return buildDashboardTableStats();

    case 'walCheckpoint': {
      const handle = ensureInitialized().getRawHandle();
      if (!handle) throw new Error('SQLite handle unavailable');
      return { result: handle.pragma('wal_checkpoint(TRUNCATE)') };
    }

    // ----- Migration --------------------------------------------------------

    case 'migrationPreflight': {
      const { userDataPath, schemaDir } = req.payload as StartMigrationPayload;
      const orch = new MigrationOrchestrator({
        userDataPath,
        schemaDir,
        pglite: buildPgliteReader(),
        closeRunningPglite: async () => undefined,
        log: workerLogger,
      });
      return orch.preflight();
    }

    case 'migrationStart': {
      if (migrationRunning) throw new Error('Migration already running.');
      if (dryRunRunning) throw new Error('A dry run is in progress; migration is unavailable.');
      migrationRunning = true;
      try {
        const { userDataPath, schemaDir } = req.payload as StartMigrationPayload;
        const reporter = makeReporter();
        const orch = new MigrationOrchestrator({
          userDataPath,
          schemaDir,
          pglite: buildPgliteReader(),
          closeRunningPglite: bridgeClosePglite,
          reopenPgliteAfterClose: reopenClosedPglite,
          onCutoverSuccess: async (info) => {
            emit('db:migration:cutoverSuccess', {
              sqliteDir: info.sqliteDir,
              pgliteMigratedDir: info.pgliteMigratedDir,
            });
          },
          reporter,
          log: workerLogger,
        });
        const summary = await orch.run();
        return { summary };
      } finally {
        migrationRunning = false;
      }
    }

    case 'migrationStartDryRun': {
      if (dryRunRunning) throw new Error('Dry run already in progress.');
      if (migrationRunning) throw new Error('A migration is in progress; dry run is unavailable.');
      dryRunRunning = true;
      try {
        const { userDataPath, schemaDir } = req.payload as StartDryRunPayload;
        const reporter = makeReporter();
        const dryRunner = new MigrationDryRunner({
          userDataPath,
          schemaDir,
          pglite: buildPgliteReader(),
          reporter,
          // Match the IPC default: keep the dry-run dir + manifest on success so
          // the user can adopt it later. Tests can override via a different
          // request type or a payload flag if/when needed.
          keepArtifacts: true,
          log: workerLogger,
        });
        const result = await dryRunner.run();
        return { result };
      } finally {
        dryRunRunning = false;
      }
    }

    case 'migrationDryRunStatus': {
      const { userDataPath, schemaDir } = req.payload as AdoptDryRunPayload;
      const adopter = new MigrationAdopter({
        userDataPath,
        schemaDir,
        pglite: buildPgliteReader(),
        closeRunningPglite: async () => undefined,
        log: workerLogger,
      });
      const found = adopter.findDryRunDir();
      if (!found) return { available: false };
      return {
        available: true,
        completedAt: found.manifest.completedAt,
        totalRows: found.manifest.perTable.reduce((s, t) => s + t.rows, 0),
      };
    }

    case 'migrationAdoptDryRun': {
      if (adoptRunning) throw new Error('Adopt already running.');
      if (migrationRunning || dryRunRunning) {
        throw new Error('Another migration operation is in progress.');
      }
      adoptRunning = true;
      try {
        const { userDataPath, schemaDir } = req.payload as AdoptDryRunPayload;
        const reporter = makeReporter();
        const adopter = new MigrationAdopter({
          userDataPath,
          schemaDir,
          pglite: buildPgliteReader(),
          closeRunningPglite: bridgeClosePglite,
          reopenPgliteAfterClose: reopenClosedPglite,
          onCutoverSuccess: async (info) => {
            emit('db:migration:cutoverSuccess', {
              sqliteDir: info.sqliteDir,
              pgliteMigratedDir: info.pgliteMigratedDir,
            });
          },
          reporter,
          log: workerLogger,
        });
        const result = await adopter.run();
        return { result };
      } finally {
        adoptRunning = false;
      }
    }

    case 'migrationRollback': {
      // Pure filesystem op (no SQLite or PGLite handles). Worker thread has
      // fs access, so we run it here for symmetry with the other migration
      // ops — main's MigrationHandlers stays thin.
      const { userDataPath } = req.payload as { userDataPath: string };
      const migrated = fs
        .readdirSync(userDataPath)
        .filter((d) => d.startsWith('pglite-db.migrated-'))
        .sort()
        .pop();
      if (!migrated) {
        throw new Error('No preserved PGLite directory to roll back to.');
      }
      const pgliteDir = path.join(userDataPath, 'pglite-db');
      const sqliteDir = path.join(userDataPath, 'sqlite-db');
      if (fs.existsSync(pgliteDir)) {
        throw new Error('pglite-db/ already exists; refusing to overwrite.');
      }
      if (fs.existsSync(sqliteDir)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(sqliteDir, path.join(userDataPath, `sqlite-db.rolledback-${stamp}`));
      }
      fs.renameSync(path.join(userDataPath, migrated), pgliteDir);
      // BackendSelector lives in main code but only does a JSON write; the
      // worker shouldn't import it (keeps the bundle lean) — main does this
      // post-response.
      return { restoredFrom: migrated };
    }

    default:
      throw new Error(`Unknown worker request type: ${req.type}`);
  }
}

// ---------------------------------------------------------------------------
// Dashboard table stats — runs entirely in the worker so the main thread
// never feels the dbstat scan. One pass over dbstat groups by btree name;
// sizes from SUM(pgsize), row counts from SUM(ncell) on leaf pages.
// ---------------------------------------------------------------------------

async function buildDashboardTableStats() {
  const inst = ensureInitialized();
  const handle = inst.getRawHandle();
  if (!handle) throw new Error('SQLite handle unavailable');

  const tables = (
    await inst.queryReadOnly<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         AND name NOT LIKE '\\_%' ESCAPE '\\'
       ORDER BY name`,
    )
  ).rows.map((r) => r.name);

  let dbstatAvailable = true;
  try {
    handle.prepare(`SELECT sum(pgsize) FROM dbstat LIMIT 1`).get();
  } catch {
    dbstatAvailable = false;
  }

  const sizeByName = new Map<string, number>();
  const rowsByName = new Map<string, number>();
  if (dbstatAvailable) {
    try {
      const rows = handle
        .prepare(
          `SELECT name,
                  SUM(pgsize) AS bytes,
                  SUM(CASE WHEN pagetype = 'leaf' THEN ncell ELSE 0 END) AS cells
           FROM dbstat
           GROUP BY name`,
        )
        .all() as Array<{ name: string; bytes: number | null; cells: number | null }>;
      for (const r of rows) {
        sizeByName.set(r.name, Number(r.bytes ?? 0));
        rowsByName.set(r.name, Number(r.cells ?? 0));
      }
    } catch (e) {
      log('warn', '[sqliteWorker] dbstat aggregate scan failed', {
        err: (e as Error).message,
      });
    }
  }

  const tableStats = tables.map((name) => {
    const sizeBytes = sizeByName.get(name) ?? 0;
    const rowCount = rowsByName.get(name) ?? 0;
    return { name, rowCount, size: humanBytes(sizeBytes), sizeBytes };
  });
  tableStats.sort((a, b) => b.sizeBytes - a.sizeBytes);

  const pageCount = Number(handle.pragma('page_count', { simple: true }) ?? 0);
  const pageSize = Number(handle.pragma('page_size', { simple: true }) ?? 0);
  const totalSizeBytes = pageCount * pageSize;

  const autocheckpointPages = Number(
    handle.pragma('wal_autocheckpoint', { simple: true }) ?? 1000,
  );
  const walCeilingBytes = autocheckpointPages * pageSize;
  const walPath = path.join(initOpts!.dbDir, 'nimbalyst.sqlite-wal');
  let walSize = 0;
  try {
    walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  } catch {
    /* ignore */
  }
  const walStats = {
    fileCount: walSize > 0 ? 1 : 0,
    totalBytes: walSize,
    totalSize: humanBytes(walSize),
    minWalSize: '0 B',
    maxWalSize: humanBytes(walCeilingBytes),
    checkpointTimeout: `auto at ${autocheckpointPages.toLocaleString()} pages`,
    description:
      `SQLite auto-checkpoints (PASSIVE) when the WAL crosses ${autocheckpointPages.toLocaleString()} pages (${humanBytes(walCeilingBytes)} at ${humanBytes(pageSize)}/page). Larger checkpoints run on close.`,
  };

  return {
    tableStats,
    totalSize: humanBytes(totalSizeBytes),
    totalSizeBytes,
    walStats,
    basicStats: await inst.getStats(),
  };
}

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 bytes';
  if (n < 1024) return `${n} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  for (const u of units) {
    if (v < 1024) return `${v.toFixed(1)} ${u}`;
    v /= 1024;
  }
  return `${v.toFixed(1)} PB`;
}

// ---------------------------------------------------------------------------
// Message loop.
// ---------------------------------------------------------------------------

parentPort.on('message', async (msg: RequestEnvelope | BridgeResponseEnvelope) => {
  // Bridge response from main (PGLite reads, control actions). Resolve the
  // pending promise; don't try to dispatch to handle().
  if ('bridgeResponse' in msg && msg.bridgeResponse) {
    const pending = pendingBridge.get(msg.bridgeId);
    if (!pending) return;
    pendingBridge.delete(msg.bridgeId);
    if (pending.timer) clearTimeout(pending.timer);
    if (msg.success) {
      pending.resolve(msg.data);
    } else {
      const err = new Error(msg.error?.message ?? 'Bridge request failed');
      if (msg.error?.name) err.name = msg.error.name;
      if (msg.error?.stack) err.stack = msg.error.stack;
      if (msg.error?.code) (err as { code?: string }).code = msg.error.code;
      pending.reject(err);
    }
    return;
  }

  const reqMsg = msg as RequestEnvelope;
  try {
    const data = await handle(reqMsg);
    // Reject oversized payloads before postMessage rather than letting V8's
    // structured-clone serializer grow a multi-GB buffer and abort the whole
    // process. See responseSizeGuard.ts.
    try {
      assertWithinResponseLimit(data);
    } catch (sizeErr) {
      if (sizeErr instanceof ResponseTooLargeError) {
        const sql = (reqMsg.payload as { sql?: string } | undefined)?.sql;
        log('error', '[sqliteWorker] response exceeds size limit; rejecting to avoid OOM crash', {
          type: reqMsg.type,
          approxBytes: sizeErr.approxBytes,
          limitBytes: sizeErr.limitBytes,
          sql,
        });
      }
      throw sizeErr;
    }
    const response: ResponseEnvelope = { id: reqMsg.id, success: true, data };
    parentPort!.postMessage(response);
  } catch (err) {
    const response: ResponseEnvelope = {
      id: reqMsg.id,
      success: false,
      error: serializeError(err),
    };
    parentPort!.postMessage(response);
  }
});

process.on('uncaughtException', (err) => {
  log('error', '[sqliteWorker] uncaughtException', {
    message: err.message,
    stack: err.stack,
  });
});
process.on('unhandledRejection', (err) => {
  log('error', '[sqliteWorker] unhandledRejection', {
    message: (err as Error)?.message ?? String(err),
  });
});

log('info', '[sqliteWorker] ready');
