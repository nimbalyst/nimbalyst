/**
 * ProjectMigrationHandlers.ts
 *
 * IPC handlers for project move/rename operations.
 */

import { safeHandle } from '../utils/ipcRegistry';
import { getProjectMigrationService } from '../services/ProjectMigrationService';
import { logger } from '../utils/logger';

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
   * Move a project to a new location.
   *
   * @param oldPath - Current project path
   * @param newPath - Full destination path (including project directory name)
   * @returns MoveResult with success boolean and optional error/newPath
   */
  safeHandle('project:move', async (_event, oldPath: string, newPath: string) => {
    if (!oldPath) {
      throw new Error('oldPath is required');
    }
    if (!newPath) {
      throw new Error('newPath is required');
    }

    logger.main.info('[ProjectMigrationHandlers] Moving project:', oldPath, '->', newPath);
    const service = getProjectMigrationService();
    return service.moveProject(oldPath, newPath);
  });

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
