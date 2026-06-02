/**
 * SuperLoopHandlers - IPC handlers for Super Loop operations
 *
 * Provides handlers for creating, starting, pausing, stopping, and querying Super Loops.
 * Super Loops automatically create their own worktree when created.
 */

import { ipcMain } from 'electron';
import log from 'electron-log/main';
import { getSuperLoopService } from '../services/SuperLoopService';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import type { SuperLoopConfig } from '../../shared/types/superLoop';
import { GitWorktreeService } from '../services/GitWorktreeService';
import { createWorktreeStore } from '../services/WorktreeStore';
import { getDatabase } from '../database/initialize';
import { wasProgressToolCalled, clearProgressToolCall } from '../mcp/superLoopProgressServer';

const logger = log.scope('SuperLoopHandlers');

let handlersRegistered = false;

/**
 * Register Super Loop IPC handlers
 */
export function registerSuperLoopHandlers(): void {
  if (handlersRegistered) {
    logger.info('Super loop handlers already registered');
    return;
  }

  const superLoopService = getSuperLoopService();

  /**
   * Create a new Super Loop
   *
   * Automatically creates a dedicated worktree for the Super Loop.
   *
   * @param workspacePath - Path to the main git repository
   * @param taskDescription - Description of the task for the loop
   * @param config - Optional configuration (maxIterations, etc.)
   */
  safeHandle('super-loop:create', async (
    _event,
    workspacePath: string,
    taskDescription: string,
    config?: SuperLoopConfig
  ) => {
    try {
      if (!workspacePath) {
        throw new Error('workspacePath is required');
      }
      if (!taskDescription || taskDescription.trim().length === 0) {
        throw new Error('taskDescription is required');
      }

      logger.info('Creating super loop with auto-worktree', {
        workspacePath,
        taskDescriptionLength: taskDescription.length,
      });

      // Step 1: Create a dedicated worktree for this Super Loop
      const db = getDatabase();
      if (!db) {
        throw new Error('Database not initialized');
      }

      const gitWorktreeService = new GitWorktreeService();
      const worktreeStore = createWorktreeStore(db);

      // Gather existing names for deduplication
      const [dbNames, filesystemNames, branchNames] = await Promise.all([
        worktreeStore.getAllNames(),
        Promise.resolve(gitWorktreeService.getExistingWorktreeDirectories(workspacePath)),
        gitWorktreeService.getAllBranchNames(workspacePath),
      ]);

      const existingNames = new Set<string>();
      for (const name of dbNames) existingNames.add(name);
      for (const name of filesystemNames) existingNames.add(name);
      for (const name of branchNames) existingNames.add(name);

      // Generate a unique worktree name
      const worktreeName = gitWorktreeService.generateUniqueWorktreeName(existingNames);

      logger.info('Creating worktree for super loop', { workspacePath, worktreeName });

      // Create the git worktree
      const worktree = await gitWorktreeService.createWorktree(workspacePath, { name: worktreeName });

      // Store worktree metadata in database
      await worktreeStore.create(worktree);

      logger.info('Worktree created for super loop', {
        worktreeId: worktree.id,
        worktreePath: worktree.path,
      });

      // Step 2: Create the Super Loop associated with this worktree
      const loop = await superLoopService.createLoop(worktree.id, taskDescription, config);

      // Step 3: Auto-start the loop (the UI button says "Create & Start")
      // We await the start so we can report errors to the UI
      try {
        await superLoopService.startLoop(loop.id);
      } catch (startErr) {
        logger.error('Failed to auto-start super loop:', startErr);
        // Return success for creation, but include start error
        return {
          success: true,
          loop,
          worktree,
          startError: startErr instanceof Error ? startErr.message : 'Failed to start loop',
        };
      }

      return {
        success: true,
        loop,
        worktree,
      };
    } catch (error) {
      logger.error('Failed to create super loop:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create super loop',
      };
    }
  });

  /**
   * Start or resume a Super Loop
   */
  safeHandle('super-loop:start', async (_event, superLoopId: string) => {
    try {
      if (!superLoopId) {
        throw new Error('superLoopId is required');
      }

      logger.info('Starting super loop', { superLoopId });

      await superLoopService.startLoop(superLoopId);

      return { success: true };
    } catch (error) {
      logger.error('Failed to start super loop:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start super loop',
      };
    }
  });

  /**
   * Pause a running Super Loop
   */
  safeHandle('super-loop:pause', async (_event, superLoopId: string) => {
    try {
      if (!superLoopId) {
        throw new Error('superLoopId is required');
      }

      logger.info('Pausing super loop', { superLoopId });

      await superLoopService.pauseLoop(superLoopId);

      return { success: true };
    } catch (error) {
      logger.error('Failed to pause super loop:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to pause super loop',
      };
    }
  });

  /**
   * Stop a Super Loop
   */
  safeHandle('super-loop:stop', async (_event, superLoopId: string, reason?: string) => {
    try {
      if (!superLoopId) {
        throw new Error('superLoopId is required');
      }

      logger.info('Stopping super loop', { superLoopId, reason });

      await superLoopService.stopLoop(superLoopId, reason);

      return { success: true };
    } catch (error) {
      logger.error('Failed to stop super loop:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop super loop',
      };
    }
  });

  /**
   * Continue a blocked Super Loop with user-provided feedback
   */
  safeHandle('super-loop:continue-blocked', async (_event, superLoopId: string, userFeedback: string) => {
    try {
      if (!superLoopId) {
        throw new Error('superLoopId is required');
      }
      if (!userFeedback || userFeedback.trim().length === 0) {
        throw new Error('userFeedback is required');
      }

      logger.info('Continuing blocked super loop', { superLoopId, feedbackLength: userFeedback.length });

      await superLoopService.continueBlockedLoop(superLoopId, userFeedback);

      return { success: true };
    } catch (error) {
      logger.error('Failed to continue blocked super loop:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to continue blocked loop',
      };
    }
  });

  /**
   * Force-resume a completed/failed/blocked Super Loop
   */
  safeHandle('super-loop:force-resume', async (
    _event,
    superLoopId: string,
    options?: { bumpMaxIterations?: number; resetCompletionSignal?: boolean }
  ) => {
    try {
      if (!superLoopId) {
        throw new Error('superLoopId is required');
      }

      logger.info('Force-resuming super loop', { superLoopId, options });

      await superLoopService.forceResumeLoop(superLoopId, options);

      return { success: true };
    } catch (error) {
      logger.error('Failed to force-resume super loop:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to force-resume super loop',
      };
    }
  });

  /**
   * Get a Super Loop by ID
   */
  safeHandle('super-loop:get', async (_event, superLoopId: string) => {
    try {
      if (!superLoopId) {
        throw new Error('superLoopId is required');
      }

      logger.info('Getting super loop', { superLoopId });

      const loop = await superLoopService.getLoop(superLoopId);

      return {
        success: true,
        loop,
      };
    } catch (error) {
      logger.error('Failed to get super loop:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get super loop',
        loop: null,
      };
    }
  });

  /**
   * Get a Super Loop by worktree ID
   */
  safeHandle('super-loop:get-by-worktree', async (_event, worktreeId: string) => {
    try {
      if (!worktreeId) {
        throw new Error('worktreeId is required');
      }

      // logger.info('Getting super loop by worktree', { worktreeId });

      const loop = await superLoopService.getLoopByWorktreeId(worktreeId);

      return {
        success: true,
        loop,
      };
    } catch (error) {
      logger.error('Failed to get super loop by worktree:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get super loop',
        loop: null,
      };
    }
  });

  /**
   * Get a Super Loop with all iterations
   */
  safeHandle('super-loop:get-with-iterations', async (_event, superLoopId: string) => {
    try {
      if (!superLoopId) {
        throw new Error('superLoopId is required');
      }

      logger.info('Getting super loop with iterations', { superLoopId });

      const loop = await superLoopService.getLoopWithIterations(superLoopId);

      return {
        success: true,
        loop,
      };
    } catch (error) {
      logger.error('Failed to get super loop with iterations:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get super loop',
        loop: null,
      };
    }
  });

  /**
   * Get all Super Loops for a workspace
   */
  safeHandle('super-loop:list', async (_event, workspaceId: string) => {
    try {
      if (!workspaceId) {
        throw new Error('workspaceId is required');
      }

      logger.info('Listing super loops', { workspaceId });

      const loops = await superLoopService.listLoops(workspaceId);

      return {
        success: true,
        loops,
      };
    } catch (error) {
      logger.error('Failed to list super loops:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list super loops',
        loops: [],
      };
    }
  });

  /**
   * Update Super Loop metadata (title, archive, pin)
   */
  safeHandle('super-loop:update', async (
    _event,
    superLoopId: string,
    updates: { title?: string; isArchived?: boolean; isPinned?: boolean }
  ) => {
    try {
      if (!superLoopId) {
        throw new Error('superLoopId is required');
      }

      logger.info('Updating super loop', { superLoopId, updates });

      const loop = await superLoopService.updateLoop(superLoopId, updates);

      return {
        success: true,
        loop,
      };
    } catch (error) {
      logger.error('Failed to update super loop:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update super loop',
      };
    }
  });

  /**
   * Delete a Super Loop
   */
  safeHandle('super-loop:delete', async (_event, superLoopId: string) => {
    try {
      if (!superLoopId) {
        throw new Error('superLoopId is required');
      }

      logger.info('Deleting super loop', { superLoopId });

      await superLoopService.deleteLoop(superLoopId);

      return { success: true };
    } catch (error) {
      logger.error('Failed to delete super loop:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete super loop',
      };
    }
  });

  /**
   * Get runner state (for UI to show current status)
   */
  safeHandle('super-loop:get-runner-state', async (_event, superLoopId: string) => {
    try {
      if (!superLoopId) {
        throw new Error('superLoopId is required');
      }

      const state = superLoopService.getRunnerState(superLoopId);

      return {
        success: true,
        state: state ? {
          isRunning: !state.isPaused && !state.isStopped,
          isPaused: state.isPaused,
          currentIteration: state.loop.currentIteration,
          maxIterations: state.loop.maxIterations,
          currentSessionId: state.currentSessionId,
        } : null,
      };
    } catch (error) {
      logger.error('Failed to get runner state:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get runner state',
        state: null,
      };
    }
  });

  /**
   * Get the progress file for a Super Loop
   */
  safeHandle('super-loop:get-progress', async (_event, superLoopId: string) => {
    try {
      if (!superLoopId) {
        throw new Error('superLoopId is required');
      }

      const progress = await superLoopService.getProgressFile(superLoopId);

      return {
        success: true,
        progress,
      };
    } catch (error) {
      logger.error('Failed to get super loop progress:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get super loop progress',
        progress: null,
      };
    }
  });

  /**
   * Notify that a session has completed (called from renderer)
   */
  safeOn('super-loop:session-complete', async (_event, sessionId: string, success?: boolean) => {
    logger.info('Super loop session complete notification', { sessionId, success });
    superLoopService.notifySessionComplete(sessionId, success ?? true);
  });

  /**
   * Check if the progress update MCP tool was called for a session
   */
  safeHandle('super-loop:was-progress-tool-called', async (_event, sessionId: string) => {
    if (!sessionId) {
      return { called: false };
    }
    return { called: wasProgressToolCalled(sessionId) };
  });

  /**
   * Clear the progress tool call tracking for a session (cleanup after iteration)
   */
  safeHandle('super-loop:clear-progress-tool-call', async (_event, sessionId: string) => {
    if (sessionId) {
      clearProgressToolCall(sessionId);
    }
    return { success: true };
  });

  /**
   * Get the Super Loop iteration for a given AI session ID
   * Used by the blocked feedback widget to look up the super loop ID
   */
  safeHandle('super-loop:get-iteration-by-session', async (_event, sessionId: string) => {
    try {
      if (!sessionId) {
        throw new Error('sessionId is required');
      }
      const iteration = await superLoopService.getIterationBySessionId(sessionId);
      return { success: true, iteration };
    } catch (error) {
      logger.error('Failed to get iteration by session:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get iteration',
        iteration: null,
      };
    }
  });

  handlersRegistered = true;
  logger.info('Super loop handlers registered');
}
