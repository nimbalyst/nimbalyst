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
import { findDryRunArtifact } from '../database/sqlite/dryRunArtifact';
import { runMigrationOperation, migrationOperationSnapshot, dryRunCancellationBuffer, cancelMigrationDryRun } from '../database/migrationOperation';
import { app } from 'electron';
import * as path from 'path';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import {
  getLiveSqliteDatabaseProxy,
  getMigrationProxy,
  stopPeriodicBackupTimer,
} from '../database/initialize';
import {
  resolveBackend,
  readBackendState,
  clearMigrationBlocked,
  getMigrationBlockedState,
} from '../database/sqlite/BackendSelector';
import { classifyDatabaseError } from '../database/DatabaseErrorTelemetry';
import { buildMigrationDryRunCompletedProperties } from '../database/sqlite/migrationEventMapper';
import { abortRequiresRelaunch, asCutoverAbort } from '../database/sqlite/cutoverMachine';
import { readCutoverJournal } from '../database/sqlite/cutoverJournal';
import { runRollback } from '../database/sqlite/rollbackTransaction';
import { resolveDatabaseUserDataPath } from '../database/userDataPath';
import {
  currentDatabaseOperation,
  describeOperationConflict,
  withDatabaseOperationLock,
  type DatabaseOperationKind,
} from '../database/databaseOperationLock';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { randomUUID } from 'crypto';
import { beginDatabaseMaintenance, databaseRequiresRestart } from '../database/databaseMaintenance';
import * as fs from 'fs';

/**
 * Every handler below runs under `withDatabaseOperationLock`.
 *
 * The three module-level booleans this replaces (`runningMigration`,
 * `runningDryRun`, `runningAdopt`) excluded migration operations from each
 * other and from nothing else -- and not even reliably: `db:migration:start`
 * checked only its own flag, so a migration could begin while a dry run was
 * still reading the source. Meanwhile recovery and backup restore, which close
 * the same engine and rename the same directories, were not in the picture at
 * all. The shared lock is the whole exclusion set in one place; see
 * `database/databaseOperationLock.ts`.
 */
function conflict(heldBy: DatabaseOperationKind, heldSince: string) {
  return { success: false as const, error: describeOperationConflict(heldBy, heldSince) };
}

export function getSchemaDir(): string {
  // Main is bundled to out/main/index.js, so __dirname is the main bundle root
  // both in dev and packaged builds. Schemas are copied next to it by
  // viteStaticCopy in electron.vite.config.ts. Keep this in sync with
  // initialize.ts.
  return path.resolve(__dirname, 'sqlite', 'schemas');
}

function getUserDataPath(): string {
  return resolveDatabaseUserDataPath();
}

function completedDryRun(): { completedAt: string; totalRows: number; historyRowsQuarantined: number } | null {
  const found = findDryRunArtifact(getUserDataPath());
  return found ? { historyRowsQuarantined: found.manifest.perTable.find(t => t.name === 'document_history')?.rowsQuarantined ?? 0, completedAt: found.manifest.completedAt, totalRows: found.manifest.perTable.reduce((sum, table) => sum + table.rows, 0) } : null;
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
      let historyRowsQuarantined = 0;
      const live = getLiveSqliteDatabaseProxy();
      if (resolved.backend === 'sqlite' && live && !databaseRequiresRestart()) {
        const exists = await live.queryReadOnly("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migration_history_quarantine'");
        if (exists.rows.length) {
          const count = await live.queryReadOnly<{ n: number }>('SELECT count(*) AS n FROM migration_history_quarantine');
          historyRowsQuarantined = Number(count.rows[0]?.n ?? 0);
        }
      }
      return {
        success: true,
        historyRowsQuarantined,
        activeBackend: resolved.backend,
        flagState: state,
        pgliteDirExists: fs.existsSync(pgliteDir),
        sqliteDirExists: fs.existsSync(sqliteDir),
        migratedDirs,
        running: currentDatabaseOperation()?.kind === 'migration',
        operation: migrationOperationSnapshot(),
        dryRunAvailable: completedDryRun(),
        requiresRestart: databaseRequiresRestart(),
        runningDryRun: currentDatabaseOperation()?.kind === 'dry-run',
        // Typed durable refusal, so Settings can name the reason and offer a
        // retry instead of showing a boot that silently did nothing.
        migrationBlocked: getMigrationBlockedState(userDataPath),
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  safeHandle('db:migration:restart', async () => {
    if (!databaseRequiresRestart()) return { success: false };
    relaunchAfterReply();
    return { success: true };
  });

  safeHandle('db:migration:cancel-dry-run', async (_event, id: string) => ({ success: cancelMigrationDryRun(id) }));

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
    const held = await withDatabaseOperationLock('migration', () => runMigrationOperation('migration', async () => {
      const userDataPath = getUserDataPath();
      try {
        const proxy = await getMigrationProxy();
        // Analytics is emitted once, by the mapper the proxy hands the worker's
        // terminal domain result to. This handler used to emit its own
        // completed/failed pair on top of the orchestrator's.
        const { summary } = await proxy.startMigration({
          userDataPath,
          schemaDir: getSchemaDir(),
          operationId: randomUUID(),
          trigger: 'manual',
        });
        return { success: true as const, summary };
      } catch (err) {
        logger.main.error('[Migration] failed', err);
        // A cutover that got as far as closing PGLite leaves this process with
        // no database. Reporting the failure and carrying on -- which is what
        // this handler did -- means every later query runs against a closed
        // worker. Relaunch so startup can reconcile the journal.
        const journal = readCutoverJournal(userDataPath);
        if (databaseRequiresRestart() || abortRequiresRelaunch(asCutoverAbort(err), journal?.phase ?? null)) {
          logger.main.error(
            '[Migration] Cutover stopped after PGLite was closed; relaunching so startup can reconcile it',
            { phase: journal?.phase ?? 'no-journal', operationId: journal?.operationId },
          );
          relaunchAfterReply();
          return {
            success: false as const,
            error: (err as Error).message,
            requiresRelaunch: true as const,
          };
        }
        return { success: false as const, error: (err as Error).message };
      }
    }));
    return held.acquired ? held.value : conflict(held.heldBy, held.heldSince);
  });

  // ----- Dry run (alpha) ---------------------------------------------------
  // Runs the full migration into a throwaway directory while the user keeps
  // working. Returns real stats: row counts, per-table breakdown, duration,
  // FK + integrity status, on-disk SQLite size, and the pglite-db/ size for
  // comparison. Never touches pglite-db, never writes the flag.
  safeHandle('db:migration:dry-run', async () => {
    const held = await withDatabaseOperationLock('dry-run', () => runMigrationOperation('dry-run', async () => {
      try {
        const proxy = await getMigrationProxy();
        const { result } = await proxy.startDryRun({
          cancellation: dryRunCancellationBuffer(),
          userDataPath: getUserDataPath(),
          schemaDir: getSchemaDir(),
        });
        AnalyticsService.getInstance().sendEvent(
          'migration_dry_run_completed',
          buildMigrationDryRunCompletedProperties(result),
        );
        return { success: true as const, result };
      } catch (err) {
        const cancellation = dryRunCancellationBuffer();
        if (cancellation && Atomics.load(new Int32Array(cancellation), 0)) {
          logger.main.info('[Migration] Dry run cancelled; active database unchanged');
        } else {
          AnalyticsService.getInstance().sendEvent('migration_dry_run_failed', {
            ...classifyDatabaseError(err),
          });
        }
        return { success: false as const, error: (err as Error).message };
      }
    }));
    return held.acquired ? held.value : conflict(held.heldBy, held.heldSince);
  });

  // ----- Adopt dry-run (alpha) ---------------------------------------------
  // Promote the most recent successful dry-run SQLite into the active backend
  // via a cursor-based catch-up copy of anything PGLite has gained since the
  // dry-run ran. Avoids re-paying the full migration cost.
  safeHandle('db:migration:adopt-dry-run', async () => {
    const held = await withDatabaseOperationLock('adoption', () => runMigrationOperation('adoption', async () => {
      const userDataPath = getUserDataPath();
      try {
        const proxy = await getMigrationProxy();
        const { result } = await proxy.adoptDryRun({
          userDataPath,
          schemaDir: getSchemaDir(),
          operationId: randomUUID(),
          trigger: 'manual',
        });
        return { success: true as const, result };
      } catch (err) {
        logger.main.error('[Adopt] failed', err);
        // Adoption runs the same cutover, so it can close PGLite and stop for
        // the same reasons a migration can.
        const journal = readCutoverJournal(userDataPath);
        if (databaseRequiresRestart() || abortRequiresRelaunch(asCutoverAbort(err), journal?.phase ?? null)) {
          logger.main.error(
            '[Adopt] Cutover stopped after PGLite was closed; relaunching so startup can reconcile it',
            { phase: journal?.phase ?? 'no-journal', operationId: journal?.operationId },
          );
          relaunchAfterReply();
          return {
            success: false as const,
            error: (err as Error).message,
            requiresRelaunch: true as const,
          };
        }
        return { success: false as const, error: (err as Error).message };
      }
    }));
    return held.acquired ? held.value : conflict(held.heldBy, held.heldSince);
  });

  // Expose whether an adoptable dry-run exists, so the UI can show the button.
  safeHandle('db:migration:dry-run-status', async () => {
    try {
      const status = completedDryRun();
      return status ? { success: true, available: true, ...status } : { success: true, available: false };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  // Clear a durable refusal so the next launch re-assesses. User-initiated
  // only: the block exists because the product could not prove the source was
  // the user's data, and only the user can decide to override that.
  safeHandle('db:migration:clear-block', async () => {
    try {
      clearMigrationBlocked(getUserDataPath());
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  safeHandle('db:migration:rollback', async () => {
    const held = await withDatabaseOperationLock('rollback', () => runMigrationOperation('rollback', async () => {
      try {
        stopPeriodicBackupTimer();
        // Runs on main rather than in the SQLite worker. It is filesystem work
        // either way, but the journal, the backend flag and the worker handle
        // are all owned here, and the version that ran in the worker returned
        // *before* the flag was written -- so the gap between "the directories
        // have moved" and "the flag says so" spanned a postMessage hop.
        const result = await runRollback({
          userDataPath: getUserDataPath(),
          operationId: randomUUID(),
          quiesceSqlite: async () => {
            // The active SQLite worker owns the better-sqlite3 handle, so it
            // must be shut down before sqlite-db/ can be renamed. A close that
            // rejects aborts the rollback before anything moves.
            const liveSqlite = getLiveSqliteDatabaseProxy();
            if (liveSqlite) {
              beginDatabaseMaintenance();
              await liveSqlite.close();
            }
          },
          log: (level, msg, meta) => logger.main[level](msg, meta),
        });
        return { success: true as const, restoredFrom: path.basename(result.restoredFrom) };
      } catch (err) {
        logger.main.error('[Rollback] failed', err);
        return { success: false as const, error: (err as Error).message };
      }
    }));
    return held.acquired ? held.value : conflict(held.heldBy, held.heldSince);
  });

  logger.main.info('[MigrationHandlers] Registered');
}

/**
 * Relaunch, after the IPC reply has been posted. The renderer is about to be
 * torn down either way; letting it see the error first is what turns a silent
 * restart into an explicable one.
 */
function relaunchAfterReply(): void {
  setImmediate(() => {
    // Under Playwright a relaunch spawns an Electron the test runner does not
    // own; the spec asserts the on-disk state and launches again itself.
    if (process.env.PLAYWRIGHT !== '1') app.relaunch();
    app.quit();
  });
}
