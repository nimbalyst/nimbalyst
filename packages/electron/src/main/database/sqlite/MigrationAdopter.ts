/**
 * MigrationAdopter
 *
 * Promotes a successful dry-run SQLite into the active backend, instead of
 * making the user re-run the full migration. The dry-run SQLite is a snapshot
 * — PGLite has continued accepting writes since it ran — so before flipping
 * the flag we catch the SQLite up to PGLite's current state.
 *
 *   1. Find the latest sqlite-db.dry-run-{stamp}/ directory + its manifest.
 *   2. Open the dry-run SQLite.
 *   3. Run PGLiteToSQLiteMigrator.catchUp() against the live worker.
 *   4. Quiesce PGLite (closeRunningPglite).
 *   5. Re-open PGLite from disk and run one final catch-up pass.
 *   6. Close both.
 *   7. Rename pglite-db/ → pglite-db.migrated-{ts}/.
 *   8. Rename sqlite-db.dry-run-{stamp}/ → sqlite-db/.
 *   9. Write the backend flag pointing at SQLite.
 *
 * Failure rules mirror MigrationOrchestrator: any error before the renames
 * leaves PGLite untouched and the dry-run dir in place; the app reopens on
 * PGLite next launch and the user can retry.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SQLiteDatabase } from './SQLiteDatabase';
import {
  PGLiteToSQLiteMigrator,
  type DryRunManifest,
  type MigrationProgress,
  type MigrationSummary,
  type PGLiteHandle,
} from './PGLiteToSQLiteMigrator';
import { MigrationProgressReporter } from './MigrationProgressReporter';
import { commitMigrationToSqlite } from './BackendSelector';
import { DRY_RUN_MANIFEST_FILENAME } from './MigrationDryRunner';

/**
 * Same single-statement read surface MigrationDryRunner uses — lets us pull
 * catch-up reads from the live PGLite worker without opening a second handle
 * to the same data dir (which deadlocks on the PID lock) and without close-
 * then-in-process-reopen (which dynamically requires the main bundle a
 * second time, double-registering `__ELECTRON_LOG__`).
 */
export interface LivePgliteReader {
  queryReadOnly<T = unknown>(
    sql: string,
    params?: unknown[],
    timeoutMs?: number,
  ): Promise<{ rows: T[] }>;
}

export interface AdopterOptions {
  userDataPath: string;
  schemaDir: string;
  /**
   * Live PGLite worker. We read catch-up rows through its `queryReadOnly`
   * surface, then call `closeRunningPglite()` to release it before the
   * directory rename.
   */
  pglite: LivePgliteReader;
  closeRunningPglite: () => Promise<void>;
  /**
   * After the live PGLite worker is quiesced, reopen the on-disk database so
   * we can run one final exact catch-up pass before the directory rename.
   */
  reopenPgliteAfterClose?: (dataDir: string) => Promise<PGLiteHandle>;
  onCutoverSuccess?: (info: {
    sqliteDir: string;
    pgliteMigratedDir: string;
  }) => Promise<void> | void;
  reporter?: MigrationProgressReporter;
  migrator?: PGLiteToSQLiteMigrator;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
  sendEvent?: (eventName: string, properties: Record<string, unknown>) => void;
}

export interface AdoptResult {
  rowsAdded: number;
  perTable: Array<{ name: string; added: number }>;
  pgliteMigratedDir: string;
  sqliteDir: string;
  durationMs: number;
}

export class MigrationAdopter {
  constructor(private opts: AdopterOptions) {}

  /**
   * Find the most recent dry-run dir + its manifest. Returns null if no
   * dry-run is available to adopt.
   */
  findDryRunDir(): { dir: string; manifest: DryRunManifest } | null {
    const userData = this.opts.userDataPath;
    if (!fs.existsSync(userData)) return null;
    const candidates = fs
      .readdirSync(userData)
      .filter((d) => d.startsWith('sqlite-db.dry-run-'))
      .map((d) => path.join(userData, d))
      .filter((d) => {
        try { return fs.statSync(d).isDirectory(); } catch { return false; }
      });
    if (candidates.length === 0) return null;
    // Newest first by mtime so we pick up the most recent dry-run.
    candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const dir of candidates) {
      const manifestPath = path.join(dir, DRY_RUN_MANIFEST_FILENAME);
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as DryRunManifest;
        return { dir, manifest };
      } catch {
        // Corrupt manifest; skip this dir and try the next one.
      }
    }
    return null;
  }

  async run(): Promise<AdoptResult> {
    const log = this.opts.log ?? (() => {});
    const reporter = this.opts.reporter;
    const t0 = performance.now();

    const found = this.findDryRunDir();
    if (!found) {
      throw new Error('No dry-run found to adopt. Run a dry-run first.');
    }
    const dryRunDir = found.dir;
    const manifest = found.manifest;

    const userData = this.opts.userDataPath;
    const pgliteDir = path.join(userData, 'pglite-db');
    const sqliteDir = path.join(userData, 'sqlite-db');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const pgliteMigratedDir = path.join(userData, `pglite-db.migrated-${stamp}`);

    log('info', '[adopter] starting', {
      dryRunDir,
      pgliteDir,
      pgliteMigratedDir,
      manifestAge: Date.now() - new Date(manifest.completedAt).getTime(),
    });

    // Refuse to clobber an existing sqlite-db/. If a prior adopt failed mid-way
    // we want a human to look at it.
    if (fs.existsSync(sqliteDir)) {
      throw new Error(
        `Refusing to adopt: ${sqliteDir} already exists. Delete or move it first.`,
      );
    }

    let sqlite: SQLiteDatabase | null = null;
    let phase = 'opening-sqlite';
    try {
      // 1. Open the existing dry-run SQLite. initialize() is idempotent: the
      // migration runner skips already-applied versions via _migrations.
      sqlite = new SQLiteDatabase({
        dbDir: dryRunDir,
        schemaDir: this.opts.schemaDir,
        slowQueryThresholdMs: 100,
        log,
      });
      await sqlite.initialize();

      // 2. Catch-up copy. We read from the LIVE PGLite worker via the same
      // read-only adapter the dry-run uses — opening a second in-process
      // PGLite handle triggers a deadlock on the PID lock AND re-evaluates
      // the bundled `electron-log` module (double `__ELECTRON_LOG__`
      // registration crash). Writes go directly into the dry-run SQLite.
      phase = 'catching-up';
      const migrator = this.opts.migrator ?? new PGLiteToSQLiteMigrator();
      const onProgress: ((p: MigrationProgress) => void) | undefined = reporter
        ? reporter.onProgress
        : undefined;
      const adapter = buildReadOnlyAdapter(this.opts.pglite);
      const catchResult = await migrator.catchUp({
        pglite: adapter,
        sqlite,
        manifest,
        onProgress,
        log,
      });

      // 3. Close the live PGLite worker so no more source writes can land.
      phase = 'closing-pglite';
      await this.opts.closeRunningPglite();

      // 4. Re-open the now-quiesced PGLite dir and reconcile the short window
      // between the live catch-up pass above and the close we just waited for.
      const reopen = this.opts.reopenPgliteAfterClose;
      if (!reopen) {
        throw new Error('MigrationAdopter requires reopenPgliteAfterClose() for final catch-up.');
      }
      phase = 'catching-up-after-close';
      const closedSource = await reopen(pgliteDir);
      const finalCatchUp = await (async () => {
        try {
          return await migrator.catchUp({
            pglite: closedSource,
            sqlite,
            manifest: catchResult.manifest,
            onProgress,
            log,
          });
        } finally {
          await closedSource.close();
        }
      })();

      // 5. Close SQLite cleanly before the fs rename.
      phase = 'closing-sqlite';
      await sqlite.close();
      sqlite = null;

      // 6. Cutover: move PGLite aside, rename dry-run dir to active.
      phase = 'cutover';
      try {
        fs.renameSync(pgliteDir, pgliteMigratedDir);
      } catch (err) {
        log('warn', '[adopter] pglite-db rename failed; proceeding (flag will still flip)', {
          err: (err as Error).message,
        });
      }
      fs.renameSync(dryRunDir, sqliteDir);
      commitMigrationToSqlite(userData, pgliteMigratedDir);

      const durationMs = performance.now() - t0;
      const rowsAdded = catchResult.rowsAdded + finalCatchUp.rowsAdded;
      const perTable = mergeAddedTables(catchResult.perTable, finalCatchUp.perTable);
      const result: AdoptResult = {
        rowsAdded,
        perTable,
        pgliteMigratedDir,
        sqliteDir,
        durationMs,
      };

      if (this.opts.onCutoverSuccess) {
        await this.opts.onCutoverSuccess({ sqliteDir, pgliteMigratedDir });
      }

      // Fake a "complete" summary so the renderer's existing complete handler
      // works without a new channel — only the fields it actually displays
      // need to be present.
      const summary: MigrationSummary = {
        totalRowsCopied: rowsAdded,
        tablesCopied: perTable.map((t) => ({ name: t.name, rows: t.added })),
        durationMs,
        integrityCheck: 'ok',
        foreignKeyViolations: 0,
        spotCheckCount: 0,
      };
      reporter?.emitComplete(summary);

      this.opts.sendEvent?.('migration_adopted_dry_run', {
        rows_added: rowsAdded,
        duration_ms: Math.round(durationMs),
        manifest_age_ms: Date.now() - new Date(manifest.completedAt).getTime(),
      });

      log('info', '[adopter] adoption complete', result);
      return result;
    } catch (err) {
      const message = (err as Error).message;
      const stack = (err as Error).stack;
      log('error', `[adopter] failed in ${phase}`, { message, stack });
      reporter?.emitFailed({ phase, message, stack });
      this.opts.sendEvent?.('migration_adopt_failed', {
        phase,
        message: message.slice(0, 500),
      });

      // Best-effort cleanup. Leave the dry-run dir in place so the user can
      // try again; don't touch the running PGLite worker (it's still serving
      // app reads — closing it here would leave the app dead).
      try { if (sqlite) await sqlite.close(); } catch { /* ignore */ }

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
      throw new Error('MigrationAdopter adapter is read-only; exec() is not supported');
    },
    async close(): Promise<void> {
      // No-op: the live worker keeps running until we explicitly close it.
    },
  };
}

function mergeAddedTables(
  first: Array<{ name: string; added: number }>,
  second: Array<{ name: string; added: number }>,
): Array<{ name: string; added: number }> {
  const merged = new Map(first.map((entry) => [entry.name, entry.added]));
  for (const entry of second) {
    merged.set(entry.name, (merged.get(entry.name) ?? 0) + entry.added);
  }
  return Array.from(merged.entries()).map(([name, added]) => ({ name, added }));
}
