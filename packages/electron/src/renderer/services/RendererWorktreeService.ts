/**
 * RendererWorktreeService - Renderer-side facade for worktree operations
 *
 * Provides a clean interface for renderer components to interact with
 * git worktrees via IPC. Wraps the preload API methods.
 */

/**
 * Worktree data structure
 */
export interface Worktree {
  id: string;
  name: string;
  path: string;
  branch: string;
  baseBranch: string;
  projectPath: string;
  createdAt: number;
  updatedAt?: number;
}

/**
 * Git status summary for a worktree
 */
export interface WorktreeStatus {
  hasUncommittedChanges: boolean;
  modifiedFileCount: number;
  commitsAhead: number;
  commitsBehind: number;
  isMerged: boolean;
  /**
   * Number of commits that are truly unique to this branch (no equivalent on base).
   * Uses git cherry to compare by patch content rather than hash.
   * When undefined, uniqueCommitsAhead equals commitsAhead.
   */
  uniqueCommitsAhead?: number;
}

/**
 * IPC response wrapper
 */
interface IPCResponse<T> {
  success: boolean;
  error?: string;
  data?: T;
}

/**
 * Renderer service for worktree operations
 */
export class RendererWorktreeService {
  /**
   * Create a new git worktree
   *
   * @param workspacePath - Path to the main git repository
   * @param options - Optional name and baseBranch
   * @returns Worktree data including id, path, branch, etc.
   */
  async createWorktree(
    workspacePath: string,
    options?: { name?: string; baseBranch?: string }
  ): Promise<Worktree> {
    if (!window.electronAPI) {
      throw new Error('electronAPI not available');
    }

    const response = await window.electronAPI.worktreeCreate(workspacePath, options);

    if (!response.success || !response.worktree) {
      throw new Error(response.error || 'Failed to create worktree');
    }

    return response.worktree;
  }

  /**
   * Get git status for a worktree
   *
   * @param worktreePath - Path to the worktree directory
   * @returns Git status including uncommitted changes, commits ahead/behind
   */
  async getWorktreeStatus(worktreePath: string): Promise<WorktreeStatus> {
    if (!window.electronAPI) {
      throw new Error('electronAPI not available');
    }

    const response = await window.electronAPI.worktreeGetStatus(worktreePath);

    if (!response.success || !response.status) {
      throw new Error(response.error || 'Failed to get worktree status');
    }

    return response.status;
  }

  /**
   * Delete a git worktree
   *
   * @param worktreeId - ID of the worktree to delete
   * @param workspacePath - Path to the main git repository
   */
  async deleteWorktree(worktreeId: string, workspacePath: string): Promise<void> {
    if (!window.electronAPI) {
      throw new Error('electronAPI not available');
    }

    const response = await window.electronAPI.worktreeDelete(worktreeId, workspacePath);

    if (!response.success) {
      throw new Error(response.error || 'Failed to delete worktree');
    }
  }

  /**
   * List all worktrees for a workspace
   *
   * @param workspacePath - Path to the workspace/project
   * @returns Array of worktrees
   */
  async listWorktrees(workspacePath: string): Promise<Worktree[]> {
    if (!window.electronAPI) {
      throw new Error('electronAPI not available');
    }

    const response = await window.electronAPI.worktreeList(workspacePath);

    if (!response.success) {
      throw new Error(response.error || 'Failed to list worktrees');
    }

    return response.worktrees || [];
  }

  /**
   * Get a single worktree by ID
   *
   * @param worktreeId - ID of the worktree
   * @returns Worktree data or null if not found
   */
  async getWorktree(worktreeId: string): Promise<Worktree | null> {
    if (!window.electronAPI) {
      throw new Error('electronAPI not available');
    }

    const response = await window.electronAPI.worktreeGet(worktreeId);

    if (!response.success) {
      throw new Error(response.error || 'Failed to get worktree');
    }

    return response.worktree || null;
  }
}

/**
 * Singleton instance
 */
let instance: RendererWorktreeService | null = null;

/**
 * Get the singleton RendererWorktreeService instance
 */
export function getWorktreeService(): RendererWorktreeService {
  if (!instance) {
    instance = new RendererWorktreeService();
  }
  return instance;
}
