/**
 * WorktreeHandlers - IPC handlers for git worktree operations
 *
 * Provides handlers for creating, querying, and deleting git worktrees.
 * Worktrees are stored in the database and managed via GitWorktreeService.
 */

import { ipcMain, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import simpleGit from 'simple-git';
import { FeatureUsageService, FEATURES } from '../services/FeatureUsageService';
import { GitWorktreeService } from '../services/GitWorktreeService';
import { WorktreeStore, createWorktreeStore } from '../services/WorktreeStore';
import { createSuperLoopStore } from '../services/SuperLoopStore';
import { getDatabase } from '../database/initialize';
import { archiveProgressManager } from '../services/ArchiveProgressManager';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { ProviderFactory } from '@nimbalyst/runtime/ai/server';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { getTerminalSessionManager } from '../services/TerminalSessionManager';
import { getTerminalsByWorktreeId, deleteTerminalInstance } from '../utils/terminalStore';
import { gitRefWatcher } from '../file/GitRefWatcher';
import type { WorktreeCreateResult } from '../../shared/ipc/types';
import { gitOperationLock } from '../services/GitOperationLock';
import fs from 'node:fs';
import { archiveSessionsAndDestroyProviders } from '../services/ai/archiveSessionProviderLifecycle';

const logger = log.scope('WorktreeHandlers');

/**
 * Create a concurrency limiter that allows at most `limit` async operations at once.
 * Queued operations run in FIFO order as slots free up.
 */
function createConcurrencyLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>(resolve => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/**
 * Emit git status changed event to all windows
 */
function emitGitStatusChanged(workspacePath: string): void {
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('git:status-changed', { workspacePath });
    }
  }
}

/**
 * Emit terminal list changed event to all windows
 * Used when terminals are deleted (e.g., when archiving a worktree)
 */
function emitTerminalListChanged(workspacePath: string): void {
  const windows = BrowserWindow.getAllWindows();
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('terminal:list-changed', { workspacePath });
    }
  }
}

async function archiveSessionsForWorktree(
  worktreeId: string,
  sessionIds: string[],
  archiveLogger: ReturnType<typeof log.scope>
): Promise<number> {
  const result = await archiveSessionsAndDestroyProviders(sessionIds, {
    archiveSession: async (sessionId) => {
      await AISessionsRepository.updateMetadata(sessionId, { isArchived: true });
    },
    destroyProvider: (sessionId) => ProviderFactory.destroyProvider(sessionId),
    onArchiveError: (sessionId, error) => {
      archiveLogger.error('Failed to archive session', { sessionId, worktreeId, error });
    },
    onProviderCleanupError: (sessionId, error) => {
      archiveLogger.error('Failed to destroy archived session provider', {
        sessionId,
        worktreeId,
        error,
      });
    },
  });

  if (result.providerCleanupFailures > 0) {
    archiveLogger.warn('Some archived session providers failed to clean up', {
      worktreeId,
      failedCount: result.providerCleanupFailures,
      totalCount: sessionIds.length,
    });
  }

  return result.archiveFailures;
}

/**
 * Archive a single worktree and its sessions.
 *
 * Extracted from the worktree:archive IPC handler so it can be reused
 * by blitz:archive to properly clean up child worktrees (kill terminals,
 * stop watchers, delete from disk).
 *
 * Returns immediately after queuing disk cleanup - doesn't wait for it.
 */
export async function archiveWorktree(worktreeId: string, workspacePath: string): Promise<{ success: boolean; error?: string }> {
  const archiveLogger = log.scope('archiveWorktree');

  try {
    if (!worktreeId) {
      throw new Error('worktreeId is required');
    }

    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    archiveLogger.info('Archiving worktree', { worktreeId, workspacePath });

    // Get worktree from database
    const db = getDatabase();
    if (!db) {
      throw new Error('Database not initialized');
    }

    const worktreeStore = createWorktreeStore(db);
    const superLoopStore = createSuperLoopStore(db);
    const worktree = await worktreeStore.get(worktreeId);

    if (!worktree) {
      throw new Error(`Worktree not found: ${worktreeId}`);
    }

    // Security: Verify that the worktree belongs to the specified workspace
    if (worktree.projectPath !== workspacePath) {
      throw new Error(
        `Security violation: Worktree project path (${worktree.projectPath}) does not match workspace path (${workspacePath})`
      );
    }

    const sessionIds = await worktreeStore.getWorktreeSessions(worktreeId);

    // Already archived - but only skip if the directory is actually gone.
    // We still reconcile linked sessions because older partial failures could
    // leave the worktree archived while one or more sessions remain visible.
    if (worktree.isArchived) {
      if (!fs.existsSync(worktree.path)) {
        const failedSessions = await archiveSessionsForWorktree(worktreeId, sessionIds, archiveLogger);
        if (failedSessions > 0) {
          throw new Error(`Failed to archive ${failedSessions} lingering session(s) for archived worktree ${worktreeId}`);
        }
        const existingLoop = await superLoopStore.getLoopByWorktreeId(worktreeId);
        if (existingLoop && !existingLoop.isArchived) {
          await superLoopStore.updateLoop(existingLoop.id, { isArchived: true });
        }
        archiveLogger.info('Worktree already archived and directory removed, skipping', { worktreeId });
        return { success: true };
      }
      // Directory still exists despite being marked archived - re-run cleanup
      archiveLogger.info('Worktree marked as archived but directory still exists, re-running cleanup', { worktreeId, path: worktree.path });
      // Reset the archived flag so the cleanup flow can set it properly after disk deletion
      await worktreeStore.updateArchived(worktreeId, false);
    }

    const gitWorktreeService = new GitWorktreeService();

    // Step 1: Get all sessions for this worktree
    archiveLogger.info('Found sessions for worktree', { worktreeId, sessionCount: sessionIds.length });

    // Get worktree git status for analytics (before archiving)
    let hasUncommittedChanges = false;
    let hasUnmergedChanges = false;
    try {
      const gitStatus = await gitWorktreeService.getWorktreeStatus(worktree.path, worktree.baseBranch);
      hasUncommittedChanges = gitStatus.hasUncommittedChanges;
      hasUnmergedChanges = !gitStatus.isMerged;
    } catch (statusError) {
      archiveLogger.warn('Failed to get worktree status for analytics', { worktreeId, error: statusError });
    }

    // Step 2: Kill any running terminal processes for these sessions
    const terminalManager = getTerminalSessionManager();
    await terminalManager.destroyTerminalsForSessions(sessionIds);
    archiveLogger.info('Destroyed terminal processes for worktree sessions', { worktreeId });

    // Stop the git ref watcher for this worktree (it's being archived/deleted)
    await gitRefWatcher.stop(worktree.path);

    // Step 2b: Delete terminals associated with this worktree
    // Terminals have a worktreeId field that links them to the worktree.
    // When the worktree is archived, these terminals become orphaned and will
    // fail to start (cwd doesn't exist), so we clean them up here.
    const worktreeTerminalIds = getTerminalsByWorktreeId(workspacePath, worktreeId);
    if (worktreeTerminalIds.length > 0) {
      archiveLogger.info('Deleting terminals associated with worktree', { worktreeId, terminalCount: worktreeTerminalIds.length });
      for (const terminalId of worktreeTerminalIds) {
        try {
          // Kill the terminal process if it's running
          await terminalManager.destroyTerminal(terminalId);
          // Delete from the terminal store
          deleteTerminalInstance(workspacePath, terminalId);
        } catch (err) {
          archiveLogger.warn('Failed to delete worktree terminal', { terminalId, worktreeId, error: err });
        }
      }
      archiveLogger.info('Deleted terminals for worktree', { worktreeId, deletedCount: worktreeTerminalIds.length });

      // Notify renderer to refresh terminal list
      emitTerminalListChanged(workspacePath);
    }

    // Step 3: Archive all sessions for this worktree immediately (fast feedback)
    archiveLogger.info('Archiving sessions for worktree', { worktreeId, sessionCount: sessionIds.length });

    const failedSessions = await archiveSessionsForWorktree(worktreeId, sessionIds, archiveLogger);

    if (failedSessions > 0) {
      archiveLogger.warn('Some sessions failed to archive', { worktreeId, failedCount: failedSessions, totalCount: sessionIds.length });
    }

    // NOTE: We do NOT mark the worktree as archived here.
    // The worktree is only marked as archived AFTER the disk deletion succeeds.
    // This ensures we never have a worktree marked as archived that still exists on disk.

    // Calculate worktree age for analytics
    const worktreeAgeDays = Math.floor((Date.now() - worktree.createdAt) / (1000 * 60 * 60 * 24));
    const archiveStartTime = Date.now();

    // Track archive initiation
    const analyticsService = AnalyticsService.getInstance();
    analyticsService.sendEvent('worktree_archived', {
      session_count: sessionIds.length,
      worktree_age_days: worktreeAgeDays,
      failed_sessions: failedSessions,
      has_uncommitted_changes: hasUncommittedChanges,
      has_unmerged_changes: hasUnmergedChanges,
    });

    // Step 4: Queue the slow cleanup work
    const cleanupCallback = async () => {
      try {
        // Update status to show we're removing the worktree
        archiveProgressManager.updateTaskStatus(worktreeId, 'removing-worktree');

        // Remove the git worktree from disk (throws if directory still exists after cleanup)
        await gitWorktreeService.deleteWorktree(worktree.path, workspacePath);

        archiveLogger.info('Worktree cleanup completed, now marking as archived in database', { worktreeId });

        // Only mark as archived AFTER disk deletion is confirmed
        await worktreeStore.updateArchived(worktreeId, true);
        const existingLoop = await superLoopStore.getLoopByWorktreeId(worktreeId);
        if (existingLoop && !existingLoop.isArchived) {
          await superLoopStore.updateLoop(existingLoop.id, { isArchived: true });
        }

        archiveLogger.info('Worktree marked as archived in database', { worktreeId });

        // Track successful completion
        const durationMs = Date.now() - archiveStartTime;
        analyticsService.sendEvent('worktree_archive_completed', {
          session_count: sessionIds.length,
          duration_ms: durationMs,
        });
      } catch (error) {
        // Unarchive the sessions since the cleanup failed
        archiveLogger.warn('Cleanup failed, unarchiving sessions', { worktreeId, error });
        for (const sessionId of sessionIds) {
          try {
            await AISessionsRepository.updateMetadata(sessionId, { isArchived: false });
          } catch (unarchiveErr) {
            archiveLogger.error('Failed to unarchive session after cleanup failure', { sessionId, worktreeId, error: unarchiveErr });
          }
        }

        // Track failure
        analyticsService.sendEvent('worktree_archive_failed', {
          error_type: error instanceof Error ? error.constructor.name : 'Unknown',
          stage: 'removing-worktree',
        });
        throw error;
      }
    };

    archiveProgressManager.addTask(
      worktreeId,
      worktree.displayName || worktree.name,
      cleanupCallback
    );

    archiveLogger.info('Worktree archive initiated', { worktreeId });

    return { success: true };
  } catch (error) {
    archiveLogger.error('Failed to archive worktree:', error);

    // Track failure during setup/session archiving
    const analyticsService = AnalyticsService.getInstance();
    analyticsService.sendEvent('worktree_archive_failed', {
      error_type: error instanceof Error ? error.constructor.name : 'Unknown',
      stage: 'archiving-sessions',
    });

    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to archive worktree',
    };
  }
}

/**
 * Register worktree IPC handlers
 */
export function registerWorktreeHandlers(): void {
  const gitWorktreeService = new GitWorktreeService();
  let watchersInitialized = false;

  // In-flight request dedup for worktree:get-status -- if multiple sessions share
  // the same worktree path, only one set of git commands runs at a time.
  const inFlightStatusRequests = new Map<string, Promise<any>>();

  /**
   * Create a new git worktree and store its metadata
   *
   * @param workspacePath - Path to the main git repository
   * @param name - Optional custom name for the worktree
   * @returns Worktree data including id, path, branch, etc.
   */
  ipcMain.handle('worktree:create', async (
    _event,
    workspacePath: string,
    options?: { name?: string; baseBranch?: string }
  ): Promise<WorktreeCreateResult> => {
    const startTime = Date.now();
    const MAX_RETRIES = 3;
    const name = options?.name;
    const baseBranch = options?.baseBranch;

    // Retry loop for handling race conditions where concurrent requests pick the same name
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const timings: Record<string, number> = {};
      // Track created worktree for cleanup on DB insert failure
      let createdWorktree: { path: string; branch: string } | null = null;

      try {
        if (!workspacePath) {
          throw new Error('workspacePath is required');
        }

        logger.info('Creating worktree', { workspacePath, name, baseBranch, attempt });

        // Get database early for de-duplication
        const db = getDatabase();
        if (!db) {
          throw new Error('Database not initialized');
        }

        const worktreeStore = createWorktreeStore(db);

        // If no custom name provided, generate a unique name using all three sources
        let finalName = name;
        if (!finalName) {
          // Gather existing names from all three sources in parallel
          const dedupeStartTime = Date.now();

          const [dbNames, filesystemNames, branchNames] = await Promise.all([
            worktreeStore.getAllNames(),
            Promise.resolve(gitWorktreeService.getExistingWorktreeDirectories(workspacePath)),
            gitWorktreeService.getAllBranchNames(workspacePath),
          ]);

          timings.deduplication = Date.now() - dedupeStartTime;

          // Combine all existing names into a single set
          const existingNames = new Set<string>();
          for (const dbName of dbNames) existingNames.add(dbName);
          for (const fsName of filesystemNames) existingNames.add(fsName);
          for (const branchName of branchNames) existingNames.add(branchName);

          logger.info('Gathered existing names for de-duplication', {
            dbCount: dbNames.size,
            filesystemCount: filesystemNames.size,
            branchCount: branchNames.size,
            totalUnique: existingNames.size,
            durationMs: timings.deduplication,
          });

          // Generate a unique name
          finalName = gitWorktreeService.generateUniqueWorktreeName(existingNames);
        }

        // Create the git worktree
        const gitCreateStartTime = Date.now();
        const worktree = await gitWorktreeService.createWorktree(workspacePath, { name: finalName, baseBranch });
        timings.gitWorktreeCreate = Date.now() - gitCreateStartTime;

        // Track the created worktree for potential cleanup
        createdWorktree = { path: worktree.path, branch: worktree.branch };

        // Store worktree metadata in database
        const dbInsertStartTime = Date.now();
        await worktreeStore.create(worktree);
        timings.dbInsert = Date.now() - dbInsertStartTime;

        // DB insert succeeded, clear cleanup tracking
        createdWorktree = null;

        // Start git ref watcher for the worktree path to detect commits
        gitRefWatcher.start(worktree.path).catch((error) => {
          logger.error('Failed to start GitRefWatcher for worktree:', error);
        });

        const totalDuration = Date.now() - startTime;
        logger.info('Worktree created successfully', {
          id: worktree.id,
          path: worktree.path,
          name: worktree.name,
          totalDurationMs: totalDuration,
          timings,
          attempts: attempt,
        });

        // Track worktree creation
        const analyticsService = AnalyticsService.getInstance();
        FeatureUsageService.getInstance().recordUsage(FEATURES.WORKTREE_CREATED);
        analyticsService.sendEvent('worktree_created', {
          duration_ms: totalDuration,
          retry_count: attempt - 1,
          base_branch_source: baseBranch ? 'picker' : 'default',
        });

        return {
          success: true,
          worktree,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isCollisionError =
          errorMessage.includes('already exists') ||
          errorMessage.includes('branch') ||
          errorMessage.includes('fatal: A worktree');

        // Critical: Clean up orphaned git worktree if DB insert failed
        // This prevents database-git state inconsistency where a worktree exists on disk
        // but isn't tracked in the database
        if (createdWorktree) {
          logger.warn('DB insert failed after git worktree was created, cleaning up orphaned worktree', {
            worktreePath: createdWorktree.path,
          });
          try {
            await gitWorktreeService.deleteWorktree(createdWorktree.path, workspacePath);
            logger.info('Successfully cleaned up orphaned worktree', { worktreePath: createdWorktree.path });
          } catch (cleanupError) {
            logger.error('Failed to clean up orphaned worktree - manual cleanup required', {
              worktreePath: createdWorktree.path,
              cleanupError,
            });
          }
        }

        // If this is a collision error and we haven't exhausted retries, try again with a new name
        // Only retry if no custom name was provided (race condition on auto-generated names)
        if (isCollisionError && attempt < MAX_RETRIES && !name) {
          logger.warn('Worktree creation failed due to name collision, retrying with new name', {
            attempt,
            maxRetries: MAX_RETRIES,
            errorMessage,
          });
          // Continue to next iteration
          continue;
        }

        // Final failure
        const totalDuration = Date.now() - startTime;
        logger.error('Failed to create worktree:', { error, durationMs: totalDuration, timings, attempt });

        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create worktree',
        };
      }
    }

    // Should never reach here, but TypeScript needs a return
    return {
      success: false,
      error: 'Failed to create worktree after maximum retries',
    };
  });

  /**
   * Get git status for a worktree
   *
   * @param worktreePath - Path to the worktree directory
   * @returns Git status including uncommitted changes, commits ahead/behind, merge status
   */
  ipcMain.handle('worktree:get-status', async (_event, worktreePath: string, options?: { fetchFirst?: boolean }) => {
    if (!worktreePath) {
      return { success: false, error: 'worktreePath is required' };
    }

    // Deduplicate: if a request for this path is already in flight, reuse it
    const existing = inFlightStatusRequests.get(worktreePath);
    if (existing) {
      // logger.info('Reusing in-flight worktree:get-status request', { worktreePath });
      return existing;
    }

    const requestPromise = (async () => {
      try {
        // logger.info('Getting worktree status', { worktreePath, fetchFirst: options?.fetchFirst });

        // Look up the worktree to get the stored base branch
        const db = getDatabase();
        let baseBranch: string | undefined;
        if (db) {
          const worktreeStore = createWorktreeStore(db);
          const worktree = await worktreeStore.getByPath(worktreePath);
          baseBranch = worktree?.baseBranch;
          // logger.info('Found worktree base branch for status', { worktreePath, baseBranch: baseBranch || 'not found' });
        }

        // Fetch latest remote refs for accurate merge detection
        if (options?.fetchFirst && baseBranch) {
          try {
            const git = simpleGit(worktreePath);
            await git.fetch(['origin', baseBranch]);
          } catch (fetchError) {
            logger.warn('Failed to fetch base branch before status check (continuing with local refs)', { fetchError });
          }
        }

        const status = await gitWorktreeService.getWorktreeStatus(worktreePath, baseBranch);

        return {
          success: true,
          status,
        };
      } catch (error) {
        logger.error('Failed to get worktree status:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get worktree status',
        };
      }
    })();

    inFlightStatusRequests.set(worktreePath, requestPromise);
    try {
      return await requestPromise;
    } finally {
      inFlightStatusRequests.delete(worktreePath);
    }
  });

  /**
   * Delete a git worktree and its database record
   *
   * @param worktreeId - ID of the worktree to delete
   * @param workspacePath - Path to the main git repository
   * @returns Success status
   */
  ipcMain.handle('worktree:delete', async (_event, worktreeId: string, workspacePath: string) => {
    try {
      if (!worktreeId) {
        throw new Error('worktreeId is required');
      }

      if (!workspacePath) {
        throw new Error('workspacePath is required');
      }

      logger.info('Deleting worktree', { worktreeId, workspacePath });

      // Get worktree from database to find its path
      const db = getDatabase();
      if (!db) {
        throw new Error('Database not initialized');
      }

      const worktreeStore = createWorktreeStore(db);
      const worktree = await worktreeStore.get(worktreeId);

      if (!worktree) {
        throw new Error(`Worktree not found: ${worktreeId}`);
      }

      // Stop the git ref watcher for this worktree
      await gitRefWatcher.stop(worktree.path);

      // Delete the git worktree
      await gitWorktreeService.deleteWorktree(worktree.path, workspacePath);

      // Delete the database record
      await worktreeStore.delete(worktreeId);

      logger.info('Worktree deleted successfully', { worktreeId });

      return {
        success: true,
      };
    } catch (error) {
      logger.error('Failed to delete worktree:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete worktree',
      };
    }
  });

  /**
   * List all worktrees for a workspace
   *
   * @param workspacePath - Path to the workspace/project
   * @returns Array of worktrees
   */
  ipcMain.handle('worktree:list', async (_event, workspacePath: string) => {
    try {
      if (!workspacePath) {
        throw new Error('workspacePath is required');
      }

      logger.info('Listing worktrees', { workspacePath });

      const db = getDatabase();
      if (!db) {
        throw new Error('Database not initialized');
      }

      const worktreeStore = createWorktreeStore(db);
      const worktrees = await worktreeStore.list(workspacePath);

      logger.info('Found worktrees', { count: worktrees.length });

      // Start git ref watchers for all non-archived worktrees on first list call.
      // This ensures commit detection works for worktrees loaded on app restart.
      // Only runs once; per-worktree start() is called at creation time.
      // Concurrency-limited to avoid a burst of git processes at startup.
      if (!watchersInitialized) {
        watchersInitialized = true;
        const limitConcurrency = createConcurrencyLimiter(2);
        const activeWorktrees = worktrees.filter(wt => !wt.isArchived);

        Promise.all(
          activeWorktrees.map(worktree =>
            limitConcurrency(() => gitRefWatcher.start(worktree.path)).catch((error) => {
              logger.warn('Failed to start GitRefWatcher for worktree:', {
                worktreeId: worktree.id,
                path: worktree.path,
                error: error instanceof Error ? error.message : String(error),
              });
            })
          )
        ).catch(error => {
          logger.error('Error during worktree watcher initialization:', error);
        });
      }

      return {
        success: true,
        worktrees,
      };
    } catch (error) {
      logger.error('Failed to list worktrees:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list worktrees',
        worktrees: [],
      };
    }
  });

  /**
   * Get a single worktree by ID
   *
   * @param worktreeId - ID of the worktree
   * @returns Worktree data or null if not found
   */
  ipcMain.handle('worktree:get', async (_event, worktreeId: string) => {
    try {
      if (!worktreeId) {
        throw new Error('worktreeId is required');
      }

      // logger.info('Getting worktree', { worktreeId });

      const db = getDatabase();
      if (!db) {
        throw new Error('Database not initialized');
      }

      const worktreeStore = createWorktreeStore(db);
      const worktree = await worktreeStore.get(worktreeId);

      if (!worktree) {
        logger.info('Worktree not found', { worktreeId });
        return {
          success: true,
          worktree: null,
        };
      }

      return {
        success: true,
        worktree,
      };
    } catch (error) {
      logger.error('Failed to get worktree:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get worktree',
        worktree: null,
      };
    }
  });

  /**
   * Get worktree by path
   *
   * @param worktreePath - Path to the worktree
   * @returns Worktree data or null if not found
   */
  ipcMain.handle('worktree:get-by-path', async (_event, worktreePath: string) => {
    try {
      if (!worktreePath) {
        throw new Error('worktreePath is required');
      }

      // logger.info('Getting worktree by path', { worktreePath });

      const db = getDatabase();
      if (!db) {
        throw new Error('Database not initialized');
      }

      const worktreeStore = createWorktreeStore(db);
      const worktree = await worktreeStore.getByPath(worktreePath);

      if (!worktree) {
        logger.info('Worktree not found', { worktreePath });
        return {
          success: true,
          worktree: null,
        };
      }

      return {
        success: true,
        worktree,
      };
    } catch (error) {
      logger.error('Failed to get worktree by path:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get worktree by path',
        worktree: null,
      };
    }
  });

  /**
   * Batch fetch worktrees with their git status
   * Efficiently fetches multiple worktrees and their status in a single IPC call
   *
   * @param worktreeIds - Array of worktree IDs to fetch
   * @returns Map of worktree ID to worktree data with status
   */
  ipcMain.handle('worktree:get-batch', async (_event, worktreeIds: string[]) => {
    try {
      if (!worktreeIds || !Array.isArray(worktreeIds)) {
        throw new Error('worktreeIds must be an array');
      }

      if (worktreeIds.length === 0) {
        return {
          success: true,
          worktrees: {},
        };
      }

      logger.info('Batch fetching worktrees', { count: worktreeIds.length, ids: worktreeIds });

      const db = getDatabase();
      if (!db) {
        throw new Error('Database not initialized');
      }

      const worktreeStore = createWorktreeStore(db);
      const results: Record<string, {
        id: string;
        name: string;
        displayName?: string;
        path: string;
        branch: string;
        baseBranch: string;
        projectPath: string;
        createdAt: number;
        updatedAt?: number;
        isPinned?: boolean;
        isArchived?: boolean;
        gitStatus?: {
          ahead?: number;
          behind?: number;
          uncommitted?: boolean;
        };
      }> = {};

      // Single batch query for all worktree metadata (no git operations).
      // Git status (ahead/behind/uncommitted) is fetched lazily when the user
      // views a specific worktree via GitOperationsPanel and worktree:get-status.
      // With 270+ non-archived worktrees, fetching git status here would spawn
      // ~800+ git processes at startup.
      const worktreeMap = await worktreeStore.getByIds(worktreeIds);
      for (const [worktreeId, worktree] of worktreeMap) {
        results[worktreeId] = { ...worktree };
      }

      // logger.info('Batch fetch completed', { requested: worktreeIds.length, fetched: Object.keys(results).length });

      return {
        success: true,
        worktrees: results,
      };
    } catch (error) {
      logger.error('Failed to batch fetch worktrees:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to batch fetch worktrees',
        worktrees: {},
      };
    }
  });

  /**
   * Update worktree pinned status
   *
   * @param worktreeId - ID of the worktree to update
   * @param isPinned - Whether the worktree should be pinned
   * @returns Success status
   */
  ipcMain.handle('worktree:update-pinned', async (_event, worktreeId: string, isPinned: boolean) => {
    try {
      if (!worktreeId) {
        throw new Error('worktreeId is required');
      }

      logger.info('Updating worktree pinned status', { worktreeId, isPinned });

      const db = getDatabase();
      if (!db) {
        throw new Error('Database not initialized');
      }

      const worktreeStore = createWorktreeStore(db);
      await worktreeStore.updatePinned(worktreeId, isPinned);

      return {
        success: true,
      };
    } catch (error) {
      logger.error('Failed to update worktree pinned status:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update worktree pinned status',
      };
    }
  });

  /**
   * Update worktree display name
   *
   * @param worktreeId - ID of the worktree to update
   * @param displayName - New display name for the worktree
   * @returns Success status
   */
  ipcMain.handle('worktree:update-display-name', async (_event, worktreeId: string, displayName: string) => {
    try {
      if (!worktreeId) {
        throw new Error('worktreeId is required');
      }

      if (!displayName) {
        throw new Error('displayName is required');
      }

      logger.info('Updating worktree display name', { worktreeId, displayName });

      const db = getDatabase();
      if (!db) {
        throw new Error('Database not initialized');
      }

      const worktreeStore = createWorktreeStore(db);
      await worktreeStore.update(worktreeId, { displayName });

      // Notify all windows that the worktree display name has changed
      const windows = BrowserWindow.getAllWindows();
      for (const window of windows) {
        if (!window.isDestroyed()) {
          window.webContents.send('worktree:display-name-updated', {
            worktreeId,
            displayName,
          });
        }
      }

      return {
        success: true,
      };
    } catch (error) {
      logger.error('Failed to update worktree display name:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update worktree display name',
      };
    }
  });

  /**
   * Get all changed files in a worktree compared to base branch
   *
   * @param worktreePath - Path to the worktree
   * @returns Array of changed files with their status
   */
  ipcMain.handle('worktree:get-changed-files', async (_event, worktreePath: string) => {
    try {
      if (!worktreePath) {
        throw new Error('worktreePath is required');
      }

      // logger.info('Getting changed files', { worktreePath });

      const changedFiles = await gitWorktreeService.getChangedFiles(worktreePath);

      return {
        success: true,
        files: changedFiles,
      };
    } catch (error) {
      logger.error('Failed to get changed files:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get changed files',
        files: [],
      };
    }
  });

  /**
   * Get diff for a specific file in a worktree
   *
   * @param worktreePath - Path to the worktree
   * @param filePath - Relative path to the file
   * @returns File diff result
   */
  ipcMain.handle('worktree:get-file-diff', async (_event, worktreePath: string, filePath: string) => {
    try {
      if (!worktreePath) {
        throw new Error('worktreePath is required');
      }
      if (!filePath) {
        throw new Error('filePath is required');
      }

      logger.info('Getting file diff', { worktreePath, filePath });

      // Look up the worktree to get the stored base branch
      const db = getDatabase();
      let baseBranch: string | undefined;
      if (db) {
        const worktreeStore = createWorktreeStore(db);
        const worktree = await worktreeStore.getByPath(worktreePath);
        baseBranch = worktree?.baseBranch;
      }

      const diff = await gitWorktreeService.getFileDiff(worktreePath, filePath, baseBranch);

      return {
        success: true,
        diff,
      };
    } catch (error) {
      logger.error('Failed to get file diff:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get file diff',
      };
    }
  });

  /**
   * Get commits in a worktree branch
   *
   * @param worktreePath - Path to the worktree
   * @returns Array of commits
   */
  ipcMain.handle('worktree:get-commits', async (_event, worktreePath: string) => {
    try {
      if (!worktreePath) {
        throw new Error('worktreePath is required');
      }

      // logger.info('Getting worktree commits', { worktreePath });

      // Look up the worktree to get the stored base branch
      const db = getDatabase();
      let baseBranch: string | undefined;
      if (db) {
        const worktreeStore = createWorktreeStore(db);
        const worktree = await worktreeStore.getByPath(worktreePath);
        baseBranch = worktree?.baseBranch;
        // logger.info('Found worktree base branch', { worktreePath, baseBranch: baseBranch || 'not found' });
      }

      const commits = await gitWorktreeService.getWorktreeCommits(worktreePath, baseBranch);

      // Convert Date objects to ISO strings for IPC serialization
      // Date objects don't survive Electron IPC correctly in arrays
      const serializedCommits = commits.map(commit => {
        const dateValue = commit.date instanceof Date && !isNaN(commit.date.getTime())
          ? commit.date.toISOString()
          : new Date().toISOString();
        return {
          ...commit,
          date: dateValue,
        };
      });

      return {
        success: true,
        commits: serializedCommits,
      };
    } catch (error) {
      logger.error('Failed to get worktree commits:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get worktree commits',
        commits: [],
      };
    }
  });

  /**
   * Commit changes in a worktree
   *
   * @param worktreePath - Path to the worktree
   * @param message - Commit message
   * @param files - Optional array of specific files to commit
   * @returns Commit information
   */
  ipcMain.handle('worktree:commit', async (_event, worktreePath: string, message: string, files?: string[]) => {
    try {
      if (!worktreePath) {
        throw new Error('worktreePath is required');
      }
      if (!message) {
        throw new Error('message is required');
      }

      logger.info('Committing changes', { worktreePath, message, fileCount: files?.length });

      const commit = await gitWorktreeService.commitChanges(worktreePath, message, files);

      // Convert Date object to ISO string for IPC serialization
      const dateValue = commit.date instanceof Date && !isNaN(commit.date.getTime())
        ? commit.date.toISOString()
        : new Date().toISOString();
      const serializedCommit = {
        ...commit,
        date: dateValue,
      };

      return {
        success: true,
        commit: serializedCommit,
      };
    } catch (error) {
      logger.error('Failed to commit changes:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to commit changes',
      };
    }
  });

  /**
   * Get the current branch of a repository
   * This is used to show what branch the repo root is on, which worktrees are compared against.
   *
   * @param repoPath - Path to the git repository
   * @returns Current branch name
   */
  ipcMain.handle('worktree:get-repo-current-branch', async (_event, repoPath: string) => {
    try {
      if (!repoPath) {
        throw new Error('repoPath is required');
      }

      // logger.info('Getting current branch for repo', { repoPath });

      const currentBranch = await gitWorktreeService.getRepoCurrentBranch(repoPath);

      return {
        success: true,
        branch: currentBranch,
      };
    } catch (error) {
      logger.error('Failed to get current branch:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get current branch',
      };
    }
  });

  /**
   * Merge worktree branch to main
   *
   * @param worktreePath - Path to the worktree
   * @param mainRepoPath - Path to the main repository
   * @returns Merge result
   */
  ipcMain.handle('worktree:merge', async (_event, worktreePath: string, mainRepoPath: string) => {
    try {
      if (!worktreePath) {
        throw new Error('worktreePath is required');
      }
      if (!mainRepoPath) {
        throw new Error('mainRepoPath is required');
      }

      logger.info('Merging worktree to main', { worktreePath, mainRepoPath });

      const result = await gitWorktreeService.mergeToMain(worktreePath, mainRepoPath);

      // Track merge attempt
      const analyticsService = AnalyticsService.getInstance();
      analyticsService.sendEvent('worktree_merge_attempted', {
        success: result.success,
        had_conflicts: !!(result.conflictedFiles && result.conflictedFiles.length > 0),
      });

      return {
        success: result.success,
        message: result.message,
        conflictedFiles: result.conflictedFiles,
      };
    } catch (error) {
      logger.error('Failed to merge to main:', error);

      // Track merge failure
      const analyticsService = AnalyticsService.getInstance();
      analyticsService.sendEvent('worktree_merge_attempted', {
        success: false,
        had_conflicts: false,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to merge to main',
      };
    }
  });

  /**
   * Rebase worktree branch from base branch
   * Brings in new commits from the base branch into the worktree
   *
   * @param worktreePath - Path to the worktree
   * @returns Rebase result with conflict details if conflicts detected
   */
  ipcMain.handle('worktree:rebase', async (_event, worktreePath: string) => {
    try {
      if (!worktreePath) {
        throw new Error('worktreePath is required');
      }

      logger.info('Rebasing worktree from base branch', { worktreePath });

      // Look up the worktree to get the stored base branch
      const db = getDatabase();
      if (!db) {
        throw new Error('Database not initialized');
      }

      const worktreeStore = createWorktreeStore(db);
      const worktree = await worktreeStore.getByPath(worktreePath);

      if (!worktree) {
        throw new Error('Worktree not found in database');
      }

      if (!worktree.baseBranch) {
        throw new Error('Worktree has no base branch stored');
      }

      const result = await gitWorktreeService.rebaseFromBase(worktreePath, worktree.baseBranch);

      // Track rebase attempt
      const analyticsService = AnalyticsService.getInstance();
      analyticsService.sendEvent('worktree_rebase_attempted', {
        success: result.success,
        had_conflicts: !!(result.conflictedFiles && result.conflictedFiles.length > 0),
        had_untracked_files_conflict: !!(result.untrackedFiles && result.untrackedFiles.length > 0),
      });

      return {
        success: result.success,
        message: result.message,
        conflictedFiles: result.conflictedFiles,
        conflictingCommits: result.conflictingCommits,
        untrackedFiles: result.untrackedFiles,
      };
    } catch (error) {
      logger.error('Failed to rebase worktree:', error);

      // Track rebase failure
      const analyticsService = AnalyticsService.getInstance();
      analyticsService.sendEvent('worktree_rebase_attempted', {
        success: false,
        had_conflicts: false,
        had_untracked_files_conflict: false,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to rebase worktree',
      };
    }
  });

  /**
   * Archive a worktree and its sessions
   *
   * This immediately kills any running terminal processes for the worktree's sessions,
   * archives all sessions in the database, then queues the slow cleanup work
   * (git worktree removal) to be processed serially. Returns immediately after
   * queuing - doesn't wait for cleanup.
   *
   * @param worktreeId - ID of the worktree to archive
   * @param workspacePath - Path to the main git repository
   * @returns Success status (for immediate database operations)
   */
  ipcMain.handle('worktree:archive', async (_event, worktreeId: string, workspacePath: string) => {
    return archiveWorktree(worktreeId, workspacePath);
  });

  /**
   * Get current archive tasks
   *
   * Used by the renderer to get the current queue status when the component mounts.
   *
   * @returns Array of archive tasks with their status
   */
  ipcMain.handle('archive:get-tasks', async () => {
    try {
      const tasks = archiveProgressManager.getTasks();
      return {
        success: true,
        tasks,
      };
    } catch (error) {
      logger.error('Failed to get archive tasks:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get archive tasks',
        tasks: [],
      };
    }
  });

  /**
   * Check if commits exist on other branches besides the current one
   *
   * @param worktreePath - Path to the worktree
   * @param commitHashes - Array of commit hashes to check
   * @returns Whether commits exist on other branches
   */
  ipcMain.handle('worktree:check-commits-existence', async (_event, worktreePath: string, commitHashes: string[]) => {
    try {
      if (!worktreePath) {
        throw new Error('worktreePath is required');
      }

      if (!commitHashes || !Array.isArray(commitHashes)) {
        throw new Error('commitHashes must be an array');
      }

      logger.info('Checking commits existence', { worktreePath, commitCount: commitHashes.length });

      const existsElsewhere = await gitWorktreeService.checkCommitsExistElsewhere(worktreePath, commitHashes);

      return {
        success: true,
        existsElsewhere,
      };
    } catch (error) {
      logger.error('Failed to check commits existence:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check commits existence',
        existsElsewhere: false,
      };
    }
  });

  /**
   * Squash multiple commits into a single commit
   *
   * @param worktreePath - Path to the worktree
   * @param commitHashes - Array of commit hashes to squash (must be consecutive)
   * @param message - Commit message for the squashed commit
   * @returns The new commit hash
   */
  ipcMain.handle('worktree:squash-commits', async (_event, worktreePath: string, commitHashes: string[], message: string) => {
    try {
      if (!worktreePath) {
        throw new Error('worktreePath is required');
      }

      if (!commitHashes || !Array.isArray(commitHashes)) {
        throw new Error('commitHashes must be an array');
      }

      if (!message) {
        throw new Error('message is required');
      }

      logger.info('Squashing commits', { worktreePath, commitCount: commitHashes.length });

      const newCommitHash = await gitWorktreeService.squashCommits(worktreePath, commitHashes, message);

      return {
        success: true,
        commitHash: newCommitHash,
      };
    } catch (error) {
      logger.error('Failed to squash commits:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to squash commits',
      };
    }
  });

  /**
   * Stage or unstage a file in a worktree
   * @param worktreePath - Path to the worktree directory
   * @param filePath - Relative path of the file to stage/unstage
   * @param stage - true to stage, false to unstage
   */
  ipcMain.handle('worktree:stage-file', async (_event, worktreePath: string, filePath: string, stage: boolean) => {
    try {
      if (!worktreePath) {
        throw new Error('worktreePath is required');
      }
      if (!filePath) {
        throw new Error('filePath is required');
      }

      // Use centralized lock to prevent concurrent staging/commit operations
      return await gitOperationLock.withLock(worktreePath, 'worktree:stage-file', async () => {
        logger.info('Staging/unstaging file', { worktreePath, filePath, stage });

        const simpleGit = (await import('simple-git')).default;
        const git = simpleGit(worktreePath);

        if (stage) {
          await git.add(filePath);
        } else {
          await git.reset(['--', filePath]);
        }

        // Emit git status changed event so UI updates
        emitGitStatusChanged(worktreePath);

        return { success: true };
      });
    } catch (error) {
      logger.error('Failed to stage/unstage file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stage/unstage file',
      };
    }
  });

  /**
   * Stage or unstage all files in a worktree
   * @param worktreePath - Path to the worktree directory
   * @param stage - true to stage all, false to unstage all
   */
  ipcMain.handle('worktree:stage-all', async (_event, worktreePath: string, stage: boolean) => {
    try {
      if (!worktreePath) {
        throw new Error('worktreePath is required');
      }

      // Use centralized lock to prevent concurrent staging/commit operations
      return await gitOperationLock.withLock(worktreePath, 'worktree:stage-all', async () => {
        logger.info('Staging/unstaging all files', { worktreePath, stage });

        const simpleGit = (await import('simple-git')).default;
        const git = simpleGit(worktreePath);

        if (stage) {
          await git.add('-A');
        } else {
          await git.reset();
        }

        // Emit git status changed event so UI updates
        emitGitStatusChanged(worktreePath);

        return { success: true };
      });
    } catch (error) {
      logger.error('Failed to stage/unstage all files:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stage/unstage all files',
      };
    }
  });

  /**
   * Start watching a worktree for git changes
   * This enables real-time git status updates for files added/modified via command line
   *
   * @param worktreePath - Path to the worktree directory
   */
  ipcMain.handle('worktree:start-watching', async (_event, worktreePath: string) => {
    try {
      if (!worktreePath) {
        throw new Error('worktreePath is required');
      }

      logger.info('Starting git ref watcher for worktree', { worktreePath });

      await gitRefWatcher.start(worktreePath);

      return { success: true };
    } catch (error) {
      logger.error('Failed to start watching worktree:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start watching worktree',
      };
    }
  });

  /**
   * Preview gitignored files that would be cleaned from a worktree (dry run).
   *
   * @param worktreePath - Path to the worktree directory
   * @returns List of files that would be removed and their count
   */
  ipcMain.handle('worktree:list-gitignored', async (_event, worktreePath: string) => {
    try {
      if (!worktreePath) {
        throw new Error('worktreePath is required');
      }

      logger.info('Listing gitignored files for worktree', { worktreePath });
      const files = await gitWorktreeService.listGitignoredFiles(worktreePath);
      logger.info('Listed gitignored files', { worktreePath, count: files.length });

      return { success: true, files, count: files.length };
    } catch (error) {
      logger.error('Failed to list gitignored files:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list gitignored files',
        files: [],
        count: 0,
      };
    }
  });

  /**
   * Clean all gitignored files from a worktree.
   *
   * @param worktreePath - Path to the worktree directory
   * @returns List of removed files
   */
  ipcMain.handle('worktree:clean-gitignored', async (_event, worktreePath: string) => {
    try {
      if (!worktreePath) {
        throw new Error('worktreePath is required');
      }

      const removed = await gitWorktreeService.cleanGitignoredFiles(worktreePath);

      return { success: true, removed, count: removed.length };
    } catch (error) {
      logger.error('Failed to clean gitignored files:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to clean gitignored files',
      };
    }
  });

  logger.info('Worktree handlers registered');
}
