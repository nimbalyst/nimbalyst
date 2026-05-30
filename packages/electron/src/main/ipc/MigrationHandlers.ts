/**
 * IPC channels that drive the PGLite → SQLite migration UI from Settings.
 *
 * Renderer-side flow:
 *   1. Open Settings → Database → "Migrate to SQLite"
 *   2. Renderer invokes `db:migration:get-status` to populate the pane.
 *   3. Renderer invokes `db:migration:preflight` before showing "Start".
 *   4. Renderer invokes `db:migration:start` to kick off the orchestrator.
 *   5. The SQLite worker (driven via `SQLiteDatabaseProxy`) runs the
 *      orchestrator and emits `db:migration:progress` / `db:migration:phase`
 *      / `db:migration:complete` / `db:migration:failed`. The proxy fans
 *      those out to every BrowserWindow.
 *
 * This file is now a thin shim — the orchestrator, dry-runner and adopter
 * all live inside the SQLite worker so the synchronous bulk copy never
 * blocks main. We keep the IPC channel names and response shapes intact so
 * the renderer (`DatabasePanel.tsx`) doesn't change.
 */
import { app } from 'electron';
import * as path from 'path';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import {
  getLiveSqliteDatabaseProxy,
  getMigrationProxy,
  stopPeriodicBackupTimer,
} from '../database/initialize';
import { resolveBackend, readBackendState, commitRollbackToPglite } from '../database/sqlite/BackendSelector';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import * as fs from 'fs';

let runningMigration = false;
let runningDryRun = false;
let runningAdopt = false;

export function getSchemaDir(): string {
  // Main is bundled to out/main/index.js, so __dirname is the main bundle root
  // both in dev and packaged builds. Schemas are copied next to it by
  // viteStaticCopy in electron.vite.config.ts. Keep this in sync with
  // initialize.ts.
  return path.resolve(__dirname, 'sqlite', 'schemas');
}

function getUserDataPath(): string {
  return (
    process.env.NIMBALYST_USER_DATA_PATH
    || app.getPath('userData')
  );
}

export function registerMigrationHandlers(): void {
  safeHandle('db:migration:get-status', async () => {
    try {
      const userDataPath = getUserDataPath();
      const resolved = resolveBackend({ userDataPath });
      const state = readBackendState(userDataPath);
      const pgliteDir = path.join(userDataPath, 'pglite-db');
      const sqliteDir = path.join(userDataPath, 'sqlite-db');
      const migratedDirs = fs
        .readdirSync(userDataPath)
        .filter((d) => d.startsWith('pglite-db.migrated-'));
      return {
        success: true,
        activeBackend: resolved.backend,
        flagState: state,
        pgliteDirExists: fs.existsSync(pgliteDir),
        sqliteDirExists: fs.existsSync(sqliteDir),
        migratedDirs,
        running: runningMigration,
        runningDryRun,
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  safeHandle('db:migration:preflight', async () => {
    try {
      const proxy = await getMigrationProxy();
      const result = await proxy.migrationPreflight({
        userDataPath: getUserDataPath(),
        schemaDir: getSchemaDir(),
      });
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  safeHandle('db:migration:start', async () => {
    if (runningMigration) {
      return { success: false, error: 'Migration already running.' };
    }
    runningMigration = true;
    try {
      const proxy = await getMigrationProxy();
      const { summary } = await proxy.startMigration({
        userDataPath: getUserDataPath(),
        schemaDir: getSchemaDir(),
      });
      AnalyticsService.getInstance().sendEvent('migration_completed', {
        target_row_count: summary.totalRowsCopied,
        duration_ms: Math.round(summary.durationMs),
        tables_migrated: summary.tablesCopied.length,
        spot_check_count: summary.spotCheckCount,
        foreign_key_violations: summary.foreignKeyViolations,
        integrity_check: summary.integrityCheck,
      });
      return { success: true, summary };
    } catch (err) {
      logger.main.error('[Migration] failed', err);
      AnalyticsService.getInstance().sendEvent('migration_failed', {
        message: (err as Error).message.slice(0, 500),
      });
      return { success: false, error: (err as Error).message };
    } finally {
      runningMigration = false;
    }
  });

  // ----- Dry run (alpha) ---------------------------------------------------
  // Runs the full migration into a throwaway directory while the user keeps
  // working. Returns real stats: row counts, per-table breakdown, duration,
  // FK + integrity status, on-disk SQLite size, and the pglite-db/ size for
  // comparison. Never touches pglite-db, never writes the flag.
  safeHandle('db:migration:dry-run', async () => {
    if (runningDryRun) {
      return { success: false, error: 'Dry run already in progress.' };
    }
    if (runningMigration) {
      return { success: false, error: 'A real migration is in progress; dry run is unavailable.' };
    }
    runningDryRun = true;
    try {
      const proxy = await getMigrationProxy();
      const { result } = await proxy.startDryRun({
        userDataPath: getUserDataPath(),
        schemaDir: getSchemaDir(),
      });
      AnalyticsService.getInstance().sendEvent('migration_dry_run_completed', {
        target_row_count: result.summary.totalRowsCopied,
        duration_ms: Math.round(result.summary.durationMs),
        tables_migrated: result.summary.tablesCopied.length,
        sqlite_file_bytes: result.sqliteFileBytes,
        pglite_dir_bytes: result.pgliteDirBytes,
        foreign_key_violations: result.summary.foreignKeyViolations,
        integrity_check: result.summary.integrityCheck,
      });
      return { success: true, result };
    } catch (err) {
      AnalyticsService.getInstance().sendEvent('migration_dry_run_failed', {
        message: (err as Error).message.slice(0, 500),
      });
      return { success: false, error: (err as Error).message };
    } finally {
      runningDryRun = false;
    }
  });

  // ----- Adopt dry-run (alpha) ---------------------------------------------
  // Promote the most recent successful dry-run SQLite into the active backend
  // via a cursor-based catch-up copy of anything PGLite has gained since the
  // dry-run ran. Avoids re-paying the full migration cost.
  safeHandle('db:migration:adopt-dry-run', async () => {
    if (runningAdopt || runningMigration || runningDryRun) {
      return { success: false, error: 'Another migration operation is in progress.' };
    }
    runningAdopt = true;
    try {
      const proxy = await getMigrationProxy();
      const { result } = await proxy.adoptDryRun({
        userDataPath: getUserDataPath(),
        schemaDir: getSchemaDir(),
      });
      AnalyticsService.getInstance().sendEvent('migration_adopted_dry_run', {
        rows_added: result.rowsAdded,
        duration_ms: Math.round(result.durationMs),
      });
      return { success: true, result };
    } catch (err) {
      logger.main.error('[Adopt] failed', err);
      AnalyticsService.getInstance().sendEvent('migration_adopt_failed', {
        message: (err as Error).message.slice(0, 500),
      });
      return { success: false, error: (err as Error).message };
    } finally {
      runningAdopt = false;
    }
  });

  // Expose whether an adoptable dry-run exists, so the UI can show the button.
  safeHandle('db:migration:dry-run-status', async () => {
    try {
      const proxy = await getMigrationProxy();
      const status = await proxy.dryRunStatus({
        userDataPath: getUserDataPath(),
        schemaDir: getSchemaDir(),
      });
      if (!status.available) return { success: true, available: false };
      return {
        success: true,
        available: true,
        completedAt: status.completedAt,
        totalRows: status.totalRows,
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  safeHandle('db:migration:rollback', async () => {
    try {
      stopPeriodicBackupTimer();
      const liveSqlite = getLiveSqliteDatabaseProxy();
      let proxy = liveSqlite;
      if (liveSqlite) {
        // The active SQLite worker owns the better-sqlite3 handle, so it must
        // be shut down before we can rename sqlite-db/ during rollback.
        await liveSqlite.close();
        proxy = liveSqlite;
      }
      if (!proxy) {
        proxy = await getMigrationProxy();
      }
      const { restoredFrom } = await proxy.rollback({ userDataPath: getUserDataPath() });
      commitRollbackToPglite(getUserDataPath());
      return { success: true, restoredFrom };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  logger.main.info('[MigrationHandlers] Registered');
}
