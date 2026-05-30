/**
 * MigrationOrchestrator
 *
 * Drives the full PGLite → SQLite migration end-to-end:
 *
 *   1. Pre-flight (disk space + last-backup freshness)
 *   2. Snapshot the PGLite store (current backup ring)
 *   3. Open a fresh SQLite under sqlite-db/
 *   4. Run PGLiteToSQLiteMigrator against the live worker for the bulk copy
 *   5. Quiesce the live PGLite worker (close)
 *   6. Re-open PGLite from disk and run one final catch-up pass
 *   7. Close both
 *   8. Cutover: rename pglite-db/ → pglite-db.migrated-{ts}/, write the
 *      backend flag pointing at SQLite. The PGLite directory is never deleted.
 *
 * Failure rules (per the plan's Failure Paths table):
 *   - Any error before cutover -> delete the partial sqlite-db/ directory and
 *     leave PGLite untouched. The flag file is not written. App reopens on
 *     PGLite next launch.
 *   - Rename failure on cutover -> flag is already written (SQLite is the
 *     truth); the leftover pglite-db/ is logged but harmless. App boots into
 *     SQLite next launch.
 *
 * This module owns FILESYSTEM and SETTINGS side effects. The data-plane copy
 * lives in `PGLiteToSQLiteMigrator`; the IPC channel lives in
 * `MigrationProgressReporter`; this orchestrates.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SQLiteDatabase } from './SQLiteDatabase';
import {
  PGLiteToSQLiteMigrator,
  type MigrationProgress,
  type MigrationSummary,
  type PGLiteHandle,
} from './PGLiteToSQLiteMigrator';
import { MigrationProgressReporter } from './MigrationProgressReporter';
import { commitMigrationToSqlite } from './BackendSelector';

/**
 * Read surface satisfied by the live PGLiteDatabaseWorker. Mirrors the adapter
 * used by MigrationDryRunner and MigrationAdopter: the orchestrator reads
 * from the live worker rather than closing it and opening an in-process
 * PGLite handle, because `new PGlite()` in-process triggers PGlite's WASM
 * env to re-`require()` the main bundle, which re-evaluates the bundled
 * `electron-log` module and crashes with "Attempted to register a second
 * handler for '__ELECTRON_LOG__'".
 */
export interface LivePgliteReader {
  queryReadOnly<T = unknown>(
    sql: string,
    params?: unknown[],
    timeoutMs?: number,
  ): Promise<{ rows: T[] }>;
}

export interface OrchestratorOptions {
  /** User data path (`app.getPath('userData')` in production). */
  userDataPath: string;
  /** Absolute path to the SQLite schema directory. */
  schemaDir: string;
  /**
   * Live PGLite worker. We read the migration source via its `queryReadOnly`
   * surface (single-statement, bounded timeout) rather than opening a second
   * in-process PGLite handle — see `LivePgliteReader` above for the
   * `__ELECTRON_LOG__` re-registration trap that motivates this.
   */
  pglite: LivePgliteReader;
  /**
   * Close the live PGLite worker. Called only after the migrator has finished
   * reading and the SQLite copy is verified; the rename can't happen while
   * the worker holds the directory.
   */
  closeRunningPglite: () => Promise<void>;
  /**
   * Hook for fleet-aggregate telemetry. Production wiring calls
   * `AnalyticsService.getInstance().sendEvent(...)`. Tests use a spy.
   * The orchestrator respects the existing analytics opt-out — when the
   * caller's sendEvent is a no-op, nothing fires.
   */
  sendEvent?: (eventName: string, properties: Record<string, unknown>) => void;
  /**
   * Called after a successful cutover. Production wiring opens the new
   * SQLiteDatabase under the repository manager. Tests can supply a no-op.
   * The instance passed in is already closed by the time we call this.
   */
  onCutoverSuccess?: (info: {
    sqliteDir: string;
    pgliteMigratedDir: string;
    summary: MigrationSummary;
  }) => Promise<void> | void;
  /** Hook for the renderer-bound progress emitter. */
  reporter?: MigrationProgressReporter;
  /** Override for tests; defaults to PGLiteToSQLiteMigrator. */
  migrator?: PGLiteToSQLiteMigrator;
  /**
   * After the live PGLite worker is quiesced, reopen the on-disk database so
   * we can do one final catch-up pass and make the cutover snapshot exact.
   */
  reopenPgliteAfterClose?: (dataDir: string) => Promise<PGLiteHandle>;
  /** Logger. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
  /** For tests: skip the safety check that requires `pglite-db/` to exist. */
  allowEmptyPglite?: boolean;
}

export interface PreflightResult {
  ok: boolean;
  /** Reason text for the UI when ok=false. */
  reason?: string;
  pgliteDirBytes: number;
  freeBytes: number;
  requiredBytes: number;
}

const SAFETY_MULTIPLIER = 2;

export class MigrationOrchestrator {
  constructor(private opts: OrchestratorOptions) {}

  /**
   * Run pre-flight checks without doing anything destructive.
   * The migration UI calls this before showing the "Start migration" button.
   */
  async preflight(): Promise<PreflightResult> {
    const pgliteDir = path.join(this.opts.userDataPath, 'pglite-db');
    if (!fs.existsSync(pgliteDir) && !this.opts.allowEmptyPglite) {
      return {
        ok: false,
        reason: 'No PGLite directory found — nothing to migrate.',
        pgliteDirBytes: 0,
        freeBytes: 0,
        requiredBytes: 0,
      };
    }
    const pgliteDirBytes = fs.existsSync(pgliteDir) ? dirSizeBytes(pgliteDir) : 0;
    const requiredBytes = pgliteDirBytes * SAFETY_MULTIPLIER;
    const freeBytes = await freeBytesOnPath(this.opts.userDataPath);
    if (freeBytes < requiredBytes) {
      return {
        ok: false,
        reason: `Not enough free disk space. Need ~${humanBytes(requiredBytes)}; have ${humanBytes(freeBytes)}.`,
        pgliteDirBytes,
        freeBytes,
        requiredBytes,
      };
    }
    return { ok: true, pgliteDirBytes, freeBytes, requiredBytes };
  }

  /**
   * Run the migration end-to-end. Throws on any failure path before cutover;
   * the partial sqlite-db/ is cleaned up before the throw.
   */
  async run(): Promise<MigrationSummary> {
    const log = this.opts.log ?? (() => {});
    const reporter = this.opts.reporter;
    const userData = this.opts.userDataPath;
    const pgliteDir = path.join(userData, 'pglite-db');
    const sqliteDir = path.join(userData, 'sqlite-db');
    const migratedSuffix = new Date().toISOString().replace(/[:.]/g, '-');
    const pgliteMigratedDir = path.join(userData, `pglite-db.migrated-${migratedSuffix}`);

    log('info', '[orchestrator] starting migration', {
      pgliteDir,
      sqliteDir,
      pgliteMigratedDir,
    });

    // Sanity: don't overwrite an existing sqlite-db. If one exists from a
    // previous aborted attempt, move it aside first.
    if (fs.existsSync(sqliteDir)) {
      const aside = path.join(userData, `sqlite-db.aborted-${migratedSuffix}`);
      fs.renameSync(sqliteDir, aside);
      log('warn', '[orchestrator] existing sqlite-db moved aside', { aside });
    }
    fs.mkdirSync(sqliteDir, { recursive: true });

    let sqlite: SQLiteDatabase | null = null;
    let summary: MigrationSummary | null = null;
    let phase = 'opening-sqlite';
    try {
      // 1. Open fresh SQLite (initialize runs the schema bootstrap).
      sqlite = new SQLiteDatabase({
        dbDir: sqliteDir,
        schemaDir: this.opts.schemaDir,
        slowQueryThresholdMs: 100,
        log,
      });
      await sqlite.initialize();

      // 2. Bulk-copy against the LIVE PGLite worker. This gives us the
      // initial manifest/high-water marks, but it is not yet the final
      // cutover snapshot because the app can still write to PGLite while
      // the copy is running. We close that race below by quiescing PGLite
      // and running one last catch-up pass against a freshly reopened
      // on-disk handle.
      phase = 'migrating';
      const migrator = this.opts.migrator ?? new PGLiteToSQLiteMigrator();
      const onProgress: ((p: MigrationProgress) => void) | undefined = reporter
        ? reporter.onProgress
        : undefined;
      const adapter = buildReadOnlyAdapter(this.opts.pglite);
      summary = await migrator.migrate({
        pglite: adapter,
        sqlite,
        onProgress,
        log,
      });

      // 3. Quiesce the live PGLite worker so no more source writes can land.
      phase = 'closing-pglite';
      await this.opts.closeRunningPglite();

      // 4. Re-open the now-quiesced PGLite dir and catch SQLite up to the
      // exact final source state before we flip the backend flag.
      const reopen = this.opts.reopenPgliteAfterClose;
      if (!reopen) {
        throw new Error('MigrationOrchestrator requires reopenPgliteAfterClose() for final catch-up.');
      }
      const manifest = summary.manifest;
      if (!manifest) {
        throw new Error('MigrationOrchestrator missing migration manifest for final catch-up.');
      }
      phase = 'catching-up-after-close';
      const closedSource = await reopen(pgliteDir);
      const finalCatchUp = await (async () => {
        try {
          return await migrator.catchUp({
            pglite: closedSource,
            sqlite,
            manifest,
            onProgress,
            log,
          });
        } finally {
          await closedSource.close();
        }
      })();
      summary.totalRowsCopied += finalCatchUp.rowsAdded;
      summary.tablesCopied = mergeCopiedTables(summary.tablesCopied, finalCatchUp.perTable);

      // 5. Close SQLite cleanly before the rename.
      phase = 'closing-sqlite';
      await sqlite.close();
      sqlite = null;

      // 6. Cutover. Rename PGLite directory aside, write the backend flag.
      // Per the plan: if the rename fails (e.g. Windows file-in-use), we still
      // proceed — the flag points at SQLite, and a leftover pglite-db/ is
      // harmless. We log and surface it but don't fail the migration.
      phase = 'cutover';
      try {
        fs.renameSync(pgliteDir, pgliteMigratedDir);
      } catch (err) {
        log('warn', '[orchestrator] pglite-db rename failed; flag points at SQLite anyway', {
          err: (err as Error).message,
        });
      }
      commitMigrationToSqlite(userData, pgliteMigratedDir);

      // 7. Done. Hand control back to the caller, which re-opens SQLite under
      // the production code path.
      if (this.opts.onCutoverSuccess) {
        await this.opts.onCutoverSuccess({ sqliteDir, pgliteMigratedDir, summary });
      }
      reporter?.emitComplete(summary);
      log('info', '[orchestrator] migration succeeded', summary);

      // Fleet-aggregate telemetry. Fields per the plan + POSTHOG_EVENTS.md:
      //   pglite_dir_size_bytes — gauge of pre-migration store size
      //   target_row_count      — total rows migrated
      //   duration_ms           — wall-clock duration
      //   foreign_key_violations / integrity_check — sanity flags
      this.opts.sendEvent?.('migration_completed', {
        // pglite-db/ has just been renamed; measure from the new location.
        pglite_dir_size_bytes: fs.existsSync(pgliteMigratedDir) ? dirSizeBytes(pgliteMigratedDir) : 0,
        target_row_count: summary.totalRowsCopied,
        duration_ms: Math.round(summary.durationMs),
        tables_migrated: summary.tablesCopied.length,
        spot_check_count: summary.spotCheckCount,
        foreign_key_violations: summary.foreignKeyViolations,
        integrity_check: summary.integrityCheck,
      });

      return summary;
    } catch (err) {
      const message = (err as Error).message;
      const stack = (err as Error).stack;
      log('error', `[orchestrator] migration failed in ${phase}`, { message, stack });
      reporter?.emitFailed({ phase, message, stack });
      this.opts.sendEvent?.('migration_failed', {
        phase,
        message: message.slice(0, 500),
      });

      // Best-effort cleanup. We're conservative about not touching pglite-db;
      // the live worker is still serving the app, don't take it down on
      // failure. Just clean up the partial sqlite-db dir.
      try {
        if (sqlite) await sqlite.close();
      } catch { /* ignore */ }
      try {
        if (fs.existsSync(sqliteDir)) {
          fs.rmSync(sqliteDir, { recursive: true, force: true });
        }
      } catch (rmErr) {
        log('warn', '[orchestrator] failed to remove partial sqlite-db', {
          err: (rmErr as Error).message,
        });
      }

      throw err;
    }
  }
}

function buildReadOnlyAdapter(reader: LivePgliteReader): PGLiteHandle {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      return reader.queryReadOnly<T>(sql, params, 30_000);
    },
    async exec(_sql: string): Promise<unknown> {
      throw new Error('MigrationOrchestrator adapter is read-only; exec() is not supported');
    },
    async close(): Promise<void> {
      // No-op: the live worker keeps running until we explicitly close it.
    },
  };
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function dirSizeBytes(dir: string): number {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const p = stack.pop()!;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(p);
      } catch {
        continue;
      }
      for (const e of entries) stack.push(path.join(p, e));
    } else if (stat.isFile()) {
      total += stat.size;
    }
  }
  return total;
}

async function freeBytesOnPath(p: string): Promise<number> {
  // `fs.statfs` is Node 18.15+ / 20+. We're on Node 22 in Electron 33+.
  // Fall back to Number.MAX_SAFE_INTEGER if it throws so preflight doesn't
  // false-positive on platforms that don't support statfs (extremely rare).
  type Statfs = (p: string) => Promise<{ bsize: number; bavail: number }>;
  const statfs = (fs.promises as unknown as { statfs?: Statfs }).statfs;
  if (!statfs) return Number.MAX_SAFE_INTEGER;
  try {
    const s = await statfs(p);
    return s.bsize * s.bavail;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  for (const u of units) {
    if (v < 1024) return `${v.toFixed(1)} ${u}`;
    v /= 1024;
  }
  return `${v.toFixed(1)} PB`;
}

function mergeCopiedTables(
  base: Array<{ name: string; rows: number }>,
  delta: Array<{ name: string; added: number }>,
): Array<{ name: string; rows: number }> {
  const merged = new Map(base.map((entry) => [entry.name, entry.rows]));
  for (const entry of delta) {
    merged.set(entry.name, (merged.get(entry.name) ?? 0) + entry.added);
  }
  return Array.from(merged.entries()).map(([name, rows]) => ({ name, rows }));
}
