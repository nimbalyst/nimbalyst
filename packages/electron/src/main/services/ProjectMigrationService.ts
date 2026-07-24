/**
 * ProjectMigrationService.ts
 *
 * Service for moving or renaming projects while preserving all associated data:
 * - Database records (ai_sessions, session_files, document_history, tracker_items, worktrees)
 * - Workspace settings in electron-store
 * - Recent workspaces in app settings
 * - Claude Code session files in ~/.claude/projects/
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import { logger } from '../utils/logger';
import { findWindowByWorkspace } from '../window/WindowManager';
import type { AppDatabase } from '../database/PGLiteDatabaseWorker';
import { database } from '../database/PGLiteDatabaseWorker';
import { encodeWorkspaceDir } from './ClaudeCodeSessionScanner';

// Import store utilities - we'll need to access the underlying stores directly
import {
  getRecentItems,
  store as appStore,
} from '../utils/store';

// Re-export the workspace key generation logic
function workspaceKey(workspacePath: string): string {
  if (!workspacePath) {
    throw new Error('[ProjectMigration] workspacePath is required');
  }
  const normalized = path.normalize(workspacePath).replace(/\/+$/, '');
  const base64 = Buffer.from(normalized).toString('base64url');
  return `ws:${base64}`;
}

/**
 * Result type for canMoveProject check
 */
export interface CanMoveResult {
  canMove: boolean;
  reason?: string;
}

/**
 * Result type for move/rename operations
 */
export interface MoveResult {
  success: boolean;
  error?: string;
  newPath?: string;
}

/**
 * ProjectMigrationService handles safe migration of projects to new locations.
 *
 * Migration is performed in this order:
 * 1. Validate preconditions (project not open, no worktrees, destination available)
 * 2. Create database backup
 * 3. Copy project directory to new location
 * 4. Rename Claude Code session directory
 * 5. Update database records (single transaction)
 * 6. Migrate workspace settings in electron-store
 * 7. Update recent workspaces in app settings
 * 8. Delete original project directory
 *
 * If any step fails, rollback is performed to restore the original state.
 */
export class ProjectMigrationService {
  private dbWorker: AppDatabase;

  constructor(dbWorker?: AppDatabase) {
    this.dbWorker = dbWorker || database;
  }

  /**
   * Check if a project can be moved.
   *
   * @param oldPath - Current project path
   * @returns CanMoveResult indicating whether move is allowed
   */
  async canMoveProject(oldPath: string): Promise<CanMoveResult> {
    logger.main.info('[ProjectMigration] Checking if project can be moved:', oldPath);

    // Validate old path exists
    if (!existsSync(oldPath)) {
      return { canMove: false, reason: 'Project directory does not exist' };
    }

    // Check if project is open in any window
    const window = findWindowByWorkspace(oldPath);
    if (window) {
      return { canMove: false, reason: 'Project is currently open. Please close it first.' };
    }

    // Check for existing worktrees
    try {
      const result = await this.dbWorker.query(
        'SELECT COUNT(*) as count FROM worktrees WHERE workspace_id = $1',
        [oldPath]
      );
      const count = parseInt(result.rows[0]?.count || '0', 10);
      if (count > 0) {
        return {
          canMove: false,
          reason: `Project has ${count} worktree${count > 1 ? 's' : ''}. Please delete worktrees before moving.`
        };
      }
    } catch (error) {
      logger.main.error('[ProjectMigration] Error checking worktrees:', error);
      // Continue anyway - worktrees table might not exist
    }

    return { canMove: true };
  }

  /**
   * Move a project to a new location.
   *
   * @param oldPath - Current project path
   * @param newPath - Destination path (full path including project directory name)
   * @returns MoveResult indicating success or failure
   */
  async moveProject(oldPath: string, newPath: string): Promise<MoveResult> {
    logger.main.info('[ProjectMigration] Moving project from', oldPath, 'to', newPath);

    // Re-validate before proceeding
    const canMove = await this.canMoveProject(oldPath);
    if (!canMove.canMove) {
      return { success: false, error: canMove.reason };
    }

    // Validate destination doesn't exist
    if (existsSync(newPath)) {
      return { success: false, error: 'Destination already exists' };
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(newPath);
    if (!existsSync(parentDir)) {
      return { success: false, error: 'Destination parent directory does not exist' };
    }

    // Track what's been done for rollback
    let projectCopied = false;
    let claudeDirRenamed = false;
    let oldClaudePath: string | null = null;
    let newClaudePath: string | null = null;

    try {
      // Step 1: Create database backup
      logger.main.info('[ProjectMigration] Creating database backup...');
      const backupResult = await this.dbWorker.createBackup();
      if (!backupResult.success) {
        return { success: false, error: `Failed to create backup: ${backupResult.error}` };
      }
      logger.main.info('[ProjectMigration] Database backup created successfully');

      // Step 2: Copy project directory
      logger.main.info('[ProjectMigration] Copying project directory...');
      await fs.cp(oldPath, newPath, { recursive: true });
      projectCopied = true;
      logger.main.info('[ProjectMigration] Project directory copied');

      // Step 3: Rename Claude Code session directory
      const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
      oldClaudePath = path.join(claudeProjectsDir, encodeWorkspaceDir(oldPath));
      newClaudePath = path.join(claudeProjectsDir, encodeWorkspaceDir(newPath));

      if (existsSync(oldClaudePath)) {
        logger.main.info('[ProjectMigration] Renaming Claude session directory...');
        await fs.rename(oldClaudePath, newClaudePath);
        claudeDirRenamed = true;
        logger.main.info('[ProjectMigration] Claude session directory renamed');
      }

      // Step 4: Update database tables
      logger.main.info('[ProjectMigration] Updating database records...');
      await this.migrateDatabase(oldPath, newPath);
      logger.main.info('[ProjectMigration] Database records updated');

      // Step 5: Migrate workspace settings
      logger.main.info('[ProjectMigration] Migrating workspace settings...');
      await this.migrateWorkspaceSettings(oldPath, newPath);
      logger.main.info('[ProjectMigration] Workspace settings migrated');

      // Step 6: Update recent workspaces
      logger.main.info('[ProjectMigration] Updating recent workspaces...');
      this.updateRecentWorkspaces(oldPath, newPath);
      logger.main.info('[ProjectMigration] Recent workspaces updated');

      // Original directory is intentionally NOT deleted.
      // The user can delete it manually after verifying the move succeeded.
      // Automatic recursive deletion is too dangerous - external apps with
      // open file handles can corrupt state during the copy window.
      logger.main.info('[ProjectMigration] Project moved successfully. Original directory preserved at:', oldPath);
      return { success: true, newPath };

    } catch (error: any) {
      logger.main.error('[ProjectMigration] Move failed:', error);

      // Rollback Claude directory rename (safe - just a rename back)
      if (claudeDirRenamed && oldClaudePath && newClaudePath) {
        try {
          await fs.rename(newClaudePath, oldClaudePath);
          logger.main.info('[ProjectMigration] Rollback: Renamed Claude directory back');
        } catch (rollbackError) {
          logger.main.error('[ProjectMigration] Rollback failed: Could not rename Claude directory back:', rollbackError);
        }
      }

      // Never delete the copied directory - if a partial copy exists at newPath,
      // that's still better than losing data. The user can clean it up.
      if (projectCopied) {
        logger.main.warn('[ProjectMigration] Partial copy may exist at:', newPath);
      }

      return { success: false, error: error.message || 'Migration failed' };
    }
  }

  /**
   * Rename a project in place using atomic fs.rename().
   *
   * Unlike moveProject (which copies + deletes for cross-filesystem moves),
   * rename uses a single atomic OS call. This prevents data loss when external
   * apps (e.g. Xcode) have files open - they'll get ENOENT on next write
   * instead of racing with a copy+delete.
   *
   * @param oldPath - Current project path
   * @param newName - New directory name (not full path)
   * @returns MoveResult indicating success or failure
   */
  async renameProject(oldPath: string, newName: string): Promise<MoveResult> {
    // Validate new name
    if (!newName || newName.trim().length === 0) {
      return { success: false, error: 'New name cannot be empty' };
    }

    // Check for invalid characters in name
    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
    if (invalidChars.test(newName)) {
      return { success: false, error: 'Name contains invalid characters' };
    }

    const parentDir = path.dirname(oldPath);
    const newPath = path.join(parentDir, newName);

    logger.main.info('[ProjectMigration] Renaming project from', oldPath, 'to', newPath);

    // Re-validate before proceeding
    const canMove = await this.canMoveProject(oldPath);
    if (!canMove.canMove) {
      return { success: false, error: canMove.reason };
    }

    // Validate destination doesn't exist
    if (existsSync(newPath)) {
      return { success: false, error: 'Destination already exists' };
    }

    let claudeDirRenamed = false;
    let oldClaudePath: string | null = null;
    let newClaudePath: string | null = null;

    try {
      // Step 1: Create database backup
      logger.main.info('[ProjectMigration] Creating database backup...');
      const backupResult = await this.dbWorker.createBackup();
      if (!backupResult.success) {
        return { success: false, error: `Failed to create backup: ${backupResult.error}` };
      }
      logger.main.info('[ProjectMigration] Database backup created successfully');

      // Step 2: Atomic rename of project directory
      // fs.rename() is a single OS call (rename(2)) - no copy+delete, no race window
      logger.main.info('[ProjectMigration] Renaming project directory (atomic)...');
      await fs.rename(oldPath, newPath);
      logger.main.info('[ProjectMigration] Project directory renamed');

      // Step 3: Rename Claude Code session directory
      const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');
      oldClaudePath = path.join(claudeProjectsDir, encodeWorkspaceDir(oldPath));
      newClaudePath = path.join(claudeProjectsDir, encodeWorkspaceDir(newPath));

      if (existsSync(oldClaudePath)) {
        logger.main.info('[ProjectMigration] Renaming Claude session directory...');
        await fs.rename(oldClaudePath, newClaudePath);
        claudeDirRenamed = true;
        logger.main.info('[ProjectMigration] Claude session directory renamed');
      }

      // Step 4: Update database tables
      logger.main.info('[ProjectMigration] Updating database records...');
      await this.migrateDatabase(oldPath, newPath);
      logger.main.info('[ProjectMigration] Database records updated');

      // Step 5: Migrate workspace settings
      logger.main.info('[ProjectMigration] Migrating workspace settings...');
      await this.migrateWorkspaceSettings(oldPath, newPath);
      logger.main.info('[ProjectMigration] Workspace settings migrated');

      // Step 6: Update recent workspaces
      logger.main.info('[ProjectMigration] Updating recent workspaces...');
      this.updateRecentWorkspaces(oldPath, newPath);
      logger.main.info('[ProjectMigration] Recent workspaces updated');

      logger.main.info('[ProjectMigration] Project renamed successfully');
      return { success: true, newPath };

    } catch (error: any) {
      logger.main.error('[ProjectMigration] Rename failed, rolling back:', error);

      // Rollback: Rename project directory back
      // If the directory was renamed but a later step failed, rename it back
      if (existsSync(newPath) && !existsSync(oldPath)) {
        try {
          await fs.rename(newPath, oldPath);
          logger.main.info('[ProjectMigration] Rollback: Renamed project directory back');
        } catch (rollbackError) {
          logger.main.error('[ProjectMigration] Rollback failed: Could not rename project directory back:', rollbackError);
        }
      }

      // Rollback: Rename Claude directory back
      if (claudeDirRenamed && oldClaudePath && newClaudePath) {
        try {
          await fs.rename(newClaudePath, oldClaudePath);
          logger.main.info('[ProjectMigration] Rollback: Renamed Claude directory back');
        } catch (rollbackError) {
          logger.main.error('[ProjectMigration] Rollback failed: Could not rename Claude directory back:', rollbackError);
        }
      }

      return { success: false, error: error.message || 'Rename failed' };
    }
  }

  /**
   * Update database records with new workspace path.
   */
  private async migrateDatabase(oldPath: string, newPath: string): Promise<void> {
    // Update ai_sessions
    await this.dbWorker.query(
      'UPDATE ai_sessions SET workspace_id = $1 WHERE workspace_id = $2',
      [newPath, oldPath]
    );

    // Update session_files
    await this.dbWorker.query(
      'UPDATE session_files SET workspace_id = $1 WHERE workspace_id = $2',
      [newPath, oldPath]
    );

    // Update document_history
    await this.dbWorker.query(
      'UPDATE document_history SET workspace_id = $1 WHERE workspace_id = $2',
      [newPath, oldPath]
    );

    // Update tracker_items
    await this.dbWorker.query(
      'UPDATE tracker_items SET workspace = $1 WHERE workspace = $2',
      [newPath, oldPath]
    );

    // Update worktrees (shouldn't have any if we passed validation, but just in case)
    await this.dbWorker.query(
      'UPDATE worktrees SET workspace_id = $1 WHERE workspace_id = $2',
      [newPath, oldPath]
    );

    // Rewrite absolute file_path prefixes for rows now in the new workspace.
    // Done in JS rather than SQL string surgery: the prior
    // `$1 || SUBSTRING(file_path FROM LENGTH($2) + 1)` form is PostgreSQL-only
    // and the PG->SQLite dialect translator mangles both the `SUBSTRING(... FROM
    // ...)` syntax and the text `||` (which it rewrites to json_patch). A
    // SELECT + per-row UPDATE works identically on PGLite and SQLite. (NIM-807)
    await this.rewriteFilePathPrefix('ai_sessions', oldPath, newPath);
    await this.rewriteFilePathPrefix('session_files', oldPath, newPath);
    await this.rewriteFilePathPrefix('document_history', oldPath, newPath);
  }

  /**
   * Rewrite absolute `file_path` values in a table so a leading `oldPath`
   * prefix becomes `newPath`. Assumes `workspace_id` has already been migrated
   * to `newPath`. Backend-agnostic: no PG-specific SQL.
   */
  private async rewriteFilePathPrefix(
    table: 'ai_sessions' | 'session_files' | 'document_history',
    oldPath: string,
    newPath: string
  ): Promise<void> {
    const result = await this.dbWorker.query<{ id: string | number; file_path: string | null }>(
      `SELECT id, file_path FROM ${table} WHERE workspace_id = $1`,
      [newPath]
    );

    for (const row of result.rows) {
      const filePath = row.file_path;
      if (typeof filePath !== 'string' || !filePath.startsWith(oldPath)) {
        continue;
      }
      const updated = newPath + filePath.substring(oldPath.length);
      await this.dbWorker.query(
        `UPDATE ${table} SET file_path = $1 WHERE id = $2`,
        [updated, row.id]
      );
    }
  }

  /**
   * Migrate workspace settings from old key to new key.
   */
  private async migrateWorkspaceSettings(oldPath: string, newPath: string): Promise<void> {
    // Get the electron-store for workspace settings
    // We need to access it directly since the exported functions don't expose key migration
    const ElectronStore = require('electron-store');
    const workspaceStore = new ElectronStore({
      name: 'workspace-settings',
      cwd: app.getPath('userData'),
    });

    const oldKey = workspaceKey(oldPath);
    const newKey = workspaceKey(newPath);

    // Get old workspace state
    const oldState = workspaceStore.get(oldKey);
    if (oldState) {
      // Update the workspacePath field
      oldState.workspacePath = newPath;

      // Update file paths in recentDocuments
      if (Array.isArray(oldState.recentDocuments)) {
        oldState.recentDocuments = oldState.recentDocuments.map((filePath: string) => {
          if (filePath.startsWith(oldPath)) {
            return newPath + filePath.substring(oldPath.length);
          }
          return filePath;
        });
      }

      // Update file paths in tabs
      if (oldState.tabs && Array.isArray(oldState.tabs.tabs)) {
        oldState.tabs.tabs = oldState.tabs.tabs.map((tab: any) => {
          if (tab.filePath && tab.filePath.startsWith(oldPath)) {
            return {
              ...tab,
              filePath: newPath + tab.filePath.substring(oldPath.length),
            };
          }
          return tab;
        });
      }

      // Update file paths in agenticTabs
      if (oldState.agenticTabs && Array.isArray(oldState.agenticTabs.tabs)) {
        oldState.agenticTabs.tabs = oldState.agenticTabs.tabs.map((tab: any) => {
          if (tab.filePath && tab.filePath.startsWith(oldPath)) {
            return {
              ...tab,
              filePath: newPath + tab.filePath.substring(oldPath.length),
            };
          }
          return tab;
        });
      }

      // Update lastUpdated
      oldState.lastUpdated = Date.now();

      // Write to new key and delete old key
      workspaceStore.set(newKey, oldState);
      workspaceStore.delete(oldKey);
      logger.main.info('[ProjectMigration] Workspace settings migrated from', oldKey, 'to', newKey);
    }
  }

  /**
   * Update recent workspaces list with new path.
   */
  private updateRecentWorkspaces(oldPath: string, newPath: string): void {
    const recentWorkspaces = getRecentItems('workspaces');
    const newName = path.basename(newPath);

    // Find and update the entry with the old path
    const updated = recentWorkspaces.map(item => {
      if (item.path === oldPath) {
        return {
          ...item,
          path: newPath,
          name: newName,
          timestamp: Date.now(),
        };
      }
      return item;
    });

    // Save back to app store
    appStore.set('recent.workspaces', updated);
    logger.main.info('[ProjectMigration] Updated recent workspaces entry');
  }
}

// Singleton instance
let serviceInstance: ProjectMigrationService | null = null;

export function getProjectMigrationService(): ProjectMigrationService {
  if (!serviceInstance) {
    serviceInstance = new ProjectMigrationService();
  }
  return serviceInstance;
}
