/**
 * Git IPC Handlers
 *
 * Handles git operations from the renderer process.
 */

import { ipcMain } from 'electron';
import simpleGit, { SimpleGit } from 'simple-git';
import log from 'electron-log/main';
import { existsSync } from 'fs';
import { join, relative, isAbsolute, resolve, parse as parsePath } from 'path';
import { gitOperationLock } from '../services/GitOperationLock';
import { executeGitCommit } from '../services/GitCommitService';
import { getGitSubprocessEnv, simpleGitWithHookEnv } from '../services/gitEnv';
import { safeHandle } from '../utils/ipcRegistry';
import { findGitRootForFile } from '../services/GitStatusService';
import { isFileInWorkspaceOrWorktree } from '../utils/workspaceDetection';
import { resolveGitContext } from '../services/GitContextService';
import {
  getGitOperationLogService,
  runGitCommandStreaming,
  withGitOperationLog,
} from '../services/GitOperationLogService';

/**
 * Resolve the repo root for a workspace, or null when it is not inside a
 * git repository. The root may be an ancestor of the workspace (#124).
 */
function gitRootFor(workspacePath: string): string | null {
  return resolveGitContext(workspacePath).gitRoot;
}

/**
 * Check if the repository has any commits (HEAD exists).
 * In a fresh repo, HEAD doesn't exist and commands like `git reset HEAD` or `git diff HEAD` will fail.
 */
async function hasCommits(git: SimpleGit): Promise<boolean> {
  try {
    await git.revparse(['HEAD']);
    return true;
  } catch {
    return false;
  }
}

export function isDetachedHeadState(branch: string | null | undefined): boolean {
  const normalized = branch?.trim();
  if (!normalized) return false;

  return normalized === 'HEAD'
    || normalized === '(no branch)'
    || normalized.startsWith('(HEAD detached')
    || normalized.startsWith('HEAD detached')
    || normalized.includes('no branch');
}

export function normalizeCurrentBranch(branch: string | null | undefined): string {
  const normalized = branch?.trim() || '';
  if (!normalized) return '';
  return isDetachedHeadState(normalized) ? 'HEAD' : normalized;
}

export function normalizeBranchSelection(branch: string | null | undefined): string | undefined {
  const normalized = branch?.trim();
  if (!normalized) return undefined;
  return isDetachedHeadState(normalized) ? 'HEAD' : normalized;
}

export function resolveGitDiffTarget(
  workspacePath: string,
  filePath: string
): { gitWorkspacePath: string; gitFilePath: string } {
  const resolvedWorkspacePath = resolve(workspacePath);
  const absoluteFilePath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(resolvedWorkspacePath, filePath);

  const relatedAbsolutePath = isAbsolute(filePath) && isFileInWorkspaceOrWorktree(absoluteFilePath, resolvedWorkspacePath)
    ? absoluteFilePath
    : null;
  // Files resolved as belonging to the workspace or a sibling worktree may live
  // outside the workspace's own repo root entirely (a linked worktree is a
  // separate working tree next to the main one), so this branch intentionally
  // is not bounded by gitRootFor(resolvedWorkspacePath) -- only by the
  // filesystem root -- to preserve the previous unbounded findNearestGitRoot walk.
  const gitWorkspacePath = relatedAbsolutePath
    ? findGitRootForFile(relatedAbsolutePath, parsePath(relatedAbsolutePath).root) ?? resolvedWorkspacePath
    : findGitRootForFile(filePath, gitRootFor(resolvedWorkspacePath) ?? resolvedWorkspacePath) ?? resolvedWorkspacePath;

  return {
    gitWorkspacePath,
    gitFilePath: relative(gitWorkspacePath, absoluteFilePath).replace(/\\/g, '/'),
  };
}

interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  hasUncommitted: boolean;
  baseBranch?: string;
  isMerged?: boolean;
}

interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
  refs?: string;
}

/**
 * Register all git-related IPC handlers
 */
export function registerGitHandlers(): void {
  const operationLog = getGitOperationLogService();

  safeHandle('git:operation-log:get', async (_event, workspacePath: string) => {
    if (!workspacePath) throw new Error('workspacePath is required');
    return operationLog.list(workspacePath);
  });

  safeHandle('git:operation-log:clear', async (_event, workspacePath: string) => {
    if (!workspacePath) throw new Error('workspacePath is required');
    await operationLog.clear(workspacePath);
    return { success: true };
  });

  /**
   * Get git status for a workspace or worktree
   */
  ipcMain.handle('git:status', async (_event, workspacePath: string): Promise<GitStatusResult> => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    const gitRoot = gitRootFor(workspacePath);
    if (!gitRoot) {
      return { branch: '', ahead: 0, behind: 0, hasUncommitted: false };
    }

    // core.optionalLocks=false tells git to skip the index refresh that would
    // create .git/index.lock, so this read can run concurrently with writes
    // (commit/rebase/etc.) without queueing behind them on gitOperationLock.
    try {
      const git: SimpleGit = simpleGit(gitRoot, { config: ['core.optionalLocks=false'] });
      const status = await git.status();
      const branch = normalizeCurrentBranch(status.current) || 'HEAD';

      return {
        branch,
        ahead: status.ahead || 0,
        behind: status.behind || 0,
        hasUncommitted: !status.isClean(),
      };
    } catch (error) {
      log.error('Failed to get git status:', error);
      throw error;
    }
  });

  /**
   * Get recent commits with optional filters
   */
  ipcMain.handle(
    'git:log',
    async (
      _event,
      workspacePath: string,
      limit: number = 10,
      options?: {
        branch?: string;
        author?: string;
        since?: string;
        until?: string;
        aheadBehind?: boolean;
      }
    ): Promise<GitCommit[]> => {
      if (!workspacePath) {
        throw new Error('workspacePath is required');
      }

      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) {
        return [];
      }

      try {
        const git: SimpleGit = simpleGit(gitRoot);

        if (!(await hasCommits(git))) {
          return [];
        }

        // Use a unique record separator that won't appear in commit messages
        const RS = '\x1e'; // ASCII Record Separator
        const rawArgs: string[] = [
          `--format=${RS}%H%n%s%n%an%n%ai%n%D`,
          `--max-count=${Math.min(limit, 200)}`,
        ];

        if (options?.author) {
          rawArgs.push(`--author=${options.author}`);
        }
        if (options?.since) {
          rawArgs.push(`--since=${options.since}`);
        }
        if (options?.until) {
          rawArgs.push(`--until=${options.until}`);
        }

        // Branch must be a positional arg after options
        const branchArg = normalizeBranchSelection(options?.branch);
        if (branchArg) {
          rawArgs.push(branchArg);
        }

        const rawOutput = await git.raw(['log', ...rawArgs]);

        if (!rawOutput.trim()) {
          return [];
        }

        // Parse the custom format output: hash, subject, author, date, refs
        const gitLog = rawOutput
          .split(RS)
          .filter(entry => entry.trim())
          .map(entry => {
            const lines = entry.trim().split('\n');
            if (lines.length < 4) return null;
            return {
              hash: lines[0]?.trim() || '',
              message: lines[1]?.trim() || '',
              author: lines[2]?.trim() || '',
              date: lines[3]?.trim() || '',
              refs: lines[4]?.trim() || '',
            };
          })
          .filter((c): c is NonNullable<typeof c> => c !== null && !!c.hash);

        return gitLog;
      } catch (error) {
        log.error('Failed to get git log:', error);
        throw error;
      }
    }
  );

  /**
   * List branches
   */
  safeHandle('git:branches', async (_event, workspacePath: string): Promise<{ branches: string[]; current: string }> => {
    if (!workspacePath) throw new Error('workspacePath is required');
    const gitRoot = gitRootFor(workspacePath);
    if (!gitRoot) return { branches: [], current: '' };

    try {
      const git: SimpleGit = simpleGit(gitRoot);
      const summary = await git.branch();
      let current = normalizeCurrentBranch(summary.current);
      let branches = summary.all;

      // In a freshly initialized repo with no commits, `git branch` reports no
      // branches even though `git status` knows the unborn branch name.
      if (!current) {
        const status = await git.status();
        current = normalizeCurrentBranch(status.current);
      }
      if (current && branches.length === 0) {
        branches = [current];
      }

      return {
        branches,
        current,
      };
    } catch (error) {
      log.error('[git:branches] Failed:', error);
      throw error;
    }
  });

  /**
   * Push current branch to remote
   */
  safeHandle(
    'git:push',
    async (_event, workspacePath: string, options?: { force?: boolean; setUpstream?: boolean; remote?: string; branch?: string }):
      Promise<{ success: boolean; error?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:push', async () => {
        try {
          const git: SimpleGit = simpleGitWithHookEnv(gitRoot);
          const status = await git.status();
          const branch = normalizeCurrentBranch(status.current);
          if (!branch || branch === 'HEAD') {
            return {
              success: false,
              error: 'You are in detached HEAD. Checkout a branch before pushing.',
            };
          }

          const pushArgs: string[] = ['push'];
          const remote = options?.remote || 'origin';

          if (options?.setUpstream) {
            pushArgs.push('--set-upstream');
          } else if (options?.force) {
            pushArgs.push('--force-with-lease');
          }

          pushArgs.push(remote, branch);
          const result = await runGitCommandStreaming(operationLog, workspacePath, pushArgs);
          return result.success ? { success: true } : { success: false, error: result.error };
        } catch (error) {
          log.error('[git:push] Failed:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      });
    }
  );

  /**
   * Pull from remote
   */
  safeHandle(
    'git:pull',
    async (_event, workspacePath: string, options?: { rebase?: boolean; ffOnly?: boolean }):
      Promise<{ success: boolean; error?: string; conflicts?: string[] }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:pull', async () => {
        try {
          const git: SimpleGit = simpleGitWithHookEnv(gitRoot);
          const status = await git.status();
          const branch = normalizeCurrentBranch(status.current);
          if (!branch || branch === 'HEAD') {
            return {
              success: false,
              error: 'You are in detached HEAD. Checkout a branch before pulling.',
            };
          }
          const pullArgs: string[] = ['pull'];
          if (options?.rebase) {
            pullArgs.push('--rebase');
          } else if (options?.ffOnly) {
            pullArgs.push('--ff-only');
          }
          const result = await runGitCommandStreaming(operationLog, workspacePath, pullArgs);
          if (!result.success) {
            const statusAfterFailure = await git.status();
            return { success: false, error: result.error, conflicts: statusAfterFailure.conflicted };
          }
          return { success: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.error('[git:pull] Failed:', error);

          // Check for conflict markers in error message
          if (message.includes('CONFLICT') || message.includes('conflict')) {
            const git: SimpleGit = simpleGit(gitRoot);
            const status = await git.status();
            return { success: false, error: message, conflicts: status.conflicted };
          }

          return { success: false, error: message };
        }
      });
    }
  );

  /**
   * Fetch from remote without merging
   */
  safeHandle(
    'git:fetch',
    async (_event, workspacePath: string, options?: { remote?: string }):
      Promise<{ success: boolean; error?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) return { success: false, error: 'Not a git repository' };

      try {
        const result = await runGitCommandStreaming(
          operationLog,
          workspacePath,
          ['fetch', options?.remote || 'origin'],
        );
        return result.success ? { success: true } : { success: false, error: result.error };
      } catch (error) {
        log.error('[git:fetch] Failed:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  /**
   * Start, continue, or abort a rebase
   */
  safeHandle(
    'git:rebase',
    async (_event, workspacePath: string, options: { target?: string; action?: 'continue' | 'abort' | 'skip' }):
      Promise<{ success: boolean; error?: string; conflicts?: string[] }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:rebase', async () => {
        const args = options.action
          ? ['rebase', `--${options.action}`]
          : options.target
            ? ['rebase', options.target]
            : null;
        if (!args) {
          throw new Error('rebase requires either a target branch or an action (continue/abort/skip)');
        }
        const result = await runGitCommandStreaming(operationLog, workspacePath, args);
        if (result.success) return { success: true };
        const status = await simpleGit(gitRoot).status();
        return { success: false, error: result.error, conflicts: status.conflicted };
      });
    }
  );

  /**
   * Get current rebase status and any conflict files
   */
  safeHandle(
    'git:rebase-status',
    async (_event, workspacePath: string):
      Promise<{ isRebasing: boolean; conflicts: string[]; currentCommit?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) return { isRebasing: false, conflicts: [] };

      try {
        const git: SimpleGit = simpleGit(gitRoot);

        // Check for REBASE_HEAD file as indicator of active rebase
        const rebaseHeadPath = join(gitRoot, '.git', 'REBASE_HEAD');
        const isRebasing = existsSync(rebaseHeadPath);

        if (!isRebasing) {
          return { isRebasing: false, conflicts: [] };
        }

        const status = await git.status();
        return {
          isRebasing: true,
          conflicts: status.conflicted,
        };
      } catch (error) {
        log.error('[git:rebase-status] Failed:', error);
        return { isRebasing: false, conflicts: [] };
      }
    }
  );

  /**
   * Set upstream tracking branch for current branch
   */
  safeHandle(
    'git:set-upstream',
    async (_event, workspacePath: string, remote: string, branch?: string):
      Promise<{ success: boolean; error?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!remote) throw new Error('remote is required');
      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) return { success: false, error: 'Not a git repository' };

      try {
        const git: SimpleGit = simpleGitWithHookEnv(gitRoot);
        const status = await git.status();
        const targetBranch = branch || normalizeCurrentBranch(status.current);
        if (!targetBranch || targetBranch === 'HEAD') {
          return {
            success: false,
            error: 'You are in detached HEAD. Checkout a branch before setting upstream.',
          };
        }
        const result = await runGitCommandStreaming(
          operationLog,
          workspacePath,
          ['push', '--set-upstream', remote, targetBranch],
        );
        return result.success ? { success: true } : { success: false, error: result.error };
      } catch (error) {
        log.error('[git:set-upstream] Failed:', error);
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  /**
   * Checkout a branch or commit hash (detached HEAD if hash)
   */
  safeHandle(
    'git:checkout',
    async (_event, workspacePath: string, ref: string):
      Promise<{ success: boolean; error?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!ref) throw new Error('ref is required');
      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:checkout', async () => {
        const result = await runGitCommandStreaming(operationLog, workspacePath, ['checkout', ref]);
        return result.success ? { success: true } : { success: false, error: result.error };
      });
    }
  );

  /**
   * Cherry-pick a commit onto the current branch
   */
  safeHandle(
    'git:cherry-pick',
    async (_event, workspacePath: string, hash: string):
      Promise<{ success: boolean; error?: string; conflicts?: string[] }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!hash) throw new Error('hash is required');
      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:cherry-pick', async () => {
        const result = await runGitCommandStreaming(operationLog, workspacePath, ['cherry-pick', hash]);
        if (result.success) return { success: true };
        const status = await simpleGit(gitRoot).status();
        return { success: false, error: result.error, conflicts: status.conflicted };
      });
    }
  );

  /**
   * Create a new branch starting from a given commit
   */
  safeHandle(
    'git:create-branch',
    async (_event, workspacePath: string, branchName: string, fromHash: string):
      Promise<{ success: boolean; error?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!branchName) throw new Error('branchName is required');
      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:create-branch', async () => {
        const result = await runGitCommandStreaming(
          operationLog,
          workspacePath,
          ['checkout', '-b', branchName, fromHash || 'HEAD'],
        );
        return result.success ? { success: true } : { success: false, error: result.error };
      });
    }
  );

  /**
   * Get detailed info for a single commit (full message, per-file stats)
   */
  safeHandle(
    'git:commit-detail',
    async (_event, workspacePath: string, hash: string): Promise<{
      body: string;
      files: Array<{ status: string; path: string; added: number; deleted: number }>;
      summary: { filesChanged: number; insertions: number; deletions: number };
    } | null> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!hash) throw new Error('hash is required');
      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) return null;

      try {
        const git: SimpleGit = simpleGit(gitRoot);

        const [bodyRaw, numstatRaw, nameStatusRaw] = await Promise.all([
          git.raw(['show', '-s', '--format=%B', hash]),
          git.raw(['diff-tree', '--no-commit-id', '-r', '--numstat', hash]),
          git.raw(['diff-tree', '--no-commit-id', '-r', '--name-status', hash]),
        ]);

        // Parse numstat: "<added>\t<deleted>\t<path>"
        const numstatMap = new Map<string, { added: number; deleted: number }>();
        for (const line of numstatRaw.trim().split('\n').filter(Boolean)) {
          const parts = line.split('\t');
          if (parts.length >= 3) {
            numstatMap.set(parts[2], {
              added: parseInt(parts[0], 10) || 0,
              deleted: parseInt(parts[1], 10) || 0,
            });
          }
        }

        // Parse name-status: "<STATUS>\t<path>" or "<STATUS>\t<old>\t<new>" for renames
        const files: Array<{ status: string; path: string; added: number; deleted: number }> = [];
        for (const line of nameStatusRaw.trim().split('\n').filter(Boolean)) {
          const parts = line.split('\t');
          if (parts.length >= 2) {
            const status = parts[0][0];
            const path = parts[parts.length - 1]; // new path for renames, only path otherwise
            const stats = numstatMap.get(path) ?? { added: 0, deleted: 0 };
            files.push({ status, path, ...stats });
          }
        }

        return {
          body: bodyRaw.trim(),
          files,
          summary: {
            filesChanged: files.length,
            insertions: files.reduce((s, f) => s + f.added, 0),
            deletions: files.reduce((s, f) => s + f.deleted, 0),
          },
        };
      } catch (error) {
        log.error('[git:commit-detail] Failed:', error);
        throw error;
      }
    }
  );

  /**
   * Get working tree changes (staged, unstaged, untracked files)
   */
  safeHandle(
    'git:working-changes',
    async (_event, workspacePath: string): Promise<{
      staged: Array<{ path: string; status: string }>;
      unstaged: Array<{ path: string; status: string }>;
      untracked: Array<{ path: string }>;
      conflicted: Array<{ path: string }>;
    }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) {
        return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      }

      // core.optionalLocks=false skips the index refresh that would create
      // .git/index.lock, allowing this read to run concurrently with writes
      // without queueing on gitOperationLock.
      try {
        const git: SimpleGit = simpleGit(gitRoot, { config: ['core.optionalLocks=false'] });
        const status = await git.status();

        // Build staged files list from the various status arrays.
        // status.staged = files with index changes (modified in index vs HEAD)
        // status.created = new files added to index (not in HEAD)
        const staged: Array<{ path: string; status: string }> = [];
        for (const f of status.staged) {
          const isDeleted = status.deleted.includes(f);
          staged.push({ path: f, status: isDeleted ? 'D' : 'M' });
        }
        for (const f of status.created) {
          staged.push({ path: f, status: 'A' });
        }

        // Build unstaged files list.
        // status.modified = files with working-tree changes (vs index).
        // A file CAN appear in both staged and modified -- this means it has
        // staged changes AND additional unstaged edits on top. We must show
        // it in both lists so the user sees the full picture.
        const unstaged: Array<{ path: string; status: string }> = [];
        for (const f of status.modified) {
          unstaged.push({ path: f, status: 'M' });
        }
        for (const f of status.deleted) {
          // Only add to unstaged if it's not already there from modified,
          // and it represents an unstaged deletion (not a staged one).
          // status.deleted can contain both staged and unstaged deletions.
          // If a file is in status.staged with 'D', that's a staged deletion.
          // If it's in status.deleted but NOT in status.staged, it's unstaged.
          if (!status.staged.includes(f)) {
            unstaged.push({ path: f, status: 'D' });
          }
        }

        // Untracked files
        const untracked = status.not_added.map(f => ({ path: f }));

        // Conflicted files
        const conflicted = status.conflicted.map(f => ({ path: f }));

        return { staged, unstaged, untracked, conflicted };
      } catch (error) {
        log.error('[git:working-changes] Failed:', error);
        throw error;
      }
    }
  );

  /**
   * Stage specific files
   */
  safeHandle(
    'git:stage',
    async (_event, workspacePath: string, files: string[]): Promise<{ success: boolean; error?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!files || files.length === 0) throw new Error('files are required');
      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:stage', async () => {
        const result = await runGitCommandStreaming(operationLog, workspacePath, ['add', '--', ...files]);
        return result.success ? { success: true } : { success: false, error: result.error };
      });
    }
  );

  /**
   * Unstage specific files (git reset HEAD <files>)
   */
  safeHandle(
    'git:unstage',
    async (_event, workspacePath: string, files: string[]): Promise<{ success: boolean; error?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!files || files.length === 0) throw new Error('files are required');
      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:unstage', async () => {
        const git: SimpleGit = simpleGit(gitRoot);
        const args = await hasCommits(git)
          ? ['reset', 'HEAD', '--', ...files]
          : ['rm', '--cached', '--', ...files];
        const result = await runGitCommandStreaming(operationLog, workspacePath, args);
        return result.success ? { success: true } : { success: false, error: result.error };
      });
    }
  );

  /**
   * Discard changes to specific files (git checkout -- <files>)
   */
  safeHandle(
    'git:discard-changes',
    async (_event, workspacePath: string, files: string[]): Promise<{ success: boolean; error?: string }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!files || files.length === 0) throw new Error('files are required');
      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:discard-changes', async () => {
        const result = await runGitCommandStreaming(operationLog, workspacePath, ['checkout', '--', ...files]);
        return result.success ? { success: true } : { success: false, error: result.error };
      });
    }
  );

  /**
   * Get file content at a specific commit
   */
  safeHandle(
    'git:show-file',
    async (_event, workspacePath: string, hash: string, filePath: string): Promise<string> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!hash) throw new Error('hash is required');
      if (!filePath) throw new Error('filePath is required');
      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) return '';

      try {
        const git: SimpleGit = simpleGit(gitRoot);
        const content = await git.show([`${hash}:${filePath}`]);
        return content;
      } catch (error) {
        log.error('[git:show-file] Failed:', error);
        // File may not exist at this commit - return empty
        return '';
      }
    }
  );

  /**
   * Get file diff
   */
  ipcMain.handle(
    'git:diff',
    async (_event, workspacePath: string, filePath: string): Promise<string> => {
      if (!workspacePath) {
        throw new Error('workspacePath is required');
      }
      if (!filePath) {
        throw new Error('filePath is required');
      }

      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) {
        return '';
      }

      try {
        const git: SimpleGit = simpleGit(gitRoot);

        // In a fresh repo with no commits, diff against an empty tree instead of HEAD
        if (!(await hasCommits(git))) {
          const diff = await git.diff(['--cached', '--', filePath]);
          return diff;
        }

        const diff = await git.diff(['HEAD', '--', filePath]);
        return diff;
      } catch (error) {
        log.error('Failed to get file diff:', error);
        throw error;
      }
    }
  );

  /**
   * Get a typed diff for a single file scoped to a working-tree group.
   * Cleanly separates staged vs unstaged vs untracked diffs (the legacy
   * `git:diff` channel mixes them by diffing HEAD against the working tree).
   *
   * The `working` group returns the combined HEAD-vs-working-tree diff for a file
   * regardless of staging state, falling back to a synthesized diff for untracked
   * files. This is what tools like the git commit proposal widget want when they
   * need to show "what's about to be committed" without knowing the file's group.
   */
  safeHandle(
    'git:file-diff',
    async (
      _event,
      workspacePath: string,
      args: { path: string; group: 'staged' | 'unstaged' | 'untracked' | 'conflicted' | 'working' }
    ): Promise<{
      unifiedDiff: string;
      isBinary: boolean;
      truncated?: boolean;
    }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!args?.path) throw new Error('path is required');
      if (!gitRootFor(workspacePath)) {
        return { unifiedDiff: '', isBinary: false };
      }

      const filePath = args.path;
      const group = args.group;
      const { gitWorkspacePath, gitFilePath } = resolveGitDiffTarget(workspacePath, filePath);
      const git: SimpleGit = simpleGit(gitWorkspacePath);
      const repoHasCommits = await hasCommits(git);

      try {
        if (group === 'staged') {
          const diff = repoHasCommits
            ? await git.diff(['--cached', '--', gitFilePath])
            : await git.diff(['--cached', '--', gitFilePath]);
          return { unifiedDiff: diff, isBinary: /\bBinary files\b/.test(diff) };
        }

        if (group === 'unstaged' || group === 'conflicted') {
          const diff = await git.diff(['--', gitFilePath]);
          return { unifiedDiff: diff, isBinary: /\bBinary files\b/.test(diff) };
        }

        if (group === 'working') {
          // Combined HEAD-vs-working-tree diff. For untracked files there's nothing in
          // HEAD, so synthesize against /dev/null. For deleted files HEAD has the
          // content and the working tree doesn't — `git diff HEAD` handles this.
          if (repoHasCommits) {
            const diff = await git.diff(['HEAD', '--', gitFilePath]);
            if (diff && diff.trim().length > 0) {
              return { unifiedDiff: diff, isBinary: /\bBinary files\b/.test(diff) };
            }
          }
          // Fall through to untracked-file synthesis if HEAD diff was empty
          // (e.g. file is brand-new and not staged).
          const absolute = isAbsolute(filePath) ? filePath : join(gitWorkspacePath, gitFilePath);
          if (!existsSync(absolute)) {
            return { unifiedDiff: '', isBinary: false };
          }
          try {
            const diff = await git.raw(['diff', '--no-index', '--', '/dev/null', gitFilePath]);
            return { unifiedDiff: diff, isBinary: /\bBinary files\b/.test(diff) };
          } catch (err) {
            const diff = (err as { stdout?: string })?.stdout ?? '';
            if (diff) {
              return { unifiedDiff: diff, isBinary: /\bBinary files\b/.test(diff) };
            }
            return { unifiedDiff: '', isBinary: false };
          }
        }

        if (group === 'untracked') {
          // Synthesize a unified diff from the working-tree file contents.
          const absolute = isAbsolute(filePath) ? filePath : join(gitWorkspacePath, gitFilePath);
          if (!existsSync(absolute)) {
            return { unifiedDiff: '', isBinary: false };
          }
          // Use git diff --no-index against /dev/null to produce a real unified diff
          // for an untracked file. This handles binary detection naturally and respects
          // the user's diff config (e.g. mnemonicPrefix).
          try {
            const diff = await git.raw(['diff', '--no-index', '--', '/dev/null', gitFilePath]);
            return { unifiedDiff: diff, isBinary: /\bBinary files\b/.test(diff) };
          } catch (err) {
            // git diff --no-index exits 1 when files differ; simple-git treats this as success
            // but in case it doesn't, fall through to read the file manually.
            const diff = (err as { stdout?: string })?.stdout ?? '';
            if (diff) {
              return { unifiedDiff: diff, isBinary: /\bBinary files\b/.test(diff) };
            }
            throw err;
          }
        }

        return { unifiedDiff: '', isBinary: false };
      } catch (error) {
        log.error(`[git:file-diff] Failed for ${group}/${filePath}:`, error);
        throw error;
      }
    }
  );

  /**
   * Get the unified diff for a single file in a specific commit.
   * Uses `git show --format=` so the output contains only the per-file diff
   * (no commit metadata header). Works for the initial commit too --
   * git show synthesizes a diff against /dev/null in that case.
   */
  safeHandle(
    'git:commit-file-diff',
    async (
      _event,
      workspacePath: string,
      hash: string,
      filePath: string
    ): Promise<{ unifiedDiff: string; isBinary: boolean }> => {
      if (!workspacePath) throw new Error('workspacePath is required');
      if (!hash) throw new Error('hash is required');
      if (!filePath) throw new Error('filePath is required');
      const gitRoot = gitRootFor(workspacePath);
      if (!gitRoot) {
        return { unifiedDiff: '', isBinary: false };
      }

      try {
        const git: SimpleGit = simpleGit(gitRoot);
        const diff = await git.raw(['show', '--no-color', '--format=', hash, '--', filePath]);
        return { unifiedDiff: diff, isBinary: /\bBinary files\b/.test(diff) };
      } catch (error) {
        log.error(`[git:commit-file-diff] Failed for ${hash}/${filePath}:`, error);
        throw error;
      }
    }
  );

  /**
   * Execute git commit
   */
  ipcMain.handle(
    'git:commit',
    async (
      _event,
      workspacePath: string,
      message: string,
      filesToStage: string[]
    ): Promise<{ success: boolean; commitHash?: string; commitDate?: string; error?: string }> => {
      return withGitOperationLog(
        operationLog,
        workspacePath,
        ['commit', '-m', message],
        entry => executeGitCommit(workspacePath, message, filesToStage, {
          logContext: '[git:commit]',
          env: getGitSubprocessEnv(),
          onOutput: (stream, chunk) => operationLog.appendOutput(workspacePath, entry.id, stream, chunk),
        }),
        result => result.commitHash ? `[${result.commitHash}] commit created` : undefined,
      );
    }
  );

  log.info('Git IPC handlers registered');
}
