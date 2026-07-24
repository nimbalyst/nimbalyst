import { resolve, relative } from 'path';
import { SessionFilesRepository } from '@nimbalyst/runtime';
import { GitStatusService } from '../services/GitStatusService';
import { safeHandle } from '../utils/ipcRegistry';

const gitStatusService = new GitStatusService();

export function registerGitStatusHandlers(): void {
  /**
   * Get git status for a list of files
   *
   * @param workspacePath The workspace/repository path
   * @param filePaths Array of file paths to check
   * @returns Git status for each file
   */
  safeHandle('git:get-file-status', async (_event, workspacePath: string, filePaths: string[]) => {
    try {
      const status = await gitStatusService.getFileStatus(workspacePath, filePaths);
      return { success: true, status };
    } catch (error) {
      console.error('[GitStatusHandlers] Failed to get file status:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get file status'
      };
    }
  });

  /**
   * Get all uncommitted files in the workspace
   * Returns files that are untracked or modified (not committed)
   *
   * @param workspacePath The workspace/repository path
   * @returns Array of file paths with uncommitted changes
   */
  safeHandle('git:get-uncommitted-files', async (_event, workspacePath: string) => {
    try {
      const files = await gitStatusService.getUncommittedFiles(workspacePath);
      return { success: true, files };
    } catch (error) {
      console.error('[GitStatusHandlers] Failed to get uncommitted files:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get uncommitted files',
        files: []
      };
    }
  });

  /**
   * Check if a workspace is a git repository
   *
   * @param workspacePath The workspace path to check
   * @returns Boolean indicating if workspace is a git repository
   */
  safeHandle('git:is-repo', async (_event, workspacePath: string) => {
    try {
      const isRepo = await gitStatusService.isGitRepo(workspacePath);
      return { success: true, isRepo };
    } catch (error) {
      console.error('[GitStatusHandlers] Failed to check if git repo:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check if git repo',
        isRepo: false
      };
    }
  });

  /**
   * Check if a workspace is a git worktree
   *
   * @param workspacePath The workspace path to check
   * @returns Boolean indicating if workspace is a git worktree
   */
  safeHandle('git:is-worktree', async (_event, workspacePath: string) => {
    try {
      const isWorktree = await gitStatusService.isGitWorktree(workspacePath);
      return { success: true, isWorktree };
    } catch (error) {
      console.error('[GitStatusHandlers] Failed to check if git worktree:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check if git worktree',
        isWorktree: false
      };
    }
  });

  /**
   * Get all files modified in the worktree relative to the main repository branch
   * Returns files that differ between the worktree branch and the main repo branch
   *
   * @param workspacePath The worktree path
   * @returns Array of file paths with modifications
   */
  safeHandle('git:get-worktree-modified-files', async (_event, workspacePath: string) => {
    try {
      const files = await gitStatusService.getWorktreeModifiedFiles(workspacePath);
      return { success: true, files };
    } catch (error) {
      console.error('[GitStatusHandlers] Failed to get worktree modified files:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get worktree modified files',
        files: []
      };
    }
  });

  /**
   * Get all files with changed git status in the workspace
   * Returns a map of absolute file paths to their git status (modified, staged, untracked, deleted)
   *
   * @param workspacePath The workspace/repository path
   * @returns Map of file paths to git status
   */
  safeHandle('git:get-all-file-statuses', async (_event, workspacePath: string) => {
    try {
      const statuses = await gitStatusService.getAllFileStatuses(workspacePath);
      return { success: true, statuses };
    } catch (error) {
      console.error('[GitStatusHandlers] Failed to get all file statuses:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get all file statuses',
        statuses: {}
      };
    }
  });

  /**
   * Get commit context for a session, used by "Commit with AI" to pre-fetch context
   * so the agent can skip discovery tool calls.
   *
   * Two modes:
   * - Default (shared checkout): session-edited files cross-referenced with git status,
   *   so a commit only picks up THIS session's work and never sweeps in unrelated
   *   uncommitted changes belonging to other concurrent sessions in the same repo.
   * - `includeAllUncommitted` (worktree): a worktree is the isolation boundary for a
   *   single workstream, so ALL uncommitted changes in it belong to this work. Return
   *   the full uncommitted set (like a workstream commits all its sessions' files),
   *   regardless of which session's tools touched each file.
   */
  safeHandle(
    'git:get-commit-context',
    async (
      _event,
      workspacePath: string,
      sessionId: string,
      childSessionIds?: string[],
      includeAllUncommitted?: boolean
    ): Promise<{
      success: boolean;
      files: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>;
      scenario: 'single' | 'workstream' | 'worktree';
      error?: string;
    }> => {
      try {
        const mapStatus = (s: string): 'added' | 'modified' | 'deleted' => {
          if (s === 'untracked') return 'added';
          if (s === 'deleted') return 'deleted';
          return 'modified';
        };

        // Worktree: return every uncommitted change in the worktree, not just the
        // current session's edits. The worktree isolates one workstream, so all of
        // it is this work.
        if (includeAllUncommitted) {
          const allStatuses = await gitStatusService.getAllFileStatuses(workspacePath);
          const files = Object.values(allStatuses).map(s => ({
            path: relative(workspacePath, s.filePath),
            status: mapStatus(s.status),
          }));
          return { success: true, files, scenario: 'worktree' as const };
        }

        const isWorkstream = childSessionIds && childSessionIds.length > 1;
        const scenario = isWorkstream ? 'workstream' as const : 'single' as const;

        // Get session-edited files
        let editedFiles: Array<{ filePath: string }>;
        if (isWorkstream) {
          editedFiles = await SessionFilesRepository.getFilesBySessionMany(childSessionIds, 'edited');
        } else {
          editedFiles = await SessionFilesRepository.getFilesBySession(sessionId, 'edited');
        }

        if (editedFiles.length === 0) {
          return { success: true, files: [], scenario };
        }

        // Get all uncommitted file statuses
        const allStatuses = await gitStatusService.getAllFileStatuses(workspacePath);

        // Cross-reference: only session-edited files that still have uncommitted changes
        const seen = new Set<string>();
        const files: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }> = [];

        for (const editedFile of editedFiles) {
          const absPath = editedFile.filePath.startsWith('/')
            ? editedFile.filePath
            : resolve(workspacePath, editedFile.filePath);

          if (seen.has(absPath)) continue;
          seen.add(absPath);

          const gitStatus = allStatuses[absPath];
          if (!gitStatus) continue;

          const relPath = relative(workspacePath, absPath);
          files.push({ path: relPath, status: mapStatus(gitStatus.status) });
        }

        return { success: true, files, scenario };
      } catch (error) {
        console.error('[GitStatusHandlers] Failed to get commit context:', error);
        return {
          success: false,
          files: [],
          scenario: 'single',
          error: error instanceof Error ? error.message : 'Failed to get commit context',
        };
      }
    }
  );

  /**
   * Clear the git status cache for a workspace
   *
   * @param workspacePath Optional workspace path (clears all if not specified)
   */
  safeHandle('git:clear-status-cache', async (_event, workspacePath?: string) => {
    try {
      gitStatusService.clearCache(workspacePath);
      return { success: true };
    } catch (error) {
      console.error('[GitStatusHandlers] Failed to clear cache:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to clear cache'
      };
    }
  });
}

/**
 * Clear cache for a specific workspace (utility function)
 * Called by other parts of the system when git operations occur
 */
export function clearGitStatusCache(workspacePath?: string): void {
  gitStatusService.clearCache(workspacePath);
}
