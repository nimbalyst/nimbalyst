import PrivateSettingsStore from '../utils/privateSettingsStore';
import { getProviderCredentials } from './credentials/providerCredentials';
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
import { createGit } from './gitClient';
import { clearProjectMoving, isProjectMoving, markProjectMoving } from './projectMoveRegistry';
import { sanitizeGitRepositoryEnv } from './gitRepositoryEnv';

// Import store utilities - we'll need to access the underlying stores directly
import {
  getRecentItems,
  invalidateWorkspaceStoreCache,
  store as appStore,
} from '../utils/store';
import { resolveClaudeConfigDir } from '@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir';

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
  /** Non-fatal problems after the files moved, e.g. a failed worktree relink */
  warnings?: string[];
}

export type MovePhase = 'backup' | 'moving' | 'moving-worktrees' | 'database' | 'repairing-worktrees';

interface PathPair {
  oldPath: string;
  newPath: string;
}

/** Nimbalyst's sibling worktree folder convention: `<parent>/<project>_worktrees` */
function worktreesDirFor(projectPath: string): string {
  return path.join(path.dirname(projectPath), `${path.basename(projectPath)}_worktrees`);
}

/**
 * Rename when source and destination share a volume (atomic, nothing copied);
 * copy when they do not. A copied source is left in place.
 */
async function moveDirectory(from: string, to: string): Promise<'renamed' | 'copied'> {
  try {
    await fs.rename(from, to);
    return 'renamed';
  } catch (error: any) {
    if (error?.code !== 'EXDEV') {
      throw error;
    }
    logger.main.info('[ProjectMigration] Different volume, copying', from, '->', to);
    await fs.cp(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    return 'copied';
  }
}

/**
 * ProjectMigrationService handles safe migration of projects to new locations.
 *
 * Migration is performed in this order:
 * 1. Validate preconditions (project not open, destination available)
 * 2. Create database backup
 * 3. Move the project directory and its `<project>_worktrees` sibling
 *    (rename on the same volume, copy across volumes; a copy's source is kept)
 * 4. Rename Claude Code session directories
 * 5. Update database records
 * 6. Migrate workspace settings and recent workspaces
 * 7. Relink git worktrees with `git worktree repair`
 *
 * If a step before 7 fails, directory renames are undone.
 */
export class ProjectMigrationService {
  private dbWorker: AppDatabase;

  constructor(dbWorker?: AppDatabase) {
    this.dbWorker = dbWorker || database;
  }

  /**
   * Check if a project can be moved.
   *
   * Worktrees do not block a move: the sibling `<project>_worktrees` folder
   * moves with the project and `git worktree repair` relinks it afterwards.
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

    if (isProjectMoving(oldPath)) {
      return { canMove: false, reason: 'This project is already being moved.' };
    }

    // Check if project is open in any window
    const window = findWindowByWorkspace(oldPath);
    if (window) {
      return { canMove: false, reason: 'Project is currently open. Please close it first.' };
    }

    return { canMove: true };
  }

  /**
   * Check everything a move to `newPath` needs before any work starts, so a
   * background move can report these errors synchronously.
   */
  async validateMove(oldPath: string, newPath: string): Promise<CanMoveResult> {
    const canMove = await this.canMoveProject(oldPath);
    if (!canMove.canMove) {
      return canMove;
    }
    if (existsSync(newPath)) {
      return { canMove: false, reason: 'Destination already exists' };
    }
    if (!existsSync(path.dirname(newPath))) {
      return { canMove: false, reason: 'Destination parent directory does not exist' };
    }
    if (existsSync(worktreesDirFor(oldPath)) && existsSync(worktreesDirFor(newPath))) {
      return {
        canMove: false,
        reason: `Destination worktrees folder already exists: ${worktreesDirFor(newPath)}`,
      };
    }
    return { canMove: true };
  }

  /**
   * Move a project to a new location.
   *
   * Same-volume moves use an atomic rename. Cross-volume moves copy, and the
   * original directory is intentionally NOT deleted: the user can delete it
   * after verifying the move. Automatic recursive deletion is too dangerous -
   * external apps with open file handles can corrupt state during the copy.
   *
   * @param oldPath - Current project path
   * @param newPath - Destination path (full path including project directory name)
   * @param onProgress - Called as the move enters each phase
   * @returns MoveResult indicating success or failure
   */
  async moveProject(
    oldPath: string,
    newPath: string,
    onProgress?: (phase: MovePhase) => void
  ): Promise<MoveResult> {
    logger.main.info('[ProjectMigration] Moving project from', oldPath, 'to', newPath);
    return this.relocate(oldPath, newPath, onProgress);
  }

  /**
   * Rename a project in place using atomic fs.rename().
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

    const newPath = path.join(path.dirname(oldPath), newName);
    logger.main.info('[ProjectMigration] Renaming project from', oldPath, 'to', newPath);
    return this.relocate(oldPath, newPath);
  }

  /**
   * Shared move/rename. Moves the project directory and its sibling
   * `<project>_worktrees` folder, then rewrites every record keyed by either
   * path and relinks git worktrees to the moved repository.
   */
  private async relocate(
    oldPath: string,
    newPath: string,
    onProgress?: (phase: MovePhase) => void
  ): Promise<MoveResult> {
    const valid = await this.validateMove(oldPath, newPath);
    if (!valid.canMove) {
      return { success: false, error: valid.reason };
    }

    markProjectMoving(oldPath);
    const oldWorktreesDir = worktreesDirFor(oldPath);
    const newWorktreesDir = worktreesDirFor(newPath);
    const moveWorktreesDir = existsSync(oldWorktreesDir);

    // Undo log for the renames; copies are never deleted.
    const renamed: Array<{ from: string; to: string }> = [];

    try {
      // Step 1: Create database backup
      onProgress?.('backup');
      logger.main.info('[ProjectMigration] Creating database backup...');
      const backupResult = await this.dbWorker.createBackup();
      if (!backupResult.success) {
        return { success: false, error: `Failed to create backup: ${backupResult.error}` };
      }

      // Collected before anything moves, while the old paths still resolve.
      const pairs: PathPair[] = [{ oldPath, newPath }];
      if (moveWorktreesDir) {
        for (const worktreePath of await this.collectWorktreePaths(oldPath, oldWorktreesDir)) {
          pairs.push({
            oldPath: worktreePath,
            newPath: newWorktreesDir + worktreePath.substring(oldWorktreesDir.length),
          });
        }
      }

      // Step 2: Move the project directory, then the worktrees folder
      onProgress?.('moving');
      if ((await moveDirectory(oldPath, newPath)) === 'renamed') {
        renamed.push({ from: oldPath, to: newPath });
      }
      if (moveWorktreesDir) {
        onProgress?.('moving-worktrees');
        if ((await moveDirectory(oldWorktreesDir, newWorktreesDir)) === 'renamed') {
          renamed.push({ from: oldWorktreesDir, to: newWorktreesDir });
        }
      }

      // Step 3: Rename Claude Code session directories (worktree sessions run
      // with the worktree as cwd, so each has its own directory)
      const claudeProjectsDir = path.join(resolveClaudeConfigDir(), 'projects');
      for (const pair of pairs) {
        const from = path.join(claudeProjectsDir, encodeWorkspaceDir(pair.oldPath));
        const to = path.join(claudeProjectsDir, encodeWorkspaceDir(pair.newPath));
        if (existsSync(from) && !existsSync(to)) {
          await fs.rename(from, to);
          renamed.push({ from, to });
        }
      }

      // Step 4: Update database tables
      onProgress?.('database');
      logger.main.info('[ProjectMigration] Updating database records...');
      for (const pair of pairs) {
        await this.migrateDatabase(pair.oldPath, pair.newPath);
      }

      // Step 5: Migrate workspace settings and recent workspaces
      for (const pair of pairs) {
        await this.migrateWorkspaceSettings(pair.oldPath, pair.newPath);
      }
      this.updateRecentWorkspaces(oldPath, newPath);

      // Step 6: Relink git worktrees. The move itself succeeded; a repair
      // failure is reported as a warning so the user can run it by hand.
      onProgress?.('repairing-worktrees');
      const warnings = await this.repairWorktrees(newPath);

      logger.main.info('[ProjectMigration] Project moved successfully to', newPath);
      return { success: true, newPath, ...(warnings.length > 0 ? { warnings } : {}) };
    } catch (error: any) {
      logger.main.error('[ProjectMigration] Move failed, rolling back renames:', error);
      // Renames are undone in reverse. A copy is never deleted: a partial
      // copy at the destination is better than losing data.
      for (const { from, to } of renamed.reverse()) {
        try {
          if (existsSync(to) && !existsSync(from)) {
            await fs.rename(to, from);
            logger.main.info('[ProjectMigration] Rollback: renamed back', to, '->', from);
          }
        } catch (rollbackError) {
          logger.main.error('[ProjectMigration] Rollback failed for', to, rollbackError);
        }
      }
      return { success: false, error: error.message || 'Move failed' };
    } finally {
      clearProjectMoving(oldPath);
    }
  }

  /**
   * Every workspace path under the project's worktrees folder that needs its
   * records rewritten: worktree rows plus any workspace id that session rows
   * recorded there, including worktrees deleted since.
   */
  private async collectWorktreePaths(projectPath: string, worktreesDir: string): Promise<string[]> {
    const prefix = worktreesDir + path.sep;
    const found = new Set<string>();
    const worktrees = await this.dbWorker.query<{ path: string }>(
      'SELECT path FROM worktrees WHERE workspace_id = $1',
      [projectPath]
    );
    for (const row of worktrees.rows) found.add(row.path);
    for (const table of ['ai_sessions', 'session_files', 'document_history']) {
      const result = await this.dbWorker.query<{ workspace_id: string }>(
        `SELECT DISTINCT workspace_id FROM ${table}`
      );
      for (const row of result.rows) found.add(row.workspace_id);
    }
    return [...found].filter((p) => typeof p === 'string' && p.startsWith(prefix));
  }

  /**
   * Point git's worktree links at the moved repository, in both directions.
   * Returns warnings instead of throwing: the files have already moved.
   */
  private async repairWorktrees(projectPath: string): Promise<string[]> {
    if (!existsSync(path.join(projectPath, '.git'))) {
      return [];
    }
    const result = await this.dbWorker.query<{ path: string }>(
      'SELECT path FROM worktrees WHERE workspace_id = $1',
      [projectPath]
    );
    const worktreePaths = new Set(result.rows.map((row) => row.path));
    // Checkouts in the worktrees folder that Nimbalyst has no row for.
    const worktreesDir = worktreesDirFor(projectPath);
    if (existsSync(worktreesDir)) {
      for (const entry of await fs.readdir(worktreesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) worktreePaths.add(path.join(worktreesDir, entry.name));
      }
    }
    const live = [...worktreePaths].filter((p) => existsSync(path.join(p, '.git')));
    if (live.length === 0) {
      return [];
    }
    try {
      const git = createGit(projectPath, {}, sanitizeGitRepositoryEnv(process.env));
      await git.raw(['worktree', 'repair', ...live]);
      logger.main.info('[ProjectMigration] Repaired', live.length, 'worktree link(s)');
      return [];
    } catch (error: any) {
      logger.main.warn('[ProjectMigration] git worktree repair failed:', error);
      return [
        `Worktrees moved, but relinking them failed. Run "git worktree repair" in ${projectPath}. (${error.message || error})`,
      ];
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

    // Update worktrees: rows owned by the project, and the worktree's own path
    await this.dbWorker.query(
      'UPDATE worktrees SET workspace_id = $1 WHERE workspace_id = $2',
      [newPath, oldPath]
    );
    await this.dbWorker.query(
      'UPDATE worktrees SET path = $1 WHERE path = $2',
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
    getProviderCredentials().moveWorkspace(oldPath, newPath);
    const workspaceStore = new PrivateSettingsStore<Record<string, any>>({
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
      // This writes the workspace-settings file through its own store instance,
      // so store.ts's read-through cache is now stale for both keys.
      invalidateWorkspaceStoreCache();
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
