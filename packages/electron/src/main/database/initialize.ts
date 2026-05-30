/**
 * Database Initialization Module
 * Handles PGLite database setup and migration on app startup
 */

import { app } from 'electron';
import * as fs from 'fs';
import path from 'path';
import { database, legacyPgliteDatabase } from './PGLiteDatabaseWorker';
import { resolveBackend } from './sqlite/BackendSelector';
import { SQLiteDatabaseProxy } from './sqlite/SQLiteDatabaseProxy';
import { logger } from '../utils/logger';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import type { SessionStore } from '@nimbalyst/runtime';
import { repositoryManager } from '../services/RepositoryManager';
import { DatabaseBackupService } from '../services/database/DatabaseBackupService';
import { SQLiteBackupService } from '../services/database/SQLiteBackupService';
import { checkWorktreeArchiveConsistency, createWorktreeStore } from '../services/WorktreeStore';
import { archiveProgressManager } from '../services/ArchiveProgressManager';
import { GitWorktreeService } from '../services/GitWorktreeService';
import { timeStartupPhase } from '../utils/startupTiming';

// Backup service instance — only used by the PGLite path now. The SQLite
// backend constructs SQLiteBackupService inside the worker during init, so
// nothing on main holds a reference.
let backupService: DatabaseBackupService | SQLiteBackupService | null = null;
let periodicBackupTimer: NodeJS.Timeout | null = null;
const BACKUP_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
let sqliteDatabase: SQLiteDatabaseProxy | null = null;
// Lazy-constructed SQLiteDatabaseProxy used by the migration IPC handlers
// when PGLite is the live backend. The migration code runs inside the
// SQLite worker; this proxy just gives main a handle to that worker.
let migrationProxy: SQLiteDatabaseProxy | null = null;

/**
 * Return a `SQLiteDatabaseProxy` configured for the migration pipeline.
 *
 * Migration only runs when PGLite is the live backend; if SQLite is already
 * live there's nothing to migrate. We throw in that case so the IPC handler
 * surfaces a sensible error instead of silently reusing the live proxy
 * (which doesn't have the PGLite reader/control wired up).
 *
 * Otherwise we lazily spawn a dedicated worker, inject the live PGLite
 * reader (so the orchestrator can pull source rows) and the control
 * handler (so it can ask main to close the PGLite worker before cutover).
 */
export async function getMigrationProxy(): Promise<SQLiteDatabaseProxy> {
  if (sqliteDatabase) {
    throw new Error('SQLite is already the active backend — nothing to migrate.');
  }
  if (!migrationProxy) {
    const userDataPath = process.env.NIMBALYST_USER_DATA_PATH
      || (process.env.PLAYWRIGHT === '1'
        ? path.join(app.getPath('temp'), 'nimbalyst-test-db')
        : null)
      || app.getPath('userData');
    const sqliteDir = path.join(userDataPath, 'sqlite-db');
    const schemaDir = path.resolve(__dirname, 'sqlite', 'schemas');
    migrationProxy = new SQLiteDatabaseProxy({ dbDir: sqliteDir, schemaDir });
    migrationProxy.setPgliteReader({
      queryReadOnly: <T>(sql: string, params?: unknown[], timeoutMs?: number) =>
        database.queryReadOnly<T>(sql, params as any[] | undefined, timeoutMs),
    });
    migrationProxy.setMigrationControl({
      closePglite: async () => {
        try {
          await database.close();
        } catch (err) {
          logger.main.warn('[Migration] PGLite close failed; proceeding anyway', err);
        }
      },
      onCutoverSuccess: async () => {
        // The renderer's existing "Continue" button asks the user to relaunch
        // so the new SQLite backend is picked up by repositoryManager. We
        // could also tear down the migration worker here to release file
        // handles, but the relaunch handles that cleanly.
        logger.main.info(
          '[Migration] Cutover complete; relaunch required for SQLite to take effect',
        );
      },
    });
    migrationProxy.ensureWorkerSpawned();
  }
  return migrationProxy;
}

/**
 * Initialize the database system
 * Should be called when the app is ready
 */
export async function initializeDatabase(): Promise<SessionStore> {
  if (repositoryManager.isInitialized()) {
    return repositoryManager.getSessionStore();
  }
  logger.main.info('[Database] Initializing database system...');

  try {
    // Get database path
    // NIMBALYST_USER_DATA_PATH: custom path (for manual testing of packaged builds)
    // PLAYWRIGHT=1: use temp directory (for automated tests)
    const userDataPath = process.env.NIMBALYST_USER_DATA_PATH
      || (process.env.PLAYWRIGHT === '1' ? path.join(app.getPath('temp'), 'nimbalyst-test-db') : null)
      || app.getPath('userData');
    const dbPath = path.join(userDataPath, 'pglite-db');

    // Resolve which storage backend should be active. The selector reads
    // <userData>/database-backend.json if present, otherwise infers from disk:
    //   - pglite-db/ exists  -> stay on PGLite (no flag written)
    //   - fresh install      -> SQLite (set by the migration flow)
    // For now the boot path always opens PGLite; the actual switchover is
    // a follow-up step in the migration plan (see service-layer audit).
    const backendChoice = resolveBackend({ userDataPath });
    logger.main.info(
      `[Database] Backend selector resolved to '${backendChoice.backend}' (reason: ${backendChoice.reason})`,
    );

    // Heartbeat: when SQLite is active but a preserved `pglite-db.migrated-*`
    // directory still exists, surface it so we can decide when to retire the
    // PGLite reader code. Per the plan, the rollback window stays open until
    // fleet telemetry shows < 1% of installs carry this directory.
    try {
      const migratedPresent = fs
        .readdirSync(userDataPath)
        .some((d) => d.startsWith('pglite-db.migrated-'));
      if (migratedPresent) {
        AnalyticsService.getInstance().sendEvent('pglite_legacy_dir_present', {
          active_backend: backendChoice.backend,
        });
      }
    } catch (heartbeatErr) {
      logger.main.warn('[Database] legacy-dir heartbeat failed', heartbeatErr);
    }

    if (backendChoice.backend === 'sqlite') {
      // SQLite runs in a worker_threads worker so synchronous better-sqlite3
      // calls never block the main process. The proxy holds the postMessage
      // channel and exposes the same `query/exec/queryReadOnly/...` surface
      // as the in-process SQLiteDatabase used in unit tests. The backup
      // service is constructed inside the worker during `init` — nothing on
      // main holds a reference to it; the proxy's getBackupService() is a
      // facade that forwards createBackup() through the worker.
      const sqliteDir = path.join(userDataPath, 'sqlite-db');
      const schemaDir = path.resolve(__dirname, 'sqlite', 'schemas');
      sqliteDatabase = new SQLiteDatabaseProxy({
        dbDir: sqliteDir,
        schemaDir,
      });
      database.useDatabase(sqliteDatabase, 'sqlite');
      await timeStartupPhase('SQLite.initialize', () => database.initialize());
      logger.main.info('[Database] SQLite initialized successfully (worker-hosted)');
    } else {
      backupService = new DatabaseBackupService(dbPath, legacyPgliteDatabase);
      await timeStartupPhase('BackupService.initialize', () => backupService!.initialize());
      legacyPgliteDatabase.setBackupService(backupService);
      database.useDatabase(legacyPgliteDatabase, 'pglite');
      await timeStartupPhase('PGLite.initialize', () => database.initialize());
      logger.main.info('[Database] PGLite initialized successfully');
    }

    logger.main.info('[Database] Backup service initialized', {
      backend: backendChoice.backend,
    });

    // Self-heal sessions left in a "claims complete, has zero events" state.
    // The migrator now NULLs canonical_* on copy, but earlier migrations
    // (and any other path that desyncs ai_sessions.canonical_transform_status
    // from ai_transcript_events) left users with the symptom that a session
    // opens to an empty transcript until the user manually right-click ->
    // "Reprocess transcript". Resetting the metadata here puts those
    // sessions back into the "never transformed" branch so the lazy
    // TranscriptTransformer.ensureUpToDate path regenerates events on first
    // open. Idempotent: NULLs only the rows that need it, no-op once healed.
    try {
      const repairResult = await database.query<{ id: string }>(
        `UPDATE ai_sessions
           SET canonical_transform_version = NULL,
               canonical_last_raw_message_id = NULL,
               canonical_last_transformed_at = NULL,
               canonical_transform_status = NULL
         WHERE canonical_transform_status = 'complete'
           AND NOT EXISTS (
             SELECT 1 FROM ai_transcript_events e WHERE e.session_id = ai_sessions.id
           )
         RETURNING id`,
      );
      if (repairResult.rows.length > 0) {
        logger.main.warn(
          `[Database] Reset canonical_transform_status on ${repairResult.rows.length} sessions whose canonical events table was empty (likely post-PGLite-migration). They will be re-transformed lazily on first open.`,
        );
      }
    } catch (repairErr) {
      // Don't block startup if the repair fails (e.g. on a backend that
      // doesn't support the query yet). The user-facing fallback is still
      // the per-session "Reprocess transcript" context-menu action.
      logger.main.error('[Database] Canonical transform metadata repair failed:', repairErr);
    }

    // Self-heal sessions whose metadata is the artifact of `{...stringValue}`
    // somewhere upstream -- the spread treated each char of a string as a
    // numeric-keyed property and serialized the whole thing back as JSON,
    // amplifying ~9x per write cycle until a single session metadata column
    // hit 216 MB in our worst observed case. The root-cause spread was a
    // SessionManager / provider-side `{ ...currentSession?.metadata }` over
    // an unparsed SQLite TEXT read; fixed at the read boundary in
    // PGLiteSessionStore.get / getMany / list and refused defensively in
    // updateMetadata. This startup pass is the data-side companion.
    //
    // Match shape: `{"0":"X","1":"Y","2":...` where X and Y are each a
    // single character (possibly an escaped quote `\\"`). A legitimate
    // metadata with a literal `"0"` key would almost never have neighbours
    // `"1"` and `"2"` whose values are single chars; the spread artifact
    // always does. Size-agnostic so we also clean up rows that are mid-
    // amplification at a few KB rather than waiting for them to grow to
    // hundreds of MB (the prior threshold required > 100 KB).
    try {
      // Any metadata that starts with `{"0":` AND has both `"1":` and `"2":`
      // appearing later is the spread artifact -- legitimate metadata would
      // need to deliberately use stringified integers as the first three
      // top-level keys, which the runtime never does. Earlier versions of
      // this query used `_` (single-char) wildcards inside the value
      // positions, which failed to match when the spread happened to pick
      // up an escaped char (backslash + quote = two bytes) as a single
      // value -- so an actively-corrupted row sat through restart unwiped.
      // SQL `%` is a multi-char wildcard so this catches any value shape.
      const wipeResult = await database.query<{ id: string; len: number }>(
        `UPDATE ai_sessions
           SET metadata = '{}'
         WHERE metadata LIKE '{"0":%"1":%"2":%'
         RETURNING id, LENGTH(metadata) AS len`,
      );
      if (wipeResult.rows.length > 0) {
        const sizes = wipeResult.rows
          .map((r) => `${r.id.slice(0, 8)}=${r.len}B`)
          .join(', ');
        logger.main.warn(
          `[Database] Wiped corrupted metadata on ${wipeResult.rows.length} sessions (spread-of-string artifact). Sizes: ${sizes}. Their tokenUsage / kanban tags / etc. will repopulate on next streaming chunk.`,
        );
      }
    } catch (wipeErr) {
      logger.main.error('[Database] Corrupted-metadata wipe failed:', wipeErr);
    }

    // Initialize all repositories
    await timeStartupPhase('RepositoryManager.initialize', () => repositoryManager.initialize());
    const sessionStore = repositoryManager.getSessionStore();
    logger.main.info('[Database] All repositories initialized');

    // Run worktree archive consistency check
    // This handles cases where the app crashed between archiving sessions and marking worktree as archived
    try {
      const consistencyResults = await checkWorktreeArchiveConsistency(database);
      if (consistencyResults.length > 0) {
        logger.main.warn('[Database] Worktree archive consistency issues resolved:', consistencyResults);
      }
    } catch (consistencyError) {
      // Don't fail startup if consistency check fails
      logger.main.error('[Database] Worktree archive consistency check failed:', consistencyError);
    }

    // Load persisted archive queue tasks
    // This handles cases where the app crashed while processing archive cleanup
    try {
      const gitWorktreeService = new GitWorktreeService();
      const worktreeStore = createWorktreeStore(database);

      const { recovered, failed } = await archiveProgressManager.loadPersistedTasks(
        async (worktreeId: string, worktreeName: string) => {
          // Look up the worktree to get necessary context
          const worktree = await worktreeStore.get(worktreeId);
          if (!worktree) {
            logger.main.warn('[Database] Worktree not found for persisted archive task', { worktreeId });
            return null;
          }

          // If worktree is already archived, no callback needed
          if (worktree.isArchived) {
            logger.main.info('[Database] Worktree already archived, skipping persisted task', { worktreeId });
            return null;
          }

          // Create cleanup callback that mirrors the original archive flow
          return async () => {
            archiveProgressManager.updateTaskStatus(worktreeId, 'removing-worktree');

            // Delete the worktree from disk
            await gitWorktreeService.deleteWorktree(worktree.path, worktree.projectPath);

            logger.main.info('[Database] Recovered archive task cleanup completed', { worktreeId });

            // Mark as archived in database
            await worktreeStore.updateArchived(worktreeId, true);

            logger.main.info('[Database] Recovered archive task marked as archived', { worktreeId });
          };
        }
      );

      if (recovered > 0 || failed > 0) {
        logger.main.info('[Database] Archive queue recovery completed', { recovered, failed });
      }
    } catch (archiveQueueError) {
      // Don't fail startup if archive queue recovery fails
      logger.main.error('[Database] Archive queue recovery failed:', archiveQueueError);
    }

    // Get database stats
    const stats = await timeStartupPhase('Database.getStats', () => database.getStats());
    logger.main.info('[Database] Database stats:', stats);

    // Start periodic backup timer (only in production, not in tests)
    if (process.env.PLAYWRIGHT !== '1') {
      periodicBackupTimer = setInterval(async () => {
        logger.main.info('[Database] Running periodic backup...');
        const result = await database.createBackup();
        if (result.success) {
          logger.main.info('[Database] Periodic backup completed successfully');
        } else {
          logger.main.warn('[Database] Periodic backup failed:', result.error);
        }
      }, BACKUP_INTERVAL_MS);

      logger.main.info(`[Database] Periodic backup enabled (every ${BACKUP_INTERVAL_MS / (60 * 60 * 1000)} hours)`);
    }

    // Note: Database backup on quit is handled in main/index.ts before-quit handler
    // This ensures it integrates properly with the quit sequence and force-quit timer

    logger.main.info('[Database] Database system ready');

    return sessionStore;
  } catch (error) {
    logger.main.error('[Database] Failed to initialize database:', error);
    // Don't throw in production - fall back to electron-store
    if (process.env.NODE_ENV === 'development') {
      throw error;
    }
    throw error;
  }
}

export function getRuntimeSessionStore(): SessionStore | null {
  return repositoryManager.isInitialized() ? repositoryManager.getSessionStore() : null;
}

/**
 * Get database instance (for other modules)
 */
export function getDatabase() {
  return database;
}

export function getLiveSqliteDatabaseProxy(): SQLiteDatabaseProxy | null {
  return sqliteDatabase;
}

/**
 * Stop the periodic-backup interval. Must be called before db.close() during
 * shutdown, otherwise the timer can fire after the SQLite handle is closed
 * and throws "The database connection is not open" from inside the better-
 * sqlite3 Online Backup API's setImmediate-driven step loop.
 */
export function stopPeriodicBackupTimer(): void {
  if (periodicBackupTimer) {
    clearInterval(periodicBackupTimer);
    periodicBackupTimer = null;
  }
}

// Export database directly for protocol server
export { database };
