import { shellFileAttribution } from '../services/ai/codexShellTrackingHost';
import { resolve, relative, isAbsolute } from 'path';
import { SessionFilesRepository } from '@nimbalyst/runtime';
import { GitStatusService } from '../services/GitStatusService';
import { groupFilesByRoot, listRepoScanPaths, listWorkspaceRepos, resolveRepoForFile } from '../services/workspaceRepos';
import { safeHandle } from '../utils/ipcRegistry';

const gitStatusService = new GitStatusService();

export function registerGitStatusHandlers(): void {
  /**
   * Every repository this workspace spans, in root order.
   *
   * The renderer and the Git extension both need this to offer a repo picker
   * and to attribute a file to a repo. A single-folder workspace that is itself
   * a repo answers with exactly one entry -- which is what keeps every repo
   * picker hidden and every git call targeted at the same path as before.
   */
  safeHandle('git:list-workspace-repos', async (_event, workspacePath: string) => {
    if (!workspacePath) throw new Error('workspacePath is required');
    try {
      return { success: true, repos: listWorkspaceRepos(workspacePath) };
    } catch (error) {
      console.error('[GitStatusHandlers] Failed to list workspace repos:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list workspace repos',
        repos: [],
      };
    }
  });

  /**
   * The repository that owns one file, or null when it is in no repo.
   *
   * Unlike `git:list-workspace-repos` this walks up from the file, so it also
   * answers for submodules and repos nested below a root -- the cases pickers
   * deliberately leave out.
   */
  safeHandle('git:resolve-repo-for-file', async (_event, workspacePath: string, filePath: string) => {
    if (!workspacePath) throw new Error('workspacePath is required');
    if (!filePath) throw new Error('filePath is required');
    try {
      return { success: true, repoPath: resolveRepoForFile(workspacePath, filePath) };
    } catch (error) {
      console.error('[GitStatusHandlers] Failed to resolve repo for file:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to resolve repo for file',
        repoPath: null,
      };
    }
  });

  /**
   * Get git status for a list of files
   *
   * @param workspacePath The workspace/repository path
   * @param filePaths Array of file paths to check
   * @returns Git status for each file
   */
  safeHandle('git:get-file-status', async (_event, workspacePath: string, filePaths: string[]) => {
    try {
      // `getFileStatus` bounds its repo walk to the path it is given, so a file
      // in an attached folder resolves to no repo when asked against the
      // primary root alone. Ask each root for the files it owns and merge; the
      // reply is keyed by the caller's own path strings, so the merge is a
      // plain spread.
      const perRoot = await Promise.all(
        [...groupFilesByRoot(workspacePath, filePaths)].map(([rootPath, rootFiles]) =>
          gitStatusService.getFileStatus(rootPath, rootFiles),
        ),
      );
      return { success: true, status: Object.assign({}, ...perRoot) };
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
      // Scan every repo, not every root: a container root holding several
      // checkouts is not itself a repo, so asking git about it returns nothing.
      const perRepo = await Promise.all(
        listRepoScanPaths(workspacePath).map((repoPath) =>
          gitStatusService.getUncommittedFiles(repoPath),
        ),
      );
      const files = [...new Set(perRepo.flat())];
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
      // `getAllFileStatuses` bounds its repo walk to the path it is given, so a
      // multi-root workspace has to ask once per repo or attached folders get
      // no status badges at all. The result is keyed by absolute path, so the
      // merge is a plain object spread.
      const perRepo = await Promise.all(
        listRepoScanPaths(workspacePath).map((repoPath) =>
          gitStatusService.getAllFileStatuses(repoPath),
        ),
      );
      const statuses = Object.assign({}, ...perRepo);
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
      files: Array<{
        path: string;
        status: 'added' | 'modified' | 'deleted';
        /**
         * The repo that owns this file. The prompt groups on it so the agent
         * makes one commit proposal per repo -- a commit cannot span repos, and
         * a flat list gives the agent no way to know it needs several calls.
         */
        repo?: string;
      }>;
      scenario: 'single' | 'workstream' | 'worktree';
      error?: string;
    }> => {
      try {
        await shellFileAttribution.flush();
        const mapStatus = (s: string): 'added' | 'modified' | 'deleted' => {
          if (s === 'untracked') return 'added';
          if (s === 'deleted') return 'deleted';
          return 'modified';
        };

        // Worktree: return every uncommitted change in the worktree, not just the
        // current session's edits. The worktree isolates one workstream, so all of
        // it is this work.
        // Statuses for every repo the workspace spans, not just the primary
        // root -- otherwise an attached repo's changes never reach the prompt.
        const collectAllStatuses = async () => {
          const perRepo = await Promise.all(
            listRepoScanPaths(workspacePath).map((repoPath) =>
              gitStatusService.getAllFileStatuses(repoPath),
            ),
          );
          return Object.assign({}, ...perRepo) as Record<string, { filePath: string; status: string }>;
        };

        // Paths go into an AI prompt, so they have to be unambiguous. Files
        // under the primary root stay workspace-relative (what every consumer
        // already matches on); a file in an attached folder would relativize to
        // `../../…`, so it keeps its absolute path instead.
        const displayPath = (absPath: string): string => {
          const rel = relative(workspacePath, absPath);
          return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : absPath;
        };

        const owningRepo = (absPath: string): string | undefined =>
          resolveRepoForFile(workspacePath, absPath) ?? undefined;

        if (includeAllUncommitted) {
          const allStatuses = await collectAllStatuses();
          const files = Object.values(allStatuses).map(s => ({
            path: displayPath(s.filePath),
            status: mapStatus(s.status),
            repo: owningRepo(s.filePath),
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

        // Get all uncommitted file statuses, across every repo in the workspace
        const allStatuses = await collectAllStatuses();

        // Cross-reference: only session-edited files that still have uncommitted changes
        const seen = new Set<string>();
        const files: Array<{ path: string; status: 'added' | 'modified' | 'deleted'; repo?: string }> = [];

        for (const editedFile of editedFiles) {
          const absPath = editedFile.filePath.startsWith('/')
            ? editedFile.filePath
            : resolve(workspacePath, editedFile.filePath);

          if (seen.has(absPath)) continue;
          seen.add(absPath);

          const gitStatus = allStatuses[absPath];
          if (!gitStatus) continue;

          files.push({
            path: displayPath(absPath),
            status: mapStatus(gitStatus.status),
            repo: owningRepo(absPath),
          });
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
