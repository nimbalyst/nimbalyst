/**
 * WorktreeStore - Database operations for worktree metadata
 *
 * Manages CRUD operations for worktrees table using PGLite.
 * Follows patterns from PGLiteSessionStore and PGLiteAgentMessagesStore.
 */

import log from 'electron-log/main';
import { toMillis } from '../utils/timestampUtils';

const logger = log.scope('WorktreeStore');

/**
 * Worktree data structure (matches runtime types and GitWorktreeService)
 */
export interface Worktree {
  id: string;
  name: string;
  displayName?: string; // User-friendly display name (set from first session named in this worktree)
  path: string;
  branch: string;
  baseBranch: string;
  projectPath: string; // Maps to workspace_id in database
  createdAt: number;
  updatedAt?: number;
  isPinned?: boolean; // Whether this worktree is pinned to the top of the list
  isArchived?: boolean; // Whether this worktree is archived
}

/**
 * Database row structure (matches worktrees table schema)
 */
interface WorktreeRow {
  id: string;
  workspace_id: string;
  name: string;
  display_name?: string;
  path: string;
  branch: string;
  base_branch: string;
  created_at: Date | string | number;
  updated_at: Date | string | number;
  is_pinned?: boolean;
  is_archived?: boolean;
}

/**
 * Database-like interface (matches what PGLite provides)
 */
type PGliteLike = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
};

type EnsureReadyFn = () => Promise<void>;

/**
 * Create a WorktreeStore instance
 */
export function createWorktreeStore(db: PGliteLike, ensureDbReady?: EnsureReadyFn) {
  const ensureReady = async () => {
    if (ensureDbReady) {
      await ensureDbReady();
    }
  };

  return {
    /**
     * Create a new worktree record
     */
    async create(worktree: Worktree): Promise<void> {
      await ensureReady();

      logger.info('Creating worktree record', { id: worktree.id, name: worktree.name, path: worktree.path });

      // Check for duplicate path
      const existingWorktree = await this.getByPath(worktree.path);
      if (existingWorktree) {
        throw new Error(`Worktree with path already exists in database: ${worktree.path}`);
      }

      const createdAt = new Date(worktree.createdAt);
      const updatedAt = new Date(worktree.updatedAt || worktree.createdAt);

      await db.query(
        `INSERT INTO worktrees (
          id, workspace_id, name, path, branch, base_branch, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8
        )`,
        [
          worktree.id,
          worktree.projectPath, // workspace_id in database
          worktree.name,
          worktree.path,
          worktree.branch,
          worktree.baseBranch,
          createdAt,
          updatedAt,
        ]
      );

      logger.info('Worktree record created', { id: worktree.id });
    },

    /**
     * Get a worktree by ID
     */
    async get(id: string): Promise<Worktree | null> {
      await ensureReady();

      // logger.info('Getting worktree', { id });

      const { rows } = await db.query<WorktreeRow>(
        `SELECT * FROM worktrees WHERE id = $1 LIMIT 1`,
        [id]
      );

      if (rows.length === 0) {
        logger.info('Worktree not found', { id });
        return null;
      }

      const row = rows[0];
      const worktree: Worktree = {
        id: row.id,
        name: row.name,
        displayName: row.display_name ?? undefined,
        path: row.path,
        branch: row.branch,
        baseBranch: row.base_branch,
        projectPath: row.workspace_id,
        createdAt: toMillis(row.created_at)!,
        updatedAt: toMillis(row.updated_at)!,
        isPinned: row.is_pinned ?? false,
        isArchived: row.is_archived ?? false,
      };

      return worktree;
    },

    /**
     * Get multiple worktrees by IDs in a single query
     */
    async getByIds(ids: string[]): Promise<Map<string, Worktree>> {
      await ensureReady();

      if (ids.length === 0) {
        return new Map();
      }

      // Build parameterized query: WHERE id IN ($1, $2, ...)
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await db.query<WorktreeRow>(
        `SELECT * FROM worktrees WHERE id IN (${placeholders})`,
        ids
      );

      const result = new Map<string, Worktree>();
      for (const row of rows) {
        result.set(row.id, {
          id: row.id,
          name: row.name,
          displayName: row.display_name ?? undefined,
          path: row.path,
          branch: row.branch,
          baseBranch: row.base_branch,
          projectPath: row.workspace_id,
          createdAt: toMillis(row.created_at)!,
          updatedAt: toMillis(row.updated_at)!,
          isPinned: row.is_pinned ?? false,
          isArchived: row.is_archived ?? false,
        });
      }

      return result;
    },

    /**
     * Get a worktree by path
     */
    async getByPath(path: string): Promise<Worktree | null> {
      await ensureReady();

      // logger.info('Getting worktree by path', { path });

      const { rows } = await db.query<WorktreeRow>(
        `SELECT * FROM worktrees WHERE path = $1 LIMIT 1`,
        [path]
      );

      if (rows.length === 0) {
        logger.info('Worktree not found', { path });
        return null;
      }

      const row = rows[0];
      const worktree: Worktree = {
        id: row.id,
        name: row.name,
        displayName: row.display_name ?? undefined,
        path: row.path,
        branch: row.branch,
        baseBranch: row.base_branch,
        projectPath: row.workspace_id,
        createdAt: toMillis(row.created_at)!,
        updatedAt: toMillis(row.updated_at)!,
        isPinned: row.is_pinned ?? false,
        isArchived: row.is_archived ?? false,
      };

      return worktree;
    },

    /**
     * List all worktrees for a workspace/project
     * By default, excludes archived worktrees
     */
    async list(workspaceId: string, includeArchived = false): Promise<Worktree[]> {
      await ensureReady();

      logger.info('Listing worktrees', { workspaceId, includeArchived });

      const archiveFilter = includeArchived ? '' : 'AND (is_archived = FALSE OR is_archived IS NULL)';
      const { rows } = await db.query<WorktreeRow>(
        `SELECT * FROM worktrees
         WHERE workspace_id = $1 ${archiveFilter}
         ORDER BY created_at DESC`,
        [workspaceId]
      );

      const worktrees = rows.map(row => ({
        id: row.id,
        name: row.name,
        displayName: row.display_name ?? undefined,
        path: row.path,
        branch: row.branch,
        baseBranch: row.base_branch,
        projectPath: row.workspace_id,
        createdAt: toMillis(row.created_at)!,
        updatedAt: toMillis(row.updated_at)!,
        isPinned: row.is_pinned ?? false,
        isArchived: row.is_archived ?? false,
      }));

      logger.info('Found worktrees', { count: worktrees.length });
      return worktrees;
    },

    /**
     * Update a worktree record
     */
    async update(id: string, updates: Partial<Omit<Worktree, 'id' | 'createdAt'>>): Promise<void> {
      await ensureReady();

      logger.info('Updating worktree', { id, updates });

      const fields: string[] = [];
      const values: any[] = [id];

      if (updates.name !== undefined) {
        fields.push(`name = $${values.length + 1}`);
        values.push(updates.name);
      }

      if (updates.path !== undefined) {
        fields.push(`path = $${values.length + 1}`);
        values.push(updates.path);
      }

      if (updates.branch !== undefined) {
        fields.push(`branch = $${values.length + 1}`);
        values.push(updates.branch);
      }

      if (updates.baseBranch !== undefined) {
        fields.push(`base_branch = $${values.length + 1}`);
        values.push(updates.baseBranch);
      }

      if (updates.projectPath !== undefined) {
        fields.push(`workspace_id = $${values.length + 1}`);
        values.push(updates.projectPath);
      }

      if (updates.displayName !== undefined) {
        fields.push(`display_name = $${values.length + 1}`);
        values.push(updates.displayName);
      }

      // Always update updated_at timestamp
      fields.push('updated_at = CURRENT_TIMESTAMP');

      if (fields.length === 1) {
        // Only updated_at, nothing else to update
        logger.info('No fields to update besides timestamp', { id });
      }

      const sql = `UPDATE worktrees SET ${fields.join(', ')} WHERE id = $1`;
      await db.query(sql, values);

      logger.info('Worktree updated', { id });
    },

    /**
     * Delete a worktree record
     */
    async delete(id: string): Promise<void> {
      await ensureReady();

      logger.info('Deleting worktree record', { id });

      await db.query('DELETE FROM worktrees WHERE id = $1', [id]);

      logger.info('Worktree record deleted', { id });
    },

    /**
     * Delete a worktree record by path
     */
    async deleteByPath(path: string): Promise<void> {
      await ensureReady();

      logger.info('Deleting worktree record by path', { path });

      await db.query('DELETE FROM worktrees WHERE path = $1', [path]);

      logger.info('Worktree record deleted', { path });
    },

    /**
     * Check if a worktree exists by path
     */
    async exists(path: string): Promise<boolean> {
      await ensureReady();

      const { rows } = await db.query<{ count: number }>(
        `SELECT COUNT(*) as count FROM worktrees WHERE path = $1`,
        [path]
      );

      return (rows[0]?.count || 0) > 0;
    },

    /**
     * Get all sessions associated with a worktree
     */
    async getWorktreeSessions(worktreeId: string): Promise<string[]> {
      await ensureReady();

      logger.info('Getting sessions for worktree', { worktreeId });

      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM ai_sessions WHERE worktree_id = $1 ORDER BY created_at DESC`,
        [worktreeId]
      );

      const sessionIds = rows.map(row => row.id);
      logger.info('Found sessions for worktree', { worktreeId, count: sessionIds.length });

      return sessionIds;
    },

    /**
     * Update display name only if it hasn't been set yet (atomic conditional update).
     * This is used to set the worktree's display name from the first session that gets named.
     *
     * @returns true if the display name was updated, false if it was already set
     */
    async updateDisplayNameIfEmpty(id: string, displayName: string): Promise<boolean> {
      await ensureReady();

      logger.info('Updating worktree display name if empty', { id, displayName });

      const { rows } = await db.query<{ affected: number }>(
        `UPDATE worktrees
         SET display_name = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND display_name IS NULL
         RETURNING 1 as affected`,
        [id, displayName]
      );

      const updated = rows.length > 0;
      logger.info('Worktree display name update result', { id, updated });

      return updated;
    },

    /**
     * Update the pinned status of a worktree
     */
    async updatePinned(id: string, isPinned: boolean): Promise<void> {
      await ensureReady();

      logger.info('Updating worktree pinned status', { id, isPinned });

      await db.query(
        `UPDATE worktrees
         SET is_pinned = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id, isPinned]
      );

      logger.info('Worktree pinned status updated', { id, isPinned });
    },

    /**
     * Update the archived status of a worktree
     */
    async updateArchived(id: string, isArchived: boolean): Promise<void> {
      await ensureReady();

      logger.info('Updating worktree archived status', { id, isArchived });

      await db.query(
        `UPDATE worktrees
         SET is_archived = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id, isArchived]
      );

      logger.info('Worktree archived status updated', { id, isArchived });
    },

    /**
     * Get all worktree names ever used (for de-duplication).
     * Returns names from all worktrees across all workspaces.
     */
    async getAllNames(): Promise<Set<string>> {
      await ensureReady();

      logger.info('Getting all worktree names for de-duplication');

      const { rows } = await db.query<{ name: string }>(
        `SELECT DISTINCT name FROM worktrees`
      );

      const names = new Set(rows.map(row => row.name));
      logger.info('Found worktree names', { count: names.size });

      return names;
    },
  };
}

/**
 * WorktreeStore type
 */
export type WorktreeStore = ReturnType<typeof createWorktreeStore>;

/**
 * Check for inconsistent worktree/session archive states at startup.
 *
 * This handles the case where the app crashed between archiving sessions and
 * marking the worktree as archived (Critical #2 in reliability improvements).
 *
 * Finds worktrees where isArchived=false but ALL associated sessions have isArchived=true,
 * then either completes the archive operation or reverts the session archiving.
 *
 * @param db - Database instance
 * @returns Array of inconsistencies found and how they were handled
 */
export async function checkWorktreeArchiveConsistency(
  db: { query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }> }
): Promise<Array<{ worktreeId: string; action: 'completed' | 'reverted' | 'error'; details: string }>> {
  const results: Array<{ worktreeId: string; action: 'completed' | 'reverted' | 'error'; details: string }> = [];

  try {
    logger.info('Running worktree archive consistency check...');

    // Find worktrees that are not archived but have all sessions archived
    // This query finds worktrees where:
    // 1. The worktree is NOT archived (is_archived = false OR is_archived IS NULL)
    // 2. The worktree has at least one session
    // 3. ALL sessions for this worktree ARE archived
    const { rows: inconsistentWorktrees } = await db.query<{
      worktree_id: string;
      worktree_path: string;
      session_count: number;
      archived_session_count: number;
    }>(`
      SELECT
        w.id as worktree_id,
        w.path as worktree_path,
        COUNT(s.id) as session_count,
        COUNT(CASE WHEN s.is_archived = true THEN 1 END) as archived_session_count
      FROM worktrees w
      INNER JOIN ai_sessions s ON s.worktree_id = w.id
      WHERE (w.is_archived = false OR w.is_archived IS NULL)
      GROUP BY w.id, w.path
      HAVING COUNT(s.id) > 0 AND COUNT(s.id) = COUNT(CASE WHEN s.is_archived = true THEN 1 END)
    `);

    const { rows: archivedWorktreesWithVisibleSessions } = await db.query<{
      worktree_id: string;
      worktree_path: string;
      session_count: number;
      visible_session_count: number;
    }>(`
      SELECT
        w.id as worktree_id,
        w.path as worktree_path,
        COUNT(s.id) as session_count,
        COUNT(CASE WHEN s.is_archived = false OR s.is_archived IS NULL THEN 1 END) as visible_session_count
      FROM worktrees w
      INNER JOIN ai_sessions s ON s.worktree_id = w.id
      WHERE w.is_archived = true
      GROUP BY w.id, w.path
      HAVING COUNT(CASE WHEN s.is_archived = false OR s.is_archived IS NULL THEN 1 END) > 0
    `);

    if (inconsistentWorktrees.length === 0 && archivedWorktreesWithVisibleSessions.length === 0) {
      logger.info('No worktree archive inconsistencies found');
      return results;
    }

    logger.warn('Found worktree archive inconsistencies', {
      count: inconsistentWorktrees.length + archivedWorktreesWithVisibleSessions.length,
      worktreeIds: inconsistentWorktrees.map(w => w.worktree_id),
      archivedWithVisibleSessions: archivedWorktreesWithVisibleSessions.map(w => w.worktree_id),
    });

    // For each inconsistent worktree, decide how to handle it
    for (const worktree of inconsistentWorktrees) {
      try {
        // Check if the worktree directory still exists on disk
        const fs = await import('fs');
        const directoryExists = fs.existsSync(worktree.worktree_path);

        if (directoryExists) {
          // Directory still exists - revert session archiving since cleanup didn't complete
          logger.warn('Worktree directory still exists, reverting session archiving', {
            worktreeId: worktree.worktree_id,
            path: worktree.worktree_path,
          });

          await db.query(
            `UPDATE ai_sessions SET is_archived = false WHERE worktree_id = $1`,
            [worktree.worktree_id]
          );

          results.push({
            worktreeId: worktree.worktree_id,
            action: 'reverted',
            details: `Directory still exists at ${worktree.worktree_path}, reverted ${worktree.session_count} sessions to non-archived`,
          });
        } else {
          // Directory doesn't exist - complete the archive by marking worktree as archived
          logger.info('Worktree directory does not exist, completing archive operation', {
            worktreeId: worktree.worktree_id,
            path: worktree.worktree_path,
          });

          await db.query(
            `UPDATE worktrees SET is_archived = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [worktree.worktree_id]
          );

          results.push({
            worktreeId: worktree.worktree_id,
            action: 'completed',
            details: `Directory no longer exists, marked worktree as archived with ${worktree.session_count} sessions`,
          });
        }
      } catch (error) {
        logger.error('Failed to resolve worktree inconsistency', {
          worktreeId: worktree.worktree_id,
          error,
        });
        results.push({
          worktreeId: worktree.worktree_id,
          action: 'error',
          details: `Failed to resolve: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    for (const worktree of archivedWorktreesWithVisibleSessions) {
      try {
        logger.warn('Archived worktree still has visible sessions, repairing session archive state', {
          worktreeId: worktree.worktree_id,
          visibleSessionCount: worktree.visible_session_count,
        });

        await db.query(
          `UPDATE ai_sessions
           SET is_archived = true
           WHERE worktree_id = $1 AND (is_archived = false OR is_archived IS NULL)`,
          [worktree.worktree_id]
        );

        results.push({
          worktreeId: worktree.worktree_id,
          action: 'completed',
          details: `Worktree already archived; marked ${worktree.visible_session_count} lingering session(s) as archived`,
        });
      } catch (error) {
        logger.error('Failed to repair archived worktree sessions', {
          worktreeId: worktree.worktree_id,
          error,
        });
        results.push({
          worktreeId: worktree.worktree_id,
          action: 'error',
          details: `Failed to repair archived sessions: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    logger.info('Worktree archive consistency check completed', {
      total: inconsistentWorktrees.length + archivedWorktreesWithVisibleSessions.length,
      completed: results.filter(r => r.action === 'completed').length,
      reverted: results.filter(r => r.action === 'reverted').length,
      errors: results.filter(r => r.action === 'error').length,
    });

    return results;
  } catch (error) {
    logger.error('Worktree archive consistency check failed', { error });
    return results;
  }
}
