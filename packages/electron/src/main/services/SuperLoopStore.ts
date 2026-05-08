/**
 * SuperLoopStore - Database operations for Super Loops
 *
 * Manages CRUD operations for super_loops and super_iterations tables using PGLite.
 * Follows patterns from WorktreeStore.
 */

import log from 'electron-log/main';
import { toMillis } from '../utils/timestampUtils';
import type {
  SuperLoop,
  SuperIteration,
  SuperLoopWithIterations,
  SuperLoopStatus,
  SuperIterationStatus,
} from '../../shared/types/superLoop';

const logger = log.scope('SuperLoopStore');

/**
 * Database row structure for super_loops table
 */
interface SuperLoopRow {
  id: string;
  worktree_id: string;
  task_description: string;
  title: string | null;
  status: string;
  current_iteration: number;
  max_iterations: number;
  model_id: string | null;
  completion_reason: string | null;
  is_archived: boolean | null;
  is_pinned: boolean | null;
  created_at: Date | string | number;
  updated_at: Date | string | number;
}

/**
 * Database row structure for super_iterations table
 */
interface SuperIterationRow {
  id: string;
  super_loop_id: string;
  session_id: string;
  iteration_number: number;
  status: string;
  exit_reason: string | null;
  created_at: Date | string | number;
  completed_at: Date | string | number | null;
}

/**
 * Database-like interface (matches what PGLite provides)
 */
type PGliteLike = {
  query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[] }>;
};

type EnsureReadyFn = () => Promise<void>;

/**
 * Convert row to SuperLoop
 */
function rowToSuperLoop(row: SuperLoopRow): SuperLoop {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    taskDescription: row.task_description,
    title: row.title ?? undefined,
    status: row.status as SuperLoopStatus,
    currentIteration: row.current_iteration,
    maxIterations: row.max_iterations,
    modelId: row.model_id ?? undefined,
    completionReason: row.completion_reason ?? undefined,
    isArchived: row.is_archived ?? false,
    isPinned: row.is_pinned ?? false,
    createdAt: toMillis(row.created_at)!,
    updatedAt: toMillis(row.updated_at)!,
  };
}

/**
 * Convert row to SuperIteration
 */
function rowToSuperIteration(row: SuperIterationRow): SuperIteration {
  return {
    id: row.id,
    superLoopId: row.super_loop_id,
    sessionId: row.session_id,
    iterationNumber: row.iteration_number,
    status: row.status as SuperIterationStatus,
    exitReason: row.exit_reason ?? undefined,
    createdAt: toMillis(row.created_at)!,
    completedAt: toMillis(row.completed_at) ?? undefined,
  };
}

/**
 * Create a SuperLoopStore instance
 */
export function createSuperLoopStore(db: PGliteLike, ensureDbReady?: EnsureReadyFn) {
  const ensureReady = async () => {
    if (ensureDbReady) {
      await ensureDbReady();
    }
  };

  return {
    // ========================================
    // Super Loop CRUD
    // ========================================

    /**
     * Create a new Super Loop
     */
    async createLoop(
      id: string,
      worktreeId: string,
      taskDescription: string,
      maxIterations: number = 20,
      modelId?: string
    ): Promise<SuperLoop> {
      await ensureReady();

      logger.info('Creating super loop', { id, worktreeId, maxIterations, modelId });

      const now = new Date();

      await db.query(
        `INSERT INTO super_loops (
          id, worktree_id, task_description, status, current_iteration, max_iterations, model_id, created_at, updated_at
        ) VALUES (
          $1, $2, $3, 'pending', 0, $4, $5, $6, $6
        )`,
        [id, worktreeId, taskDescription, maxIterations, modelId ?? null, now]
      );

      logger.info('Super loop created', { id });

      return {
        id,
        worktreeId,
        taskDescription,
        status: 'pending',
        currentIteration: 0,
        maxIterations,
        modelId,
        createdAt: now.getTime(),
        updatedAt: now.getTime(),
      };
    },

    /**
     * Get a Super Loop by ID
     */
    async getLoop(id: string): Promise<SuperLoop | null> {
      await ensureReady();

      logger.debug('Getting super loop', { id });

      const { rows } = await db.query<SuperLoopRow>(
        `SELECT * FROM super_loops WHERE id = $1 LIMIT 1`,
        [id]
      );

      if (rows.length === 0) {
        logger.debug('Super loop not found', { id });
        return null;
      }

      return rowToSuperLoop(rows[0]);
    },

    /**
     * Get a Super Loop by worktree ID
     */
    async getLoopByWorktreeId(worktreeId: string): Promise<SuperLoop | null> {
      await ensureReady();

      logger.debug('Getting super loop by worktree', { worktreeId });

      const { rows } = await db.query<SuperLoopRow>(
        `SELECT * FROM super_loops WHERE worktree_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [worktreeId]
      );

      if (rows.length === 0) {
        logger.debug('Super loop not found for worktree', { worktreeId });
        return null;
      }

      return rowToSuperLoop(rows[0]);
    },

    /**
     * Get all Super Loops for a workspace
     */
    async listLoops(workspaceId: string): Promise<SuperLoop[]> {
      await ensureReady();

      logger.debug('Listing super loops', { workspaceId });

      const { rows } = await db.query<SuperLoopRow>(
        `SELECT rl.* FROM super_loops rl
         JOIN worktrees w ON rl.worktree_id = w.id
         WHERE w.workspace_id = $1
         ORDER BY rl.created_at DESC`,
        [workspaceId]
      );

      const loops = rows.map(rowToSuperLoop);
      logger.debug('Found super loops', { count: loops.length });

      return loops;
    },

    /**
     * Update Super Loop status
     */
    async updateLoopStatus(
      id: string,
      status: SuperLoopStatus,
      completionReason?: string
    ): Promise<void> {
      await ensureReady();

      logger.info('Updating super loop status', { id, status, completionReason });

      if (completionReason !== undefined) {
        await db.query(
          `UPDATE super_loops
           SET status = $2, completion_reason = $3, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id, status, completionReason]
        );
      } else {
        await db.query(
          `UPDATE super_loops
           SET status = $2, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id, status]
        );
      }

      logger.info('Super loop status updated', { id, status });
    },

    /**
     * Increment the current iteration counter
     */
    async incrementIteration(id: string): Promise<number> {
      await ensureReady();

      logger.info('Incrementing super loop iteration', { id });

      const { rows } = await db.query<{ current_iteration: number }>(
        `UPDATE super_loops
         SET current_iteration = current_iteration + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING current_iteration`,
        [id]
      );

      const newIteration = rows[0]?.current_iteration ?? 0;
      logger.info('Super loop iteration incremented', { id, iteration: newIteration });

      return newIteration;
    },

    /**
     * Update Super Loop metadata (title, archive, pin)
     */
    async updateLoop(
      id: string,
      updates: { title?: string; isArchived?: boolean; isPinned?: boolean }
    ): Promise<SuperLoop | null> {
      await ensureReady();

      logger.info('Updating super loop', { id, updates });

      const setClauses: string[] = [];
      const params: any[] = [id];
      let paramIndex = 2;

      if (updates.title !== undefined) {
        setClauses.push(`title = $${paramIndex++}`);
        params.push(updates.title);
      }
      if (updates.isArchived !== undefined) {
        setClauses.push(`is_archived = $${paramIndex++}`);
        params.push(updates.isArchived);
      }
      if (updates.isPinned !== undefined) {
        setClauses.push(`is_pinned = $${paramIndex++}`);
        params.push(updates.isPinned);
      }

      if (setClauses.length === 0) {
        return this.getLoop(id);
      }

      setClauses.push('updated_at = CURRENT_TIMESTAMP');

      const { rows } = await db.query<SuperLoopRow>(
        `UPDATE super_loops SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
        params
      );

      if (rows.length === 0) {
        return null;
      }

      return rowToSuperLoop(rows[0]);
    },

    /**
     * Delete a Super Loop and all its iterations
     */
    async deleteLoop(id: string): Promise<void> {
      await ensureReady();

      logger.info('Deleting super loop', { id });

      // Iterations are deleted automatically via ON DELETE CASCADE
      await db.query('DELETE FROM super_loops WHERE id = $1', [id]);

      logger.info('Super loop deleted', { id });
    },

    // ========================================
    // Super Iteration CRUD
    // ========================================

    /**
     * Create a new Super Iteration
     */
    async createIteration(
      id: string,
      superLoopId: string,
      sessionId: string,
      iterationNumber: number
    ): Promise<SuperIteration> {
      await ensureReady();

      logger.info('Creating super iteration', { id, superLoopId, sessionId, iterationNumber });

      const now = new Date();

      await db.query(
        `INSERT INTO super_iterations (
          id, super_loop_id, session_id, iteration_number, status, created_at
        ) VALUES (
          $1, $2, $3, $4, 'running', $5
        )`,
        [id, superLoopId, sessionId, iterationNumber, now]
      );

      logger.info('Super iteration created', { id, iterationNumber });

      return {
        id,
        superLoopId,
        sessionId,
        iterationNumber,
        status: 'running',
        createdAt: now.getTime(),
      };
    },

    /**
     * Get all iterations for a Super Loop
     */
    async getIterations(superLoopId: string): Promise<SuperIteration[]> {
      await ensureReady();

      logger.debug('Getting super iterations', { superLoopId });

      const { rows } = await db.query<SuperIterationRow>(
        `SELECT * FROM super_iterations
         WHERE super_loop_id = $1
         ORDER BY iteration_number ASC`,
        [superLoopId]
      );

      const iterations = rows.map(rowToSuperIteration);
      logger.debug('Found super iterations', { count: iterations.length });

      return iterations;
    },

    /**
     * Get iteration by session ID
     */
    async getIterationBySessionId(sessionId: string): Promise<SuperIteration | null> {
      await ensureReady();

      logger.debug('Getting super iteration by session', { sessionId });

      const { rows } = await db.query<SuperIterationRow>(
        `SELECT * FROM super_iterations WHERE session_id = $1 LIMIT 1`,
        [sessionId]
      );

      if (rows.length === 0) {
        return null;
      }

      return rowToSuperIteration(rows[0]);
    },

    /**
     * Update iteration status
     */
    async updateIterationStatus(
      id: string,
      status: SuperIterationStatus,
      exitReason?: string
    ): Promise<void> {
      await ensureReady();

      logger.info('Updating super iteration status', { id, status, exitReason });

      if (status === 'completed' || status === 'failed') {
        await db.query(
          `UPDATE super_iterations
           SET status = $2, exit_reason = $3, completed_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [id, status, exitReason ?? null]
        );
      } else {
        await db.query(
          `UPDATE super_iterations
           SET status = $2, exit_reason = $3
           WHERE id = $1`,
          [id, status, exitReason ?? null]
        );
      }

      logger.info('Super iteration status updated', { id, status });
    },

    // ========================================
    // Combined Queries
    // ========================================

    /**
     * Get a Super Loop with all its iterations
     */
    async getLoopWithIterations(id: string): Promise<SuperLoopWithIterations | null> {
      await ensureReady();

      const loop = await this.getLoop(id);
      if (!loop) {
        return null;
      }

      const iterations = await this.getIterations(id);

      return {
        ...loop,
        iterations,
      };
    },

    /**
     * Get active (running or paused) Super Loops
     */
    async getActiveLoops(): Promise<SuperLoop[]> {
      await ensureReady();

      logger.debug('Getting active super loops');

      const { rows } = await db.query<SuperLoopRow>(
        `SELECT * FROM super_loops
         WHERE status IN ('running', 'paused')
         ORDER BY updated_at DESC`
      );

      const loops = rows.map(rowToSuperLoop);
      logger.debug('Found active super loops', { count: loops.length });

      return loops;
    },

    /**
     * Mark all running iterations for a loop as failed (startup recovery)
     */
    async failOrphanedIterations(superLoopId: string): Promise<number> {
      await ensureReady();

      const { rows } = await db.query<{ id: string }>(
        `UPDATE super_iterations
         SET status = 'failed', exit_reason = 'Interrupted by app restart', completed_at = CURRENT_TIMESTAMP
         WHERE super_loop_id = $1 AND status = 'running'
         RETURNING id`,
        [superLoopId]
      );

      if (rows.length > 0) {
        logger.info('Failed orphaned iterations', { superLoopId, count: rows.length });
      }
      return rows.length;
    },

    /**
     * Update the max iterations for a loop
     */
    async updateMaxIterations(id: string, maxIterations: number): Promise<void> {
      await ensureReady();

      logger.info('Updating max iterations', { id, maxIterations });

      await db.query(
        `UPDATE super_loops
         SET max_iterations = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id, maxIterations]
      );
    },
  };
}

/**
 * SuperLoopStore type
 */
export type SuperLoopStore = ReturnType<typeof createSuperLoopStore>;
