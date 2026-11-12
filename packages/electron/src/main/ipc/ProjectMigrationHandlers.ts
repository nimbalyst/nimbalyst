/**
 * ProjectMigrationHandlers.ts
 *
 * IPC handlers for project move/rename operations.
 */

import { BrowserWindow } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { getProjectMigrationService, type MovePhase } from '../services/ProjectMigrationService';
import { logger } from '../utils/logger';

/** A project move running (or just finished) in the background */
export interface ProjectMoveJob {
  oldPath: string;
  newPath: string;
  status: 'running' | 'succeeded' | 'failed';
  phase: MovePhase | null;
  error?: string;
  warnings?: string[];
}

// Keyed by oldPath. Finished jobs stay until the next move of that path so a
// Project Manager window opened after completion still sees the result.
const moveJobs = new Map<string, ProjectMoveJob>();

function broadcastMoveJob(job: ProjectMoveJob): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      try {
        window.webContents.send('project:move-progress', job);
      } catch {
        // ignore -- destroyed window
      }
    }
  }
}

export function registerProjectMigrationHandlers() {
  /**
   * Check if a project can be moved.
   *
   * @param oldPath - Current project path
   * @returns CanMoveResult with canMove boolean and optional reason
   */
  safeHandle('project:can-move', async (_event, oldPath: string) => {
    if (!oldPath) {
      throw new Error('oldPath is required');
    }

    const service = getProjectMigrationService();
    return service.canMoveProject(oldPath);
  });

  /**
   * Start moving a project to a new location in the background.
   *
   * Preconditions are checked before returning, so those errors come back
   * here. The move itself runs after this resolves and reports through
   * `project:move-progress` broadcasts.
   *
   * @param oldPath - Current project path
   * @param newPath - Full destination path (including project directory name)
   * @returns `{ started: true }`, or `{ started: false, error }`
   */
  safeHandle('project:move', async (_event, oldPath: string, newPath: string) => {
    if (!oldPath) {
      throw new Error('oldPath is required');
    }
    if (!newPath) {
      throw new Error('newPath is required');
    }

    const service = getProjectMigrationService();
    const valid = await service.validateMove(oldPath, newPath);
    if (!valid.canMove) {
      return { started: false, error: valid.reason || 'Cannot move project' };
    }

    logger.main.info('[ProjectMigrationHandlers] Moving project in background:', oldPath, '->', newPath);
    const job: ProjectMoveJob = { oldPath, newPath, status: 'running', phase: null };
    moveJobs.set(oldPath, job);
    broadcastMoveJob(job);

    void service
      .moveProject(oldPath, newPath, (phase) => {
        job.phase = phase;
        broadcastMoveJob({ ...job });
      })
      .then((result) => {
        job.status = result.success ? 'succeeded' : 'failed';
        job.error = result.error;
        job.warnings = result.warnings;
      })
      .catch((error: any) => {
        logger.main.error('[ProjectMigrationHandlers] Background move threw:', error);
        job.status = 'failed';
        job.error = error?.message || 'Failed to move project';
      })
      .finally(() => broadcastMoveJob({ ...job }));

    return { started: true };
  });

  /** Moves that are running or finished since launch, for a newly opened Project Manager */
  safeHandle('project:move-jobs', async () => [...moveJobs.values()]);

  /**
   * Rename a project in place.
   *
   * @param oldPath - Current project path
   * @param newName - New directory name (not full path)
   * @returns MoveResult with success boolean and optional error/newPath
   */
  safeHandle('project:rename', async (_event, oldPath: string, newName: string) => {
    if (!oldPath) {
      throw new Error('oldPath is required');
    }
    if (!newName) {
      throw new Error('newName is required');
    }

    logger.main.info('[ProjectMigrationHandlers] Renaming project:', oldPath, 'to', newName);
    const service = getProjectMigrationService();
    return service.renameProject(oldPath, newName);
  });
}
