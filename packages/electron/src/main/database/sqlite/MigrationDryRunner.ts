/**
 * MigrationDryRunner
 *
 * Runs the full data-plane migration into a throwaway SQLite database while
 * the user keeps using the app. Designed for alpha testers: gives them real
 * stats (row counts, per-table breakdown, duration, FK + integrity status)
 * without touching `pglite-db/` or flipping the backend flag.
 *
 * Differences vs `MigrationOrchestrator`:
 *   - Does NOT close the running PGLite worker. We wrap it via its existing
 *     `queryReadOnly()` API (single-statement, bounded timeout). PGLite stays
 *     fully usable during the dry run.
 *   - Writes the SQLite database under `sqlite-db.dry-run-<ts>/` so it's
 *     trivially distinguishable from a real cutover staging dir, and removes
 *     it on completion (or on failure).
 *   - Never renames `pglite-db/`, never writes the backend flag, never
 *     touches the rolling backup ring.
 *   - Emits the same `db:migration:progress` events through
 *     `MigrationProgressReporter` so the UI can reuse the progress widgets.
 *     The phase channel suffixes `(dry run)` so the renderer can label.
 *
 * On the typed adapter: PGLite is single-process — opening a second handle
 * against the same dataDir would deadlock against the worker's lock. The
 * read-only adapter routes every migrator query through the already-running
 * worker so we don't fight for the lock.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SQLiteDatabase } from './SQLiteDatabase';
import {
  PGLiteToSQLiteMigrator,
  type MigrationSummary,
  type MigrationProgress,
  type PGLiteHandle,
  type DryRunManifest,
} from './PGLiteToSQLiteMigrator';
import { MigrationProgressReporter } from './MigrationProgressReporter';

/** Filename for the manifest written into each dry-run dir on success. */
export const DRY_RUN_MANIFEST_FILENAME = '.dry-run-manifest.json';

/**
 * The minimum surface the dry-runner needs from the live PGLite worker.
 * Matches `PGLiteDatabaseWorker.queryReadOnly` exactly so callers pass the
 * worker directly.
 */
export interface LivePgliteReader {
  queryReadOnly<T = unknown>(
    sql: string,
    params?: unknown[],
    timeoutMs?: number,
  ): Promise<{ rows: T[] }>;
}

export interface DryRunOptions {
  /** User data dir. The dry-run SQLite directory is created under here. */
  userDataPath: string;
  /** Absolute path to the SQLite schema directory. */
  schemaDir: string;
  /** Live PGLite worker (the singleton from `database/initialize.ts`). */
  pglite: LivePgliteReader;
  /** Hook for renderer-bound progress emit. */
  reporter?: MigrationProgressReporter;
  /** Override for tests. */
  migrator?: PGLiteToSQLiteMigrator;
  /** Logger. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
  /** Per-query timeout passed to the wrapped reader. Default 30_000. */
  pgliteTimeoutMs?: number;
  /**
   * If true, leave the dry-run SQLite directory on disk after completion so
   * the user (or a test) can inspect it. Default false — cleanup happens.
   */
  keepArtifacts?: boolean;
}

export interface DryRunResult {
  summary: MigrationSummary;
  /** Path the dry-run SQLite was materialised at (gone unless keepArtifacts). */
  dryRunDir: string;
  /** Final on-disk bytes of the dry-run SQLite database file. */
  sqliteFileBytes: number;
  /** Bytes of pglite-db/ at the time of the dry run (informational). */
  pgliteDirBytes: number;
}

export class MigrationDryRunner {
  constructor(private opts: DryRunOptions) {}

  async run(): Promise<DryRunResult> {
    const log = this.opts.log ?? (() => {});
    const reporter = this.opts.reporter;

    // Clean up any previous dry-run directories. We only keep the latest one
    // so the user can adopt it; older ones are stale (PGLite has moved on).
    try {
      for (const entry of fs.readdirSync(this.opts.userDataPath)) {
        if (entry.startsWith('sqlite-db.dry-run-')) {
          const stale = path.join(this.opts.userDataPath, entry);
          try {
            fs.rmSync(stale, { recursive: true, force: true });
            log('info', '[dry-run] removed stale dry-run dir', { stale });
          } catch {
            // Best effort; we'll create the new one regardless.
          }
        }
      }
    } catch {
      // userDataPath unreadable; ignore — fs.mkdirSync below will fail loudly.
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dryRunDir = path.join(this.opts.userDataPath, `sqlite-db.dry-run-${stamp}`);
    fs.mkdirSync(dryRunDir, { recursive: true });

    log('info', '[dry-run] starting', { dryRunDir });

    const adapter = buildReadOnlyAdapter(this.opts.pglite, this.opts.pgliteTimeoutMs ?? 30_000);
    let sqlite: SQLiteDatabase | null = null;
    let summary: MigrationSummary | null = null;

    try {
      sqlite = new SQLiteDatabase({
        dbDir: dryRunDir,
        schemaDir: this.opts.schemaDir,
        slowQueryThresholdMs: 100,
        log,
      });
      await sqlite.initialize();

      const migrator = this.opts.migrator ?? new PGLiteToSQLiteMigrator();
      const onProgress = reporter
        ? (p: MigrationProgress) => reporter.onProgress(p)
        : undefined;

      summary = await migrator.migrate({
        pglite: adapter,
        sqlite,
        onProgress,
        log,
      });

      const sqliteFile = path.join(dryRunDir, 'nimbalyst.sqlite');
      const sqliteFileBytes = fs.existsSync(sqliteFile) ? fs.statSync(sqliteFile).size : 0;
      const pgliteDir = path.join(this.opts.userDataPath, 'pglite-db');
      const pgliteDirBytes = fs.existsSync(pgliteDir) ? dirSizeBytes(pgliteDir) : 0;

      // Persist the manifest so a later "adopt" can do a cursor-based catch-up
      // copy of rows PGLite has gained since the dry-run.
      if (summary.manifest) {
        try {
          fs.writeFileSync(
            path.join(dryRunDir, DRY_RUN_MANIFEST_FILENAME),
            JSON.stringify(summary.manifest, null, 2),
          );
        } catch (manifestErr) {
          log('warn', '[dry-run] failed to write manifest', {
            err: (manifestErr as Error).message,
          });
        }
      }

      await sqlite.close();
      sqlite = null;

      reporter?.emitComplete(summary);

      const result: DryRunResult = {
        summary,
        dryRunDir,
        sqliteFileBytes,
        pgliteDirBytes,
      };

      // Default: keep the dry-run SQLite dir on success so the user can
      // optionally "adopt" it as their new active backend without re-running
      // the long migration. Tests pass keepArtifacts: false to override.
      if (this.opts.keepArtifacts === false) {
        try {
          fs.rmSync(dryRunDir, { recursive: true, force: true });
        } catch (rmErr) {
          log('warn', '[dry-run] failed to remove dry-run dir', {
            dryRunDir,
            err: (rmErr as Error).message,
          });
        }
      }

      log('info', '[dry-run] complete', {
        rowsCopied: summary.totalRowsCopied,
        durationMs: Math.round(summary.durationMs),
        sqliteFileBytes,
        pgliteDirBytes,
      });
      return result;
    } catch (err) {
      const message = (err as Error).message;
      const stack = (err as Error).stack;
      log('error', '[dry-run] failed', { message, stack });
      reporter?.emitFailed({ phase: 'dry-run', message, stack });

      try {
        if (sqlite) await sqlite.close();
      } catch { /* ignore */ }
      // Always clean up on failure — the dry-run dir is throwaway.
      try {
        fs.rmSync(dryRunDir, { recursive: true, force: true });
      } catch { /* ignore */ }

      throw err;
    }
  }
}

/**
 * Wrap a single-statement read-only worker into the multi-method
 * `PGLiteHandle` surface the migrator expects. `close()` is a no-op (we
 * don't own the worker) and `exec()` throws (the migrator never calls it on
 * dry-runs; throwing surfaces accidental misuse rather than silently doing
 * nothing).
 */
function buildReadOnlyAdapter(
  reader: LivePgliteReader,
  timeoutMs: number,
): PGLiteHandle {
  return {
    async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      return reader.queryReadOnly<T>(sql, params, timeoutMs);
    },
    async exec(_sql: string): Promise<unknown> {
      throw new Error('MigrationDryRunner adapter is read-only; exec() is not supported');
    },
    async close(): Promise<void> {
      // No-op: the live worker keeps running.
    },
  };
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
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
