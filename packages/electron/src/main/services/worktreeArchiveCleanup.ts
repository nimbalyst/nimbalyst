/**
 * Worktree archive cleanup - the slow half of archiving a worktree
 *
 * Archiving hides the worktree's sessions right away and queues this cleanup
 * on the ArchiveProgressManager. The cleanup runs from the live
 * `worktree:archive` path and from the startup replay of a queue an earlier
 * run did not finish. Both share this code, so an archive interrupted by a
 * crash finishes the same way it would have finished live.
 */

import log from 'electron-log/main';
import type { ArchiveProgressManager } from './ArchiveProgressManager';
import type { SuperLoopStore } from './SuperLoopStore';
import { checkWorktreeArchiveConsistency, type Worktree, type WorktreeStore } from './WorktreeStore';

const logger = log.scope('worktreeArchiveCleanup');

export interface WorktreeArchiveCleanupDeps {
  /** `GitWorktreeService.deleteWorktree` */
  deleteWorktree(worktreePath: string, repoPath: string): Promise<void>;
  worktreeStore: Pick<WorktreeStore, 'updateArchived'>;
  superLoopStore: Pick<SuperLoopStore, 'getLoopByWorktreeId' | 'updateLoop'>;
  archiveQueue: Pick<ArchiveProgressManager, 'updateTaskStatus'>;
  /** Makes a session visible again after a failed cleanup */
  unarchiveSession(sessionId: string): Promise<void>;
  /** `fs.existsSync` */
  pathExists(path: string): boolean;
}

/**
 * Removes the worktree from disk, then marks it and its super loop archived.
 * A failure that leaves the checkout on disk un-archives the sessions. The
 * error is always rethrown, so the archive queue reports the task as failed.
 */
export type WorktreeArchiveCleanup = (
  worktree: Pick<Worktree, 'id' | 'path' | 'projectPath' | 'sourceFolderPath'>,
  sessionIds: string[]
) => Promise<void>;

export function createWorktreeArchiveCleanup(deps: WorktreeArchiveCleanupDeps): WorktreeArchiveCleanup {
  return async (worktree, sessionIds) => {
    const worktreeId = worktree.id;
    try {
      // Update status to show we're removing the worktree
      deps.archiveQueue.updateTaskStatus(worktreeId, 'removing-worktree');

      // Remove the git worktree from disk (throws if directory still exists
      // after cleanup). Unregister it from the repo it was branched from --
      // `projectPath` is only the workspace's primary root. Running
      // `worktree remove` there fails for an attached folder's worktree, the
      // fallback deletes the directory anyway, and `branch -D` then removes a
      // same-named branch of the primary repo.
      const repoPath = worktree.sourceFolderPath || worktree.projectPath;
      logger.info('Removing archived worktree from disk', { worktreeId, path: worktree.path, repoPath });
      await deps.deleteWorktree(worktree.path, repoPath);

      logger.info('Worktree cleanup completed, now marking as archived in database', { worktreeId });

      // Only mark as archived AFTER disk deletion is confirmed
      await deps.worktreeStore.updateArchived(worktreeId, true);
      const existingLoop = await deps.superLoopStore.getLoopByWorktreeId(worktreeId);
      if (existingLoop && !existingLoop.isArchived) {
        await deps.superLoopStore.updateLoop(existingLoop.id, { isArchived: true });
      }

      logger.info('Worktree marked as archived in database', { worktreeId });
    } catch (error) {
      // Show the sessions again only while their checkout is still on disk.
      // Some failures come after the directory is gone (deleteWorktree's
      // final git-list check, marking the row archived, archiving the super
      // loop); un-archiving then would bind visible sessions to a deleted
      // worktree. Left archived, the next launch's consistency check marks
      // the worktree archived.
      if (deps.pathExists(worktree.path)) {
        logger.warn('Cleanup failed, unarchiving sessions', { worktreeId, error });
        for (const sessionId of sessionIds) {
          try {
            await deps.unarchiveSession(sessionId);
          } catch (unarchiveErr) {
            logger.error('Failed to unarchive session after cleanup failure', { sessionId, worktreeId, error: unarchiveErr });
          }
        }
      } else {
        logger.warn('Cleanup failed after the worktree left the disk, keeping its sessions archived', { worktreeId, error });
      }
      throw error;
    }
  };
}

export interface WorktreeArchiveRecoveryDeps {
  db: Parameters<typeof checkWorktreeArchiveConsistency>[0];
  archiveQueue: Pick<ArchiveProgressManager, 'getPersistedTaskIds' | 'loadPersistedTasks'>;
  worktreeStore: Pick<WorktreeStore, 'get' | 'getWorktreeSessions'>;
  cleanup: WorktreeArchiveCleanup;
}

/**
 * Startup recovery of archives an earlier run did not finish.
 *
 * The consistency check repairs a crash between archiving the sessions and
 * marking the worktree archived; the queue replay then re-runs cleanups that
 * were still queued. The check runs first and is told which worktrees are
 * queued, so it leaves them to the replay: it neither reverts their sessions
 * onto a worktree the replay is about to delete, nor marks them archived,
 * which would make the replay skip them.
 *
 * Neither phase throws: a failure is logged and startup continues.
 */
export async function recoverWorktreeArchivesOnStartup(deps: WorktreeArchiveRecoveryDeps): Promise<{
  consistency: Awaited<ReturnType<typeof checkWorktreeArchiveConsistency>>;
  recovered: number;
  failed: number;
}> {
  // Run worktree archive consistency check
  // This handles cases where the app crashed between archiving sessions and marking worktree as archived
  let consistency: Awaited<ReturnType<typeof checkWorktreeArchiveConsistency>> = [];
  try {
    const pendingArchiveIds = deps.archiveQueue.getPersistedTaskIds();
    consistency = await checkWorktreeArchiveConsistency(deps.db, { pendingArchiveIds });
    if (consistency.length > 0) {
      logger.warn('Worktree archive consistency issues resolved:', consistency);
    }
  } catch (consistencyError) {
    // Don't fail startup if consistency check fails
    logger.error('Worktree archive consistency check failed:', consistencyError);
  }

  // Load persisted archive queue tasks
  // This handles cases where the app crashed while processing archive cleanup
  let recovered = 0;
  let failed = 0;
  try {
    ({ recovered, failed } = await deps.archiveQueue.loadPersistedTasks(async (worktreeId: string) => {
      // Look up the worktree to get necessary context
      const worktree = await deps.worktreeStore.get(worktreeId);
      if (!worktree) {
        logger.warn('Worktree not found for persisted archive task', { worktreeId });
        return null;
      }

      // If worktree is already archived, no callback needed
      if (worktree.isArchived) {
        logger.info('Worktree already archived, skipping persisted task', { worktreeId });
        return null;
      }

      // The archiving run hid these sessions before it queued the cleanup;
      // the cleanup shows them again if it fails.
      const sessionIds = await deps.worktreeStore.getWorktreeSessions(worktreeId);
      return () => deps.cleanup(worktree, sessionIds);
    }));

    if (recovered > 0 || failed > 0) {
      logger.info('Archive queue recovery completed', { recovered, failed });
    }
  } catch (archiveQueueError) {
    // Don't fail startup if archive queue recovery fails
    logger.error('Archive queue recovery failed:', archiveQueueError);
  }

  return { consistency, recovered, failed };
}
