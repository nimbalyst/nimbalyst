/**
 * SuperLoopService - Core orchestration for Super Loops
 *
 * Super Loops are an autonomous AI agent loop pattern that runs iteratively until a task is complete.
 * Each iteration starts with fresh context while state persists via files (progress tracking, git history).
 */

import { app, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { ulid } from 'ulid';
import * as fs from 'fs';
import * as path from 'path';
import simpleGit from 'simple-git';
import { getDatabase } from '../database/initialize';
import { createSuperLoopStore, type SuperLoopStore } from './SuperLoopStore';
import { createWorktreeStore, type WorktreeStore } from './WorktreeStore';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import {
  SUPER_LOOP_DEFAULTS,
  type SuperLoop,
  type SuperLoopWithIterations,
  type SuperLoopConfig,
  type SuperExitCondition,
  type SuperProgressFile,
  type SuperLoopEvent,
  type SuperPhase,
  type SuperIteration,
} from '../../shared/types/superLoop';
import { SuperLoopProgressService } from './SuperLoopProgressService';

const logger = log.scope('SuperLoopService');

const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Super Loop runner state
 */
interface SuperLoopRunnerState {
  loop: SuperLoop;
  worktreePath: string;
  workspaceId: string;
  isPaused: boolean;
  isStopped: boolean;
  currentSessionId: string | null;
  currentIterationId: string | null;
}

/**
 * SuperLoopService - Singleton service for managing Super Loops
 */
export class SuperLoopService {
  private static instance: SuperLoopService | null = null;
  private activeRunners: Map<string, SuperLoopRunnerState> = new Map();
  private superLoopStore: SuperLoopStore | null = null;
  private worktreeStore: WorktreeStore | null = null;

  private constructor() {}

  public static getInstance(): SuperLoopService {
    if (!SuperLoopService.instance) {
      SuperLoopService.instance = new SuperLoopService();
    }
    return SuperLoopService.instance;
  }

  /**
   * Initialize stores lazily
   */
  private async ensureStores(): Promise<{ superLoopStore: SuperLoopStore; worktreeStore: WorktreeStore }> {
    const db = getDatabase();
    if (!db) {
      throw new Error('Database not initialized');
    }

    if (!this.superLoopStore) {
      this.superLoopStore = createSuperLoopStore(db);
    }
    if (!this.worktreeStore) {
      this.worktreeStore = createWorktreeStore(db);
    }

    return { superLoopStore: this.superLoopStore, worktreeStore: this.worktreeStore };
  }

  /**
   * Recover super loops that were interrupted by app restart.
   * Called once at startup after handlers are registered.
   * Running loops -> paused, orphaned running iterations -> failed.
   */
  async recoverStaleLoopState(): Promise<void> {
    try {
      const { superLoopStore } = await this.ensureStores();
      const activeLoops = await superLoopStore.getActiveLoops();

      if (activeLoops.length === 0) {
        return;
      }

      logger.info('Recovering stale super loops', { count: activeLoops.length });

      for (const loop of activeLoops) {
        if (loop.status === 'running') {
          await superLoopStore.updateLoopStatus(loop.id, 'paused', 'Interrupted by app restart');
          logger.info('Recovered stale running loop -> paused', { id: loop.id });
        }
        await superLoopStore.failOrphanedIterations(loop.id);
      }

      logger.info('Stale super loop recovery complete');
    } catch (error) {
      logger.error('Failed to recover stale super loop state', { error });
    }
  }

  // ========================================
  // Super Loop Lifecycle
  // ========================================

  /**
   * Create a new Super Loop for a worktree
   */
  async createLoop(
    worktreeId: string,
    taskDescription: string,
    config?: SuperLoopConfig
  ): Promise<SuperLoop> {
    logger.info('Creating super loop', { worktreeId, taskDescription: taskDescription.slice(0, 100) });

    const { superLoopStore, worktreeStore } = await this.ensureStores();

    // Verify worktree exists
    const worktree = await worktreeStore.get(worktreeId);
    if (!worktree) {
      throw new Error(`Worktree not found: ${worktreeId}`);
    }

    // Check if there's already an active loop for this worktree
    const existingLoop = await superLoopStore.getLoopByWorktreeId(worktreeId);
    if (existingLoop && (existingLoop.status === 'running' || existingLoop.status === 'paused')) {
      throw new Error(`Worktree already has an active Super Loop: ${existingLoop.id}`);
    }

    const loopId = ulid();
    const maxIterations = config?.maxIterations ?? SUPER_LOOP_DEFAULTS.maxIterations;
    const modelId = config?.modelId;

    const loop = await superLoopStore.createLoop(loopId, worktreeId, taskDescription, maxIterations, modelId);

    // Initialize super loop files in the worktree
    await this.initializeSuperLoopFiles(worktree.path, taskDescription, maxIterations);

    logger.info('Super loop created', { id: loop.id, worktreeId, modelId });

    return loop;
  }

  /**
   * Start or resume a Super Loop
   */
  async startLoop(superLoopId: string): Promise<void> {
    logger.info('Starting super loop', { superLoopId });

    const { superLoopStore, worktreeStore } = await this.ensureStores();

    const loop = await superLoopStore.getLoop(superLoopId);
    if (!loop) {
      throw new Error(`Super loop not found: ${superLoopId}`);
    }

    if (loop.status === 'completed' || loop.status === 'failed') {
      throw new Error(`Cannot start a ${loop.status} super loop`);
    }

    // Check if already running
    if (this.activeRunners.has(superLoopId)) {
      const runner = this.activeRunners.get(superLoopId)!;
      if (runner.isPaused) {
        runner.isPaused = false;
        this.signalResume(superLoopId);
        this.emitEvent({ type: 'loop-resumed', superLoopId });
        return;
      }
      throw new Error('Super loop is already running');
    }

    // Get worktree info
    const worktree = await worktreeStore.get(loop.worktreeId);
    if (!worktree) {
      throw new Error(`Worktree not found: ${loop.worktreeId}`);
    }

    // Update status to running
    await superLoopStore.updateLoopStatus(superLoopId, 'running');

    // Create runner state
    const runnerState: SuperLoopRunnerState = {
      loop: { ...loop, status: 'running' },
      worktreePath: worktree.path,
      workspaceId: worktree.projectPath,
      isPaused: false,
      isStopped: false,
      currentSessionId: null,
      currentIterationId: null,
    };
    this.activeRunners.set(superLoopId, runnerState);

    // Start the loop asynchronously
    this.runLoop(superLoopId).catch(error => {
      logger.error('Super loop failed', { superLoopId, error });
      this.handleLoopError(superLoopId, error);
    });
  }

  /**
   * Pause a running Super Loop
   */
  async pauseLoop(superLoopId: string): Promise<void> {
    logger.info('Pausing super loop', { superLoopId });

    const runner = this.activeRunners.get(superLoopId);
    if (!runner) {
      throw new Error('Super loop is not running');
    }

    runner.isPaused = true;
    const { superLoopStore } = await this.ensureStores();
    await superLoopStore.updateLoopStatus(superLoopId, 'paused');

    this.emitEvent({ type: 'loop-paused', superLoopId });
  }

  /**
   * Stop a Super Loop
   */
  async stopLoop(superLoopId: string, reason: string = 'User stopped'): Promise<void> {
    logger.info('Stopping super loop', { superLoopId, reason });

    const runner = this.activeRunners.get(superLoopId);
    if (runner) {
      runner.isStopped = true;
      runner.isPaused = false;

      // Resolve pending session resolver so runLoop can exit cleanly
      if (runner.currentSessionId) {
        const sessionResolver = sessionCompleteResolvers.get(runner.currentSessionId);
        if (sessionResolver) {
          sessionCompleteResolvers.delete(runner.currentSessionId);
          sessionResolver({ success: false });
        }
      }

      // Resolve pending pause resolver so runLoop can exit cleanly
      const pauseResolver = pauseResolvers.get(superLoopId);
      if (pauseResolver) {
        pauseResolvers.delete(superLoopId);
        pauseResolver();
      }
    }

    const { superLoopStore } = await this.ensureStores();
    await superLoopStore.updateLoopStatus(superLoopId, 'completed', reason);

    this.activeRunners.delete(superLoopId);
    this.emitEvent({ type: 'loop-stopped', superLoopId, reason });
  }

  /**
   * Get a Super Loop iteration by its AI session ID
   */
  async getIterationBySessionId(sessionId: string): Promise<SuperIteration | null> {
    const { superLoopStore } = await this.ensureStores();
    return superLoopStore.getIterationBySessionId(sessionId);
  }

  /**
   * Continue a blocked Super Loop with user-provided feedback
   */
  async continueBlockedLoop(superLoopId: string, userFeedback: string): Promise<void> {
    logger.info('Continuing blocked super loop', { superLoopId });

    const { superLoopStore, worktreeStore } = await this.ensureStores();

    const loop = await superLoopStore.getLoop(superLoopId);
    if (!loop) {
      throw new Error(`Super loop not found: ${superLoopId}`);
    }

    // Only allow continuing blocked loops
    if (loop.status !== 'blocked') {
      throw new Error(`Cannot continue a ${loop.status} super loop - only blocked loops can be continued`);
    }

    // Get worktree to read/write progress file
    const worktree = await worktreeStore.get(loop.worktreeId);
    if (!worktree) {
      throw new Error(`Worktree not found: ${loop.worktreeId}`);
    }

    // Read current progress
    const progress = await this.readProgressFile(worktree.path);
    if (!progress || progress.status !== 'blocked') {
      throw new Error('Loop is not in blocked state');
    }

    // Update progress.json with user feedback and reset status
    const updatedProgress: SuperProgressFile = {
      ...progress,
      status: 'running',
      blockers: [], // Clear blockers
      userFeedback: userFeedback.trim(),
    };

    await this.writeProgressFile(worktree.path, updatedProgress);

    // Reset loop status to pending so startLoop can run
    await superLoopStore.updateLoopStatus(superLoopId, 'pending');

    // Start the loop
    await this.startLoop(superLoopId);
  }

  /**
   * Force-resume a completed/failed/blocked loop
   */
  async forceResumeLoop(
    superLoopId: string,
    options?: { bumpMaxIterations?: number; resetCompletionSignal?: boolean }
  ): Promise<void> {
    logger.info('Force-resuming super loop', { superLoopId, options });

    const { superLoopStore, worktreeStore } = await this.ensureStores();

    const loop = await superLoopStore.getLoop(superLoopId);
    if (!loop) {
      throw new Error(`Super loop not found: ${superLoopId}`);
    }

    if (loop.status === 'running') {
      throw new Error('Loop is already running');
    }

    const worktree = await worktreeStore.get(loop.worktreeId);
    if (!worktree) {
      throw new Error(`Worktree not found: ${loop.worktreeId}`);
    }

    // File operations first (can fail without leaving DB in inconsistent state)
    if (options?.resetCompletionSignal) {
      const progress = await this.readProgressFile(worktree.path);
      if (progress && progress.completionSignal) {
        await this.writeProgressFile(worktree.path, {
          ...progress,
          completionSignal: false,
          status: 'running',
        });
      }
    }

    // DB operations after file operations succeed
    if (options?.bumpMaxIterations && options.bumpMaxIterations > 0) {
      await superLoopStore.updateMaxIterations(superLoopId, loop.maxIterations + options.bumpMaxIterations);
    }

    await superLoopStore.updateLoopStatus(superLoopId, 'pending');
    await this.startLoop(superLoopId);
  }

  // ========================================
  // Loop Execution
  // ========================================

  /**
   * Main loop execution
   */
  private async runLoop(superLoopId: string): Promise<void> {
    logger.info('Running super loop', { superLoopId });

    const { superLoopStore } = await this.ensureStores();
    let consecutiveFailures = 0;

    while (true) {
      const runner = this.activeRunners.get(superLoopId);
      if (!runner || runner.isStopped) {
        logger.info('Super loop exiting: runner stopped or missing', { superLoopId, hasRunner: !!runner });
        return;
      }

      // Wait if paused using event-driven approach
      if (runner.isPaused) {
        await this.waitForResume(superLoopId);
      }

      if (runner.isStopped) {
        logger.info('Super loop exiting: stopped after resume', { superLoopId });
        return;
      }

      // Refresh loop state
      const loop = await superLoopStore.getLoop(superLoopId);
      if (!loop) {
        throw new Error('Super loop disappeared');
      }

      // Check max iterations
      if (loop.currentIteration >= loop.maxIterations) {
        logger.info('Super loop exiting: max iterations reached', {
          superLoopId,
          currentIteration: loop.currentIteration,
          maxIterations: loop.maxIterations,
        });
        await this.completeLoop(superLoopId, 'max_iterations', `Reached maximum iterations: ${loop.maxIterations}`);
        return;
      }

      // Check exit conditions from progress file
      const exitCondition = await this.checkExitConditions(runner.worktreePath);
      if (exitCondition) {
        logger.info('Super loop exiting: exit condition from progress file', {
          superLoopId,
          exitType: exitCondition.type,
          exitReason: exitCondition.reason,
          currentIteration: loop.currentIteration,
        });
        if (exitCondition.type === 'blocked') {
          await this.blockLoop(superLoopId, exitCondition.reason);
        } else {
          await this.completeLoop(superLoopId, exitCondition.type, exitCondition.reason);
        }
        return;
      }

      // Run next iteration
      try {
        logger.info('Super loop starting iteration', {
          superLoopId,
          nextIteration: loop.currentIteration + 1,
          consecutiveFailures,
        });
        await this.runIteration(superLoopId, runner);
        // Reset consecutive failures on success
        consecutiveFailures = 0;
        logger.info('Super loop iteration completed successfully', {
          superLoopId,
          iteration: loop.currentIteration + 1,
        });
      } catch (error) {
        consecutiveFailures++;
        logger.error('Iteration failed', {
          superLoopId,
          iteration: loop.currentIteration + 1,
          consecutiveFailures,
          error: error instanceof Error ? error.message : String(error),
        });

        // Mark iteration as failed
        if (runner.currentIterationId) {
          await superLoopStore.updateIterationStatus(runner.currentIterationId, 'failed',
            error instanceof Error ? error.message : 'Unknown error');
        }

        // Check if we've hit max consecutive failures
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logger.info('Super loop exiting: max consecutive failures', {
            superLoopId,
            consecutiveFailures,
          });
          await this.completeLoop(
            superLoopId,
            'error',
            `Stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive iteration failures`
          );
          return;
        }

        // Exponential backoff before retry (5s, 10s, 20s)
        const delayMs = 5000 * Math.pow(2, consecutiveFailures - 1);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  /**
   * Wait for a paused loop to be resumed or stopped
   */
  private waitForResume(superLoopId: string): Promise<void> {
    return new Promise((resolve) => {
      pauseResolvers.set(superLoopId, resolve);
    });
  }

  /**
   * Signal that a loop has been resumed
   */
  private signalResume(superLoopId: string): void {
    const resolver = pauseResolvers.get(superLoopId);
    if (resolver) {
      pauseResolvers.delete(superLoopId);
      resolver();
    }
  }

  /**
   * Run a single iteration
   */
  private async runIteration(superLoopId: string, runner: SuperLoopRunnerState): Promise<void> {
    const { superLoopStore } = await this.ensureStores();

    // Read current phase from progress file
    const progress = await this.readProgressFile(runner.worktreePath);
    const phase: SuperPhase = progress?.phase ?? 'planning';

    // Increment iteration counter
    const iterationNumber = await superLoopStore.incrementIteration(superLoopId);
    runner.loop.currentIteration = iterationNumber;

    logger.info('Starting super loop iteration', { superLoopId, iterationNumber, phase });

    // Create a new AI session for this iteration
    const sessionId = ulid();
    const iterationId = ulid();

    runner.currentSessionId = sessionId;
    runner.currentIterationId = iterationId;

    // Create the session in the database
    const phaseLabel = phase === 'planning' ? 'Plan' : 'Build';
    const model = runner.loop.modelId || 'claude-code:opus-1m';
    // Extract provider from model ID (format is "provider:model")
    const provider = model.includes(':') ? model.split(':')[0] : 'claude-code';
    await AISessionsRepository.create({
      id: sessionId,
      provider,
      model,
      title: `Super Loop ${phaseLabel} #${iterationNumber}`,
      workspaceId: runner.workspaceId,
      providerConfig: {
        workingDirectory: runner.worktreePath,
      },
      worktreeId: runner.loop.worktreeId,
    });

    // Create iteration record
    await superLoopStore.createIteration(iterationId, superLoopId, sessionId, iterationNumber);

    this.emitEvent({
      type: 'iteration-started',
      superLoopId,
      iterationId,
      iterationNumber,
      sessionId
    });

    // Generate the super loop prompt based on current phase
    const prompt = this.generateSuperLoopPrompt(phase);

    // Register session with the progress service so the MCP tool can find the worktree path
    const progressService = SuperLoopProgressService.getInstance();
    progressService.registerSession(sessionId, runner.worktreePath);

    // Send the prompt to Claude Code
    // This needs to be done via the renderer process which handles the AI communication
    // We'll emit an event that the renderer can listen to and process
    this.emitIterationPrompt(superLoopId, sessionId, prompt, runner.worktreePath, runner.workspaceId);

    // Inject progress snapshot at START of iteration (after prompt is emitted so the
    // snapshot messages don't exist when the renderer loads the session for ai:sendMessage)
    await this.injectProgressSnapshot(sessionId, runner.worktreePath, 'iteration-start', iterationNumber, superLoopId);

    // Wait for the session to complete
    // The renderer will call back when the session is done
    const result = await this.waitForSessionComplete(sessionId);

    // Unregister session from progress service
    progressService.unregisterSession(sessionId);

    if (result.success) {
      // Inject progress snapshot at END of iteration
      await this.injectProgressSnapshot(sessionId, runner.worktreePath, 'iteration-end', iterationNumber, superLoopId);

      // Mark iteration as completed
      await superLoopStore.updateIterationStatus(iterationId, 'completed');

      this.emitEvent({
        type: 'iteration-completed',
        superLoopId,
        iterationId,
        iterationNumber
      });
    } else {
      // Session was interrupted (window closed, user stopped, etc.)
      await superLoopStore.updateIterationStatus(iterationId, 'failed', 'Session interrupted');

      this.emitEvent({
        type: 'iteration-failed',
        superLoopId,
        iterationId,
        iterationNumber,
        error: 'Session interrupted'
      });

      throw new Error('Session interrupted');
    }
  }

  /**
   * Wait for a session to complete
   * No timeout - iterations can run as long as needed
   */
  private waitForSessionComplete(sessionId: string): Promise<{ success: boolean }> {
    logger.info('Waiting for session complete', {
      sessionId,
      pendingResolvers: sessionCompleteResolvers.size,
    });
    return new Promise((resolve) => {
      sessionCompleteResolvers.set(sessionId, (result: { success: boolean }) => {
        logger.info('Session complete resolver called', { sessionId, success: result.success });
        resolve(result);
      });
    });
  }

  /**
   * Called when a session completes (from renderer)
   */
  notifySessionComplete(sessionId: string, success: boolean = true): void {
    const resolver = sessionCompleteResolvers.get(sessionId);
    if (resolver) {
      logger.info('Resolving session complete', {
        sessionId,
        success,
        remainingResolvers: sessionCompleteResolvers.size - 1,
      });
      sessionCompleteResolvers.delete(sessionId);
      resolver({ success });
    } else {
      logger.warn('No resolver found for session complete', {
        sessionId,
        pendingResolvers: Array.from(sessionCompleteResolvers.keys()),
      });
    }
  }

  /**
   * Complete the loop
   */
  private async completeLoop(superLoopId: string, type: string, reason: string): Promise<void> {
    logger.info('Completing super loop', { superLoopId, type, reason });

    const { superLoopStore } = await this.ensureStores();
    await superLoopStore.updateLoopStatus(superLoopId, 'completed', `${type}: ${reason}`);

    this.activeRunners.delete(superLoopId);
    this.emitEvent({ type: 'loop-completed', superLoopId, reason });
  }

  /**
   * Block the loop (Claude indicated it's stuck and needs user input)
   */
  private async blockLoop(superLoopId: string, reason: string): Promise<void> {
    logger.info('Blocking super loop', { superLoopId, reason });

    const { superLoopStore } = await this.ensureStores();
    await superLoopStore.updateLoopStatus(superLoopId, 'blocked', reason);

    this.activeRunners.delete(superLoopId);
    this.emitEvent({ type: 'loop-blocked', superLoopId, reason });
  }

  /**
   * Handle loop error
   */
  private async handleLoopError(superLoopId: string, error: unknown): Promise<void> {
    logger.error('Super loop error', { superLoopId, error });

    const { superLoopStore } = await this.ensureStores();
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await superLoopStore.updateLoopStatus(superLoopId, 'failed', errorMessage);

    this.activeRunners.delete(superLoopId);
    this.emitEvent({ type: 'loop-failed', superLoopId, error: errorMessage });
  }

  // ========================================
  // File Management
  // ========================================

  /**
   * Initialize .superloop/ directory with task and config files
   */
  private async initializeSuperLoopFiles(
    worktreePath: string,
    taskDescription: string,
    maxIterations: number
  ): Promise<void> {
    const superLoopDir = path.join(worktreePath, '.superloop');

    // Create .superloop directory if it doesn't exist
    await fs.promises.mkdir(superLoopDir, { recursive: true });

    // Write task.md
    const taskPath = path.join(superLoopDir, 'task.md');
    await fs.promises.writeFile(taskPath, taskDescription, 'utf-8');

    // Write config.json
    const configPath = path.join(superLoopDir, 'config.json');
    const config = {
      maxIterations,
      createdAt: new Date().toISOString(),
    };
    await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

    // Write initial progress.json (atomic write with backup)
    const progress: SuperProgressFile = {
      currentIteration: 0,
      phase: 'planning',
      status: 'running',
      completionSignal: false,
      learnings: [],
      blockers: [],
    };
    await this.writeProgressFile(worktreePath, progress);

    // Create empty IMPLEMENTATION_PLAN.md
    const planPath = path.join(superLoopDir, 'IMPLEMENTATION_PLAN.md');
    await fs.promises.writeFile(planPath, '# Implementation Plan\n\n<!-- Generated by Super Loop - Claude will populate this during planning phase -->\n', 'utf-8');

    // Add .superloop to .gitignore if not already present
    await this.ensureSuperLoopInGitignore(worktreePath);

    logger.info('Super loop files initialized', { worktreePath });
  }

  /**
   * Ensure .superloop is in .gitignore
   */
  private async ensureSuperLoopInGitignore(worktreePath: string): Promise<void> {
    const gitignorePath = path.join(worktreePath, '.gitignore');

    try {
      let content = '';
      try {
        content = await fs.promises.readFile(gitignorePath, 'utf-8');
      } catch {
        // File doesn't exist, will create it
      }

      if (!content.includes('.superloop')) {
        const newContent = content.endsWith('\n') ? content + '.superloop/\n' : content + '\n.superloop/\n';
        await fs.promises.writeFile(gitignorePath, newContent, 'utf-8');
        logger.info('Added .superloop to .gitignore', { worktreePath });

        // Commit the .gitignore change so it's tracked immediately
        try {
          const git = simpleGit(worktreePath);
          await git.add('.gitignore');
          await git.commit('chore: add .superloop to .gitignore');
          logger.info('Committed .superloop addition to .gitignore', { worktreePath });
        } catch (commitError) {
          logger.warn('Failed to commit .gitignore update', { worktreePath, error: commitError });
        }
      }
    } catch (error) {
      logger.warn('Failed to update .gitignore', { worktreePath, error });
    }
  }

  /**
   * Read the progress file with fallback to backup on corruption
   */
  private async readProgressFile(worktreePath: string): Promise<SuperProgressFile | null> {
    const progressPath = path.join(worktreePath, '.superloop', 'progress.json');
    const backupPath = progressPath + '.bak';

    try {
      const content = await fs.promises.readFile(progressPath, 'utf-8');
      return JSON.parse(content) as SuperProgressFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }

      if (error instanceof SyntaxError) {
        logger.warn('Corrupt progress.json, trying backup', { worktreePath, error: error.message });
        try {
          const backupContent = await fs.promises.readFile(backupPath, 'utf-8');
          return JSON.parse(backupContent) as SuperProgressFile;
        } catch {
          logger.warn('Backup progress.json also unavailable, using default', { worktreePath });
          return {
            currentIteration: 0,
            phase: 'building',
            status: 'running',
            completionSignal: false,
            learnings: [],
            blockers: [],
          };
        }
      }

      logger.warn('Failed to read progress file', { worktreePath, error });
      return null;
    }
  }

  /**
   * Atomically write progress.json with backup.
   * Public so SuperLoopProgressService can delegate writes from the MCP tool.
   */
  async writeProgressFile(worktreePath: string, progress: SuperProgressFile): Promise<void> {
    const progressPath = path.join(worktreePath, '.superloop', 'progress.json');
    const tmpPath = progressPath + '.tmp';
    const backupPath = progressPath + '.bak';

    const data = JSON.stringify(progress, null, 2);

    await fs.promises.writeFile(tmpPath, data, 'utf-8');

    try {
      await fs.promises.copyFile(progressPath, backupPath);
    } catch {
      // Original may not exist on first write
    }

    await fs.promises.rename(tmpPath, progressPath);
  }

  /**
   * Inject a progress.json snapshot as a nimbalyst_tool_use message into the session.
   * This creates a visual widget in the chat transcript showing progress state at that moment.
   */
  private async injectProgressSnapshot(
    sessionId: string,
    worktreePath: string,
    timing: 'iteration-start' | 'iteration-end',
    iterationNumber: number,
    superLoopId: string
  ): Promise<void> {
    const progress = await this.readProgressFile(worktreePath);
    if (!progress) return;

    const now = new Date();
    const snapshotId = `super-loop-progress-${timing}-${iterationNumber}-${Date.now()}`;

    // Write nimbalyst_tool_use message (creates the tool call in the transcript)
    await AgentMessagesRepository.create({
      sessionId,
      source: 'nimbalyst',
      direction: 'output',
      createdAt: now,
      content: JSON.stringify({
        type: 'nimbalyst_tool_use',
        id: snapshotId,
        name: 'SuperProgressSnapshot',
        input: {
          timing,
          iterationNumber,
          superLoopId,
          progress,
          capturedAt: now.getTime(),
        },
      }),
    });

    // Write matching nimbalyst_tool_result so the widget renders as completed
    await AgentMessagesRepository.create({
      sessionId,
      source: 'nimbalyst',
      direction: 'output',
      createdAt: now,
      content: JSON.stringify({
        type: 'nimbalyst_tool_result',
        tool_use_id: snapshotId,
        result: JSON.stringify(progress),
      }),
    });

    logger.info('Injected progress snapshot', { sessionId, timing, iterationNumber });
  }

  // ========================================
  // Exit Condition Detection
  // ========================================

  /**
   * Check exit conditions from progress file
   */
  private async checkExitConditions(worktreePath: string): Promise<SuperExitCondition | null> {
    const progress = await this.readProgressFile(worktreePath);

    if (!progress) {
      return null;
    }

    // Check completion signal
    if (progress.completionSignal === true) {
      logger.info('Exit condition detected: completionSignal=true', {
        worktreePath,
        phase: progress.phase,
        status: progress.status,
        currentIteration: progress.currentIteration,
      });
      return { type: 'completed', reason: 'Task marked as complete in progress.json' };
    }

    // Check blocked status
    if (progress.status === 'blocked') {
      const blockerText = progress.blockers.length > 0
        ? progress.blockers.join(', ')
        : 'Unknown blocker';
      logger.info('Exit condition detected: status=blocked', {
        worktreePath,
        blockers: progress.blockers,
      });
      return { type: 'blocked', reason: blockerText };
    }

    return null;
  }

  // ========================================
  // Prompt Generation
  // ========================================

  /**
   * Generate the planning phase prompt
   * Based on Geoffrey Huntley's Ralph Loop methodology
   */
  private generatePlanPrompt(): string {
    return `0a. Study \`.superloop/task.md\` to understand the task requirements.
0b. Study \`@.superloop/IMPLEMENTATION_PLAN.md\` (if present) to understand the plan so far.
0c. Study the existing codebase to understand shared utilities, patterns, and components.
0d. Reference the project's CLAUDE.md for build commands and project conventions.
0e. Check the progress snapshots at the start of this session for \`learnings\` from previous iterations and \`userFeedback\` if present.

1. Study \`@.superloop/IMPLEMENTATION_PLAN.md\` (if present; it may be incomplete) and search the existing source code to compare against the task requirements. Analyze findings, prioritize tasks, and create/update \`@.superloop/IMPLEMENTATION_PLAN.md\` as a bullet point list sorted by priority of items yet to be implemented. Consider searching for TODO, minimal implementations, placeholders, skipped/flaky tests, and inconsistent patterns.

IMPORTANT: Plan only. Do NOT implement anything. Do NOT assume functionality is missing; confirm with code search first.

ULTIMATE GOAL: Read \`.superloop/task.md\` for the goal. Consider missing elements and plan accordingly. If an element is missing, search first to confirm it doesn't exist.

BEFORE YOU FINISH: You MUST call the \`super_loop_progress_update\` MCP tool as the LAST thing you do. This tool is how state is communicated between iterations. Call it with:
- \`phase\`: "building" (to signal the next iteration should begin building)
- \`status\`: "running"
- \`completionSignal\`: false
- \`learnings\`: include all previous learnings plus a new entry with \`{ "iteration": <current iteration number>, "summary": "<what you learned/decided this iteration>", "filesChanged": [<files you created or modified>] }\`
- \`blockers\`: [] (empty unless blocked)
- \`currentIteration\`: <your iteration number>
- If you are BLOCKED and cannot create a viable plan, set \`status\` to "blocked" and list blockers in the \`blockers\` array`;
  }

  /**
   * Generate the building phase prompt
   * Based on Geoffrey Huntley's Ralph Loop methodology
   */
  private generateBuildPrompt(): string {
    return `0a. Study \`.superloop/task.md\` to understand the task requirements.
0b. Study \`@.superloop/IMPLEMENTATION_PLAN.md\` to understand the current plan and priorities.
0c. Reference the project's CLAUDE.md for build commands and project conventions.
0d. Check the progress snapshots at the start of this session for \`learnings\` from previous iterations to avoid repeating work, and \`userFeedback\` if present (the user has provided guidance to help you).

1. Your task is to implement functionality per the task requirements. Follow \`@.superloop/IMPLEMENTATION_PLAN.md\` and choose the most important incomplete item to address. Before making changes, search the codebase (don't assume not implemented). Complete ONE item per iteration.

2. After implementing functionality, run the tests for that unit of code. If functionality is missing then add it per the task requirements.

3. When you discover issues, immediately update \`@.superloop/IMPLEMENTATION_PLAN.md\` with your findings. When resolved, mark the item complete or remove it.

4. When the tests pass, update \`@.superloop/IMPLEMENTATION_PLAN.md\`, then commit your changes with a descriptive message.

IMPORTANT RULES:
- Single sources of truth, no migrations/adapters. If tests unrelated to your work fail, resolve them as part of the increment.
- Keep \`@.superloop/IMPLEMENTATION_PLAN.md\` current with learnings - future iterations depend on this to avoid duplicating efforts.
- Implement functionality completely. Placeholders and stubs waste effort by requiring work to be redone.
- When \`@.superloop/IMPLEMENTATION_PLAN.md\` becomes large, clean out completed items.
- For any bugs you notice, resolve them or document them in \`@.superloop/IMPLEMENTATION_PLAN.md\`.

BEFORE YOU FINISH: You MUST call the \`super_loop_progress_update\` MCP tool as the LAST thing you do every iteration. This tool is how state is communicated between iterations - the next iteration starts with fresh context and depends on this. Call it with:
- \`learnings\`: include all previous learnings plus a new entry with \`{ "iteration": <current iteration number>, "summary": "<what you accomplished, key decisions, and anything the next iteration needs to know>", "filesChanged": [<files you created or modified>] }\`
- \`status\`: "running" if work remains
- \`completionSignal\`: true ONLY when ALL items in \`@.superloop/IMPLEMENTATION_PLAN.md\` are complete and the task from \`.superloop/task.md\` is fully satisfied
- \`phase\`: "building"
- \`blockers\`: [] (empty unless blocked)
- \`currentIteration\`: <your iteration number>
- If you are BLOCKED and cannot make progress, set \`status\` to "blocked" and list blockers in the \`blockers\` array`;
  }

  /**
   * Generate the system prompt for a super loop iteration
   * Selects plan or build prompt based on current phase
   */
  private generateSuperLoopPrompt(phase: 'planning' | 'building'): string {
    if (phase === 'planning') {
      return this.generatePlanPrompt();
    }
    return this.generateBuildPrompt();
  }

  // ========================================
  // Event Emission
  // ========================================

  /**
   * Emit a super loop event to all windows
   */
  private emitEvent(event: SuperLoopEvent): void {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send('super-loop:event', event);
      }
    }
  }

  /**
   * Emit an iteration prompt to a single renderer window for processing.
   * Only sends to one window to prevent duplicate AI session handling.
   * Prefers the focused window, falls back to the first non-destroyed window.
   */
  private emitIterationPrompt(
    superLoopId: string,
    sessionId: string,
    prompt: string,
    worktreePath: string,
    workspaceId: string
  ): void {
    const windows = BrowserWindow.getAllWindows();
    // Prefer focused window, fall back to first available
    const target = windows.find(w => !w.isDestroyed() && w.isFocused())
      || windows.find(w => !w.isDestroyed());
    if (!target) {
      throw new Error('No window available to send iteration prompt');
    }
    logger.info('Sending iteration prompt to window', {
      superLoopId,
      sessionId,
      windowId: target.id,
      totalWindows: windows.length,
    });
    target.webContents.send('super-loop:iteration-prompt', {
      superLoopId,
      sessionId,
      prompt,
      worktreePath,
      workspaceId,
    });
  }

  // ========================================
  // Query Methods
  // ========================================

  /**
   * Get a Super Loop by ID
   */
  async getLoop(superLoopId: string): Promise<SuperLoop | null> {
    const { superLoopStore } = await this.ensureStores();
    return superLoopStore.getLoop(superLoopId);
  }

  /**
   * Get a Super Loop by worktree ID
   */
  async getLoopByWorktreeId(worktreeId: string): Promise<SuperLoop | null> {
    const { superLoopStore } = await this.ensureStores();
    return superLoopStore.getLoopByWorktreeId(worktreeId);
  }

  /**
   * Get a Super Loop with all iterations
   */
  async getLoopWithIterations(superLoopId: string): Promise<SuperLoopWithIterations | null> {
    const { superLoopStore } = await this.ensureStores();
    return superLoopStore.getLoopWithIterations(superLoopId);
  }

  /**
   * Get all Super Loops for a workspace
   */
  async listLoops(workspaceId: string): Promise<SuperLoop[]> {
    const { superLoopStore } = await this.ensureStores();
    return superLoopStore.listLoops(workspaceId);
  }

  /**
   * Get runner state for a super loop
   */
  getRunnerState(superLoopId: string): SuperLoopRunnerState | undefined {
    return this.activeRunners.get(superLoopId);
  }

  /**
   * Get the progress file for a Super Loop
   */
  async getProgressFile(superLoopId: string): Promise<SuperProgressFile | null> {
    const { superLoopStore, worktreeStore } = await this.ensureStores();

    const loop = await superLoopStore.getLoop(superLoopId);
    if (!loop) {
      return null;
    }

    const worktree = await worktreeStore.get(loop.worktreeId);
    if (!worktree) {
      return null;
    }

    return this.readProgressFile(worktree.path);
  }

  /**
   * Update Super Loop metadata (title, archive, pin)
   */
  async updateLoop(
    superLoopId: string,
    updates: { title?: string; isArchived?: boolean; isPinned?: boolean }
  ): Promise<SuperLoop | null> {
    logger.info('Updating super loop', { superLoopId, updates });

    const { superLoopStore } = await this.ensureStores();
    return superLoopStore.updateLoop(superLoopId, updates);
  }

  /**
   * Delete a Super Loop
   */
  async deleteLoop(superLoopId: string): Promise<void> {
    // Stop if running
    if (this.activeRunners.has(superLoopId)) {
      await this.stopLoop(superLoopId, 'Deleted');
    }

    const { superLoopStore } = await this.ensureStores();
    await superLoopStore.deleteLoop(superLoopId);

    logger.info('Super loop deleted', { superLoopId });
  }
}

// Session completion resolvers (for waiting on sessions to complete)
const sessionCompleteResolvers = new Map<string, (result: { success: boolean }) => void>();

// Pause resolvers (for event-driven pause waiting)
const pauseResolvers = new Map<string, () => void>();

// Clean up dangling resolvers when all windows are closed.
// If the renderer process is gone, no session-complete notification
// can arrive, so resolve all pending promises to unblock runLoop.
app.on('window-all-closed', () => {
  if (sessionCompleteResolvers.size > 0) {
    logger.warn('All windows closed with pending session resolvers, resolving as interrupted', {
      count: sessionCompleteResolvers.size,
    });
    for (const [sessionId, resolver] of sessionCompleteResolvers) {
      sessionCompleteResolvers.delete(sessionId);
      resolver({ success: false });
    }
  }
  if (pauseResolvers.size > 0) {
    logger.warn('All windows closed with pending pause resolvers, resolving', {
      count: pauseResolvers.size,
    });
    for (const [loopId, resolver] of pauseResolvers) {
      pauseResolvers.delete(loopId);
      resolver();
    }
  }
});

// Export singleton getter
export function getSuperLoopService(): SuperLoopService {
  return SuperLoopService.getInstance();
}
