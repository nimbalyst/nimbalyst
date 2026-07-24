/**
 * Super Loop Types
 *
 * Super Loops are an autonomous AI agent loop pattern (heavily inspired by Ralph Loops)
 * that runs iteratively until a task is complete.
 * Each iteration starts with fresh context while state persists via files (progress tracking, git history).
 */

/**
 * Status of a Super Loop
 */
export type SuperLoopStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'blocked';

/**
 * Status of a single Super Loop iteration
 */
export type SuperIterationStatus = 'running' | 'completed' | 'failed';

/**
 * Exit condition types for why a Super Loop ended
 */
export type SuperExitConditionType =
  | 'completed' // Task marked as complete
  | 'max_iterations' // Reached maximum iteration limit
  | 'blocked' // Claude indicated it's stuck
  | 'user_stopped' // User manually stopped
  | 'error'; // Unrecoverable error

/**
 * Super Loop configuration and state (database model)
 */
export interface SuperLoop {
  id: string; // ULID
  worktreeId: string;
  taskDescription: string;
  title?: string; // User-editable display name (falls back to first line of taskDescription)
  status: SuperLoopStatus;
  currentIteration: number;
  maxIterations: number;
  modelId?: string; // Full provider:model ID (e.g. "claude-code:opus")
  completionReason?: string;
  isArchived?: boolean;
  isPinned?: boolean;
  createdAt: number; // Milliseconds timestamp
  updatedAt: number;
}

/**
 * Super Loop iteration record (database model)
 * Each iteration is linked to an AI session
 */
export interface SuperIteration {
  id: string; // ULID
  superLoopId: string;
  sessionId: string;
  iterationNumber: number;
  status: SuperIterationStatus;
  exitReason?: string;
  createdAt: number; // Milliseconds timestamp
  completedAt?: number;
}

/**
 * Super Loop with all its iterations
 */
export interface SuperLoopWithIterations extends SuperLoop {
  iterations: SuperIteration[];
}

/**
 * Configuration for creating a new Super Loop
 */
export interface SuperLoopConfig {
  maxIterations?: number;
  modelId?: string; // Full provider:model ID (e.g. "claude-code:opus")
}

/**
 * Exit condition detected during Super Loop execution
 */
export interface SuperExitCondition {
  type: SuperExitConditionType;
  reason: string;
}

/**
 * Phase of the Super Loop
 * - planning: Claude analyzes requirements and creates IMPLEMENTATION_PLAN.md
 * - building: Claude implements one item from the plan per iteration
 */
export type SuperPhase = 'planning' | 'building';

/**
 * Input for the super_loop_progress_update MCP tool.
 * Claude calls this tool at the end of each iteration to report progress.
 * The tool handler writes progress.json and records the call for verification.
 */
export interface SuperProgressUpdateInput {
  phase: SuperPhase;
  status: 'running' | 'completed' | 'blocked';
  completionSignal: boolean;
  learnings: SuperLearning[];
  blockers: string[];
  currentIteration: number;
}

/**
 * Progress file structure (.superloop/progress.json)
 * Written by the super_loop_progress_update MCP tool at each iteration
 */
export interface SuperProgressFile {
  currentIteration: number;
  phase: SuperPhase;
  status: 'running' | 'completed' | 'blocked';
  completionSignal: boolean;
  learnings: SuperLearning[];
  blockers: string[];
  userFeedback?: string; // User-provided context when continuing a blocked loop
}

/**
 * Learning captured from a single iteration
 */
export interface SuperLearning {
  iteration: number;
  summary: string;
  filesChanged: string[];
}

/**
 * Events emitted during Super Loop execution
 */
export type SuperLoopEvent =
  | { type: 'iteration-started'; superLoopId: string; iterationId: string; iterationNumber: number; sessionId: string }
  | { type: 'iteration-completed'; superLoopId: string; iterationId: string; iterationNumber: number; exitReason?: string }
  | { type: 'iteration-failed'; superLoopId: string; iterationId: string; iterationNumber: number; error: string }
  | { type: 'loop-completed'; superLoopId: string; reason: string }
  | { type: 'loop-blocked'; superLoopId: string; reason: string }
  | { type: 'loop-paused'; superLoopId: string }
  | { type: 'loop-resumed'; superLoopId: string }
  | { type: 'loop-stopped'; superLoopId: string; reason: string }
  | { type: 'loop-failed'; superLoopId: string; error: string };

/**
 * Default configuration values
 */
export const SUPER_LOOP_DEFAULTS = {
  maxIterations: 20,
} as const;
