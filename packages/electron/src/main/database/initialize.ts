/**
 * Database Initialization Module
 * Handles PGLite database setup and migration on app startup
 */

import { app } from 'electron';
import path from 'path';
import { database } from './PGLiteDatabaseWorker';
import { logger } from '../utils/logger';
import type { SessionStore } from '@nimbalyst/runtime';
import { repositoryManager } from '../services/RepositoryManager';
import { DatabaseBackupService } from '../services/database/DatabaseBackupService';
import { checkWorktreeArchiveConsistency, createWorktreeStore } from '../services/WorktreeStore';
import { archiveProgressManager } from '../services/ArchiveProgressManager';
import { GitWorktreeService } from '../services/GitWorktreeService';
import { timeStartupPhase } from '../utils/startupTiming';

// Backup service instance
let backupService: DatabaseBackupService | null = null;
let periodicBackupTimer: NodeJS.Timeout | null = null;
const BACKUP_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Initialize the database system
 * Should be called when the app is ready
 */
export async function initializeDatabase(): Promise<SessionStore> {
  if (repositoryManager.isInitialized()) {
    return repositoryManager.getSessionStore();
  }
  logger.main.info('[Database] Initializing PGLite database system...');

  try {
    // Get database path
    // NIMBALYST_USER_DATA_PATH: custom path (for manual testing of packaged builds)
    // PLAYWRIGHT=1: use temp directory (for automated tests)
    const userDataPath = process.env.NIMBALYST_USER_DATA_PATH
      || (process.env.PLAYWRIGHT === '1' ? path.join(app.getPath('temp'), 'nimbalyst-test-db') : null)
      || app.getPath('userData');
    const dbPath = path.join(userDataPath, 'pglite-db');

    // Initialize backup service
    backupService = new DatabaseBackupService(dbPath, database);
    await timeStartupPhase('BackupService.initialize', () => backupService!.initialize());
    logger.main.info('[Database] Backup service initialized');

    // Set backup service on database instance
    database.setBackupService(backupService);

    // Initialize PGLite database
    await timeStartupPhase('PGLite.initialize', () => database.initialize());
    logger.main.info('[Database] PGLite initialized successfully');

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

// Export database directly for protocol server
export { database };
