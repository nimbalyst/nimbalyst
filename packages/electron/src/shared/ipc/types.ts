/**
 * Shared type definitions for IPC handler responses
 */

import type { Worktree } from '../../main/services/WorktreeStore';

/**
 * Response from worktree:create IPC handler
 */
export interface WorktreeCreateResult {
  success: boolean;
  worktree?: Worktree;
  error?: string;
}

/**
 * Response from sessions:create IPC handler
 */
export interface SessionCreateResult {
  success: boolean;
  id?: string;
  error?: string;
}

/**
 * Response from blitz:create IPC handler
 */
export interface BlitzCreateResult {
  success: boolean;
  blitzSessionId?: string;
  worktrees?: WorktreeCreateResult[];
  sessionIds?: string[];
  models?: string[];
  errors?: string[];
  error?: string;
}
