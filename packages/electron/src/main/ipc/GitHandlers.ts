/**
 * Git IPC Handlers
 *
 * Handles git operations from the renderer process.
 *
 * **The first argument of these channels is a REPOSITORY path, not a workspace
 * path.** A workspace can span several roots, and a root can be its own repo,
 * no repo at all, or a folder containing repos -- so the caller resolves which
 * repository it means (`git:list-workspace-repos`, `git:resolve-repo-for-file`,
 * or `services/workspaceRepos.ts` in main) and passes that.
 *
 * The workspace root remains a valid value and is accepted as an alias for one
 * release, because that is what installed extensions built before multi-root
 * pass. In a single-folder project the two are the same path, so those
 * extensions keep working unchanged.
 *
 * Two channels are deliberately workspace-scoped and named accordingly:
 * `git:commit` (groups the file list by owning repo and splits across repos)
 * and `git:file-diff` (resolves the owning repo of the file it is given).
 */

import { runCommitProposalOnce, commitProposalIdentity } from '../services/ai/CommitProposalExecution';
import { resolveGitCommitProposalPromptId } from '../services/ai/gitCommitProposalPromptUtils';
import { ipcMain } from 'electron';
import simpleGit, { SimpleGit } from 'simple-git';
import log from 'electron-log/main';
import { existsSync } from 'fs';
import { dirname, join, relative, isAbsolute, resolve } from 'path';
import { gitOperationLock } from '../services/GitOperationLock';
import { executeGitCommitAcrossRepos, toRepositoryRelativePath, type HunkSelection } from '../services/GitCommitService';
import { getGitSubprocessEnv, simpleGitWithHookEnv } from '../services/gitEnv';
import { SessionCommitService } from '../services/SessionCommitService';
import { safeHandle } from '../utils/ipcRegistry';
import { findGitRootForFile } from '../services/GitStatusService';
import { resolveExtraCommitRoots, resolveRepoForFile } from '../services/workspaceRepos';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { isFileInWorkspaceOrWorktree } from '../utils/workspaceDetection';
import {
  getGitOperationLogService,
  runGitCommandStreaming,
  withGitOperationLog,
} from '../services/GitOperationLogService';
import type { GitOperationLogService } from '../services/GitOperationLogService';
import {
  GitStatusRefreshCoordinator,
  setGitStatusRefreshCoordinator,
} from '../services/GitStatusRefreshCoordinator';
import { isReadOnlyGitCommandLine } from '../services/gitCommandClassifier';

function isGitRepository(repoPath: string): boolean {
  try {
    return existsSync(join(repoPath, '.git'));
  } catch {
    return false;
  }
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

function findNearestGitRoot(filePath: string): string | null {
  let dir = dirname(resolve(filePath));

  while (true) {
    try {
      if (existsSync(join(dir, '.git'))) {
        return dir;
      }
    } catch {
      // Ignore filesystem errors and continue walking up.
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Turn a rejected push into a sentence the user can act on.
 *
 * `git push` buries the one fact that matters under a `To <url>` line and five
 * wrapped `hint:` lines, and its final line -- `error: failed to push some refs`
 * -- is IDENTICAL to the one a failing pre-push hook prints. That collision is
 * what makes "the remote moved, pull first" read as "the pre-push gate broke".
 * Key off the `! [rejected] ... (<reason>)` line instead, which only a real
 * rejection emits, and leave hook failures alone.
 *
 * The raw output is kept underneath so the menu tooltip still shows everything.
 */
export function explainGitPushFailure(
  rawError: string | undefined,
  context: { remote: string; branch: string },
): string | undefined {
  if (!rawError) return rawError;

  const lower = rawError.toLowerCase();
  if (!lower.includes('[rejected]')) return rawError;

  const target = `${context.remote}/${context.branch}`;
  let summary: string | undefined;
  if (lower.includes('(stale info)')) {
    // --force-with-lease refusing because the remote advanced since our fetch.
    summary = `Push rejected: ${target} moved since your last fetch. Pull first, then push again.`;
  } else if (lower.includes('(fetch first)') || lower.includes('(non-fast-forward)')) {
    summary = `Push rejected: ${target} has commits you don't have locally. Pull first, then push again.`;
  }

  return summary ? `${summary}\n\n${rawError}` : rawError;
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
  repoPath: string,
  filePath: string
): { gitWorkspacePath: string; gitFilePath: string } {
  const resolvedWorkspacePath = resolve(repoPath);
  const absoluteFilePath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(resolvedWorkspacePath, filePath);

  const relatedAbsolutePath = isAbsolute(filePath) && isFileInWorkspaceOrWorktree(absoluteFilePath, resolvedWorkspacePath)
    ? absoluteFilePath
    : null;
  const gitWorkspacePath = relatedAbsolutePath
    ? findNearestGitRoot(relatedAbsolutePath) ?? resolvedWorkspacePath
    : findGitRootForFile(filePath, resolvedWorkspacePath) ?? resolvedWorkspacePath;

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

export interface GitWorkingChanges {
  staged: Array<{ path: string; status: string }>;
  unstaged: Array<{ path: string; status: string }>;
  untracked: Array<{ path: string }>;
  conflicted: Array<{ path: string }>;
}

const UNMERGED_STATUS_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function appendWorkingChange(
  changes: Array<{ path: string; status: string }>,
  code: string,
  path: string,
  sourcePath: string | undefined,
): void {
  switch (code) {
    case 'M':
    case 'T':
      changes.push({ path, status: 'M' });
      return;
    case 'A':
      changes.push({ path, status: 'A' });
      return;
    case 'D':
      changes.push({ path, status: 'D' });
      return;
    case 'R':
      // A rename is two ordinary rows so the temp-index commit reproduces it:
      // selecting both stages the deletion of the old path and the new file.
      if (!sourcePath) throw new Error('Git status rename is missing its source path');
      changes.push({ path: sourcePath, status: 'D' }, { path, status: 'A' });
      return;
    case 'C':
      // A copy leaves the source in place, so only the new path is a change.
      // (Git only reports 'C' when copy detection is explicitly enabled.)
      if (!sourcePath) throw new Error('Git status copy is missing its source path');
      changes.push({ path, status: 'A' });
      return;
    case ' ':
      return;
    default:
      throw new Error(`Unsupported Git status code: ${code}`);
  }
}

/** Parse raw status without losing either path of a rename or configured copy. */
function parseGitStatusPorcelainV1Z(rawStatus: string): GitWorkingChanges {
  const changes: GitWorkingChanges = {
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
  const records = rawStatus.split('\0');

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error('Git returned an invalid porcelain status record');
    }

    const statusCode = record.slice(0, 2);
    const indexCode = statusCode[0];
    const worktreeCode = statusCode[1];
    const path = record.slice(3);
    const hasSourcePath = indexCode === 'R'
      || indexCode === 'C'
      || worktreeCode === 'R'
      || worktreeCode === 'C';
    const sourcePath = hasSourcePath ? records[++index] : undefined;

    if (hasSourcePath && !sourcePath) {
      throw new Error('Git status rename or copy is missing its source path');
    }
    if (UNMERGED_STATUS_CODES.has(statusCode)) {
      changes.conflicted.push({ path });
      continue;
    }
    if (statusCode === '??') {
      changes.untracked.push({ path });
      continue;
    }
    if (statusCode === '!!') continue;

    appendWorkingChange(changes.staged, indexCode, path, sourcePath);
    appendWorkingChange(changes.unstaged, worktreeCode, path, sourcePath);
  }

  return changes;
}

/**
 * Return working changes in the renderer's ordinary M/A/D vocabulary.
 * Renames and configured copies become a deleted source plus added destination
 * so the two concrete paths are staged together without widening the status
 * vocabulary used by consumers.
 */
export async function getWorkingChanges(repoPath: string): Promise<GitWorkingChanges> {
  const git: SimpleGit = simpleGit(repoPath, { config: ['core.optionalLocks=false'] });
  const rawStatus = await git.raw(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  return parseGitStatusPorcelainV1Z(rawStatus);
}

/** Restore the selected tracked paths in both HEAD-backed index and worktree. */
export async function discardGitChanges(
  repoPath: string,
  files: string[],
  operationLog: GitOperationLogService = getGitOperationLogService(),
): Promise<{ success: boolean; error?: string }> {
  let relativeFiles: string[];
  try {
    relativeFiles = files.map((file) => toRepositoryRelativePath(repoPath, file));
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }

  // Restore both the real index and worktree to HEAD for the selected paths.
  const result = await runGitCommandStreaming(operationLog, repoPath, [
    '--literal-pathspecs',
    'restore',
    '--source=HEAD',
    '--staged',
    '--worktree',
    '--',
    ...relativeFiles,
  ]);
  if (result.success) return { success: true };

  if (/['"]?restore['"]? is not a git command/i.test(result.error ?? '')) {
    // `checkout HEAD --` is the pre-2.23 single-command equivalent: it also
    // restores both the index and worktree for these literal tracked paths.
    const fallback = await runGitCommandStreaming(operationLog, repoPath, [
      '--literal-pathspecs',
      'checkout',
      'HEAD',
      '--',
      ...relativeFiles,
    ]);
    return fallback.success ? { success: true } : { success: false, error: fallback.error };
  }

  return { success: false, error: result.error };
}

/**
 * Read the branch/ahead-behind snapshot the title bar and Git panel both render.
 *
 * `core.optionalLocks=false` tells git to skip the index refresh that would
 * create `.git/index.lock`, so this read can run concurrently with writes
 * (commit/rebase/etc.) without queueing behind them on `gitOperationLock`.
 */
export async function readBranchStatus(repoPath: string): Promise<GitStatusResult> {
  const git: SimpleGit = simpleGit(repoPath, { config: ['core.optionalLocks=false'] });
  const status = await git.status();
  return {
    branch: normalizeCurrentBranch(status.current) || 'HEAD',
    ahead: status.ahead || 0,
    behind: status.behind || 0,
    hasUncommitted: !status.isClean(),
  };
}

/**
 * Register all git-related IPC handlers
 */
export function registerGitHandlers(): void {
  const operationLog = getGitOperationLogService();

  // Every foreground Git operation converges on the journal, so its terminal
  // event is the one signal that covers app-owned and agent-observed commands
  // alike -- including a fetch, which moves `refs/remotes/*` and so never
  // reaches the branch-ref or index watchers.
  const statusRefresh = new GitStatusRefreshCoordinator({
    readStatus: async (repoPath) =>
      isGitRepository(repoPath) ? readBranchStatus(repoPath) : null,
  });
  setGitStatusRefreshCoordinator(statusRefresh);
  operationLog.onOperationTerminal((repoPath, entry) => {
    // An observed read-only command (an agent's `git status`, `git log`) cannot
    // have moved refs, the index, or the worktree. Refreshing after each one
    // would re-read status and reload the Git panel for nothing, and agents run
    // these constantly. App-owned operations always refresh.
    if (entry.executor === 'shell' && isReadOnlyGitCommandLine(entry.command)) return;
    void statusRefresh.request(repoPath);
  });

  safeHandle('git:operation-log:get', async (_event, repoPath: string) => {
    if (!repoPath) throw new Error('repoPath is required');
    return operationLog.list(repoPath);
  });

  safeHandle('git:operation-log:clear', async (_event, repoPath: string) => {
    if (!repoPath) throw new Error('repoPath is required');
    await operationLog.clear(repoPath);
    return { success: true };
  });

  /**
   * Get git status for a workspace or worktree
   */
  ipcMain.handle('git:status', async (_event, repoPath: string): Promise<GitStatusResult> => {
    if (!repoPath) {
      throw new Error('repoPath is required');
    }

    if (!isGitRepository(repoPath)) {
      return { branch: '', ahead: 0, behind: 0, hasUncommitted: false };
    }

    try {
      return await readBranchStatus(repoPath);
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
      repoPath: string,
      limit: number = 10,
      options?: {
        branch?: string;
        author?: string;
        since?: string;
        until?: string;
        aheadBehind?: boolean;
      }
    ): Promise<GitCommit[]> => {
      if (!repoPath) {
        throw new Error('repoPath is required');
      }

      if (!isGitRepository(repoPath)) {
        return [];
      }

      try {
        const git: SimpleGit = simpleGit(repoPath);

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
  safeHandle('git:branches', async (_event, repoPath: string): Promise<{ branches: string[]; current: string }> => {
    if (!repoPath) throw new Error('repoPath is required');
    if (!isGitRepository(repoPath)) return { branches: [], current: '' };

    try {
      const git: SimpleGit = simpleGit(repoPath);
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
    async (_event, repoPath: string, options?: { force?: boolean; setUpstream?: boolean; remote?: string; branch?: string }):
      Promise<{ success: boolean; error?: string }> => {
      if (!repoPath) throw new Error('repoPath is required');
      if (!isGitRepository(repoPath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(repoPath, 'git:push', async () => {
        try {
          const git: SimpleGit = simpleGitWithHookEnv(repoPath);
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
          const result = await runGitCommandStreaming(operationLog, repoPath, pushArgs);
          return result.success
            ? { success: true }
            : { success: false, error: explainGitPushFailure(result.error, { remote, branch }) };
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
    async (_event, repoPath: string, options?: { rebase?: boolean; ffOnly?: boolean }):
      Promise<{ success: boolean; error?: string; conflicts?: string[] }> => {
      if (!repoPath) throw new Error('repoPath is required');
      if (!isGitRepository(repoPath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(repoPath, 'git:pull', async () => {
        try {
          const git: SimpleGit = simpleGitWithHookEnv(repoPath);
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
          const result = await runGitCommandStreaming(operationLog, repoPath, pullArgs);
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
            const git: SimpleGit = simpleGit(repoPath);
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
    async (_event, repoPath: string, options?: { remote?: string }):
      Promise<{ success: boolean; error?: string }> => {
      if (!repoPath) throw new Error('repoPath is required');
      if (!isGitRepository(repoPath)) return { success: false, error: 'Not a git repository' };

      try {
        const result = await runGitCommandStreaming(
          operationLog,
          repoPath,
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
    async (_event, repoPath: string, options: { target?: string; action?: 'continue' | 'abort' | 'skip' }):
      Promise<{ success: boolean; error?: string; conflicts?: string[] }> => {
      if (!repoPath) throw new Error('repoPath is required');
      if (!isGitRepository(repoPath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(repoPath, 'git:rebase', async () => {
        const args = options.action
          ? ['rebase', `--${options.action}`]
          : options.target
            ? ['rebase', options.target]
            : null;
        if (!args) {
          throw new Error('rebase requires either a target branch or an action (continue/abort/skip)');
        }
        const result = await runGitCommandStreaming(operationLog, repoPath, args);
        if (result.success) return { success: true };
        const status = await simpleGit(repoPath).status();
        return { success: false, error: result.error, conflicts: status.conflicted };
      });
    }
  );

  /**
   * Get current rebase status and any conflict files
   */
  safeHandle(
    'git:rebase-status',
    async (_event, repoPath: string):
      Promise<{ isRebasing: boolean; conflicts: string[]; currentCommit?: string }> => {
      if (!repoPath) throw new Error('repoPath is required');
      if (!isGitRepository(repoPath)) return { isRebasing: false, conflicts: [] };

      try {
        const git: SimpleGit = simpleGit(repoPath);

        // Check for REBASE_HEAD file as indicator of active rebase
        const rebaseHeadPath = join(repoPath, '.git', 'REBASE_HEAD');
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
    async (_event, repoPath: string, remote: string, branch?: string):
      Promise<{ success: boolean; error?: string }> => {
      if (!repoPath) throw new Error('repoPath is required');
      if (!remote) throw new Error('remote is required');
      if (!isGitRepository(repoPath)) return { success: false, error: 'Not a git repository' };

      try {
        const git: SimpleGit = simpleGitWithHookEnv(repoPath);
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
          repoPath,
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
    async (_event, repoPath: string, ref: string):
      Promise<{ success: boolean; error?: string }> => {
      if (!repoPath) throw new Error('repoPath is required');
      if (!ref) throw new Error('ref is required');
      if (!isGitRepository(repoPath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(repoPath, 'git:checkout', async () => {
        const result = await runGitCommandStreaming(operationLog, repoPath, ['checkout', ref]);
        return result.success ? { success: true } : { success: false, error: result.error };
      });
    }
  );

  /**
   * Cherry-pick a commit onto the current branch
   */
  safeHandle(
    'git:cherry-pick',
    async (_event, repoPath: string, hash: string):
      Promise<{ success: boolean; error?: string; conflicts?: string[] }> => {
      if (!repoPath) throw new Error('repoPath is required');
      if (!hash) throw new Error('hash is required');
      if (!isGitRepository(repoPath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(repoPath, 'git:cherry-pick', async () => {
        const result = await runGitCommandStreaming(operationLog, repoPath, ['cherry-pick', hash]);
        if (result.success) return { success: true };
        const status = await simpleGit(repoPath).status();
        return { success: false, error: result.error, conflicts: status.conflicted };
      });
    }
  );

  /**
   * Create a new branch starting from a given commit
   */
  safeHandle(
    'git:create-branch',
    async (_event, repoPath: string, branchName: string, fromHash: string):
      Promise<{ success: boolean; error?: string }> => {
      if (!repoPath) throw new Error('repoPath is required');
      if (!branchName) throw new Error('branchName is required');
      if (!isGitRepository(repoPath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(repoPath, 'git:create-branch', async () => {
        const result = await runGitCommandStreaming(
          operationLog,
          repoPath,
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
    async (_event, repoPath: string, hash: string): Promise<{
      body: string;
      files: Array<{ status: string; path: string; added: number; deleted: number }>;
      summary: { filesChanged: number; insertions: number; deletions: number };
    } | null> => {
      if (!repoPath) throw new Error('repoPath is required');
      if (!hash) throw new Error('hash is required');
      if (!isGitRepository(repoPath)) return null;

      try {
        const git: SimpleGit = simpleGit(repoPath);

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
    async (_event, repoPath: string): Promise<{
      staged: Array<{ path: string; status: string }>;
      unstaged: Array<{ path: string; status: string }>;
      untracked: Array<{ path: string }>;
      conflicted: Array<{ path: string }>;
    }> => {
      if (!repoPath) throw new Error('repoPath is required');
      if (!isGitRepository(repoPath)) {
        return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      }

      // core.optionalLocks=false skips the index refresh that would create
      // .git/index.lock, allowing this read to run concurrently with writes
      // without queueing on gitOperationLock.
      try {
        return await getWorkingChanges(repoPath);
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
    async (_event, repoPath: string, files: string[]): Promise<{ success: boolean; error?: string }> => {
      if (!repoPath) throw new Error('repoPath is required');
      if (!files || files.length === 0) throw new Error('files are required');
      if (!isGitRepository(repoPath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(repoPath, 'git:stage', async () => {
        const result = await runGitCommandStreaming(operationLog, repoPath, ['add', '--', ...files]);
        return result.success ? { success: true } : { success: false, error: result.error };
      });
    }
  );

  /**
   * Unstage specific files (git reset HEAD <files>)
   */
  safeHandle(
    'git:unstage',
    async (_event, repoPath: string, files: string[]): Promise<{ success: boolean; error?: string }> => {
      if (!repoPath) throw new Error('repoPath is required');
      if (!files || files.length === 0) throw new Error('files are required');
      if (!isGitRepository(repoPath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(repoPath, 'git:unstage', async () => {
        const git: SimpleGit = simpleGit(repoPath);
        const args = await hasCommits(git)
          ? ['reset', 'HEAD', '--', ...files]
          : ['rm', '--cached', '--', ...files];
        const result = await runGitCommandStreaming(operationLog, repoPath, args);
        return result.success ? { success: true } : { success: false, error: result.error };
      });
    }
  );

  /**
   * Discard all changes to specific tracked files (index and worktree)
   */
  safeHandle(
    'git:discard-changes',
    async (_event, repoPath: string, files: string[]): Promise<{ success: boolean; error?: string }> => {
      if (!repoPath) throw new Error('repoPath is required');
      if (!files || files.length === 0) throw new Error('files are required');
      if (!isGitRepository(repoPath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(repoPath, 'git:discard-changes', async () => {
        return discardGitChanges(repoPath, files, operationLog);
      });
    }
  );

  /**
   * Get file content at a specific commit
   */
  safeHandle(
    'git:show-file',
    async (_event, repoPath: string, hash: string, filePath: string): Promise<string> => {
      if (!repoPath) throw new Error('repoPath is required');
      if (!hash) throw new Error('hash is required');
      if (!filePath) throw new Error('filePath is required');
      if (!isGitRepository(repoPath)) return '';

      try {
        const git: SimpleGit = simpleGit(repoPath);
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
    async (_event, repoPath: string, filePath: string): Promise<string> => {
      if (!repoPath) {
        throw new Error('repoPath is required');
      }
      if (!filePath) {
        throw new Error('filePath is required');
      }

      if (!isGitRepository(repoPath)) {
        return '';
      }

      try {
        const git: SimpleGit = simpleGit(repoPath);

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

      const filePath = args.path;
      const group = args.group;
      // The caller only knows the workspace's primary root. An absolute path in
      // an attached folder belongs to a different repo entirely, and resolving
      // it against the primary root yields a `../..` pathspec that diffs
      // nothing. Relative paths keep resolving against the primary root, which
      // is where they have always been interpreted.
      const ownerRepo = isAbsolute(filePath) ? resolveRepoForFile(workspacePath, filePath) : null;
      const { gitWorkspacePath, gitFilePath } = resolveGitDiffTarget(ownerRepo ?? workspacePath, filePath);
      if (!isGitRepository(gitWorkspacePath)) {
        return { unifiedDiff: '', isBinary: false };
      }
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
      repoPath: string,
      hash: string,
      filePath: string
    ): Promise<{ unifiedDiff: string; isBinary: boolean }> => {
      if (!repoPath) throw new Error('repoPath is required');
      if (!hash) throw new Error('hash is required');
      if (!filePath) throw new Error('filePath is required');
      if (!isGitRepository(repoPath)) {
        return { unifiedDiff: '', isBinary: false };
      }

      try {
        const git: SimpleGit = simpleGit(repoPath);
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
  /**
   * Attached folders that apply to a commit made by `sessionId`.
   *
   * Only a worktree session needs these -- it commits against the worktree,
   * while its attached folders live under the parent workspace's key. Any
   * lookup failure yields no extra roots, which is exactly today's behaviour.
   */
  async function resolveSessionExtraCommitRoots(
    sessionId: string,
    commitPath: string,
  ): Promise<string[]> {
    try {
      const session = await AISessionsRepository.get(sessionId);
      return resolveExtraCommitRoots(commitPath, session?.workspacePath);
    } catch (error) {
      log.warn('[git:commit] Could not resolve session roots:', error);
      return [];
    }
  }

  ipcMain.handle(
    'git:commit',
    async (
      _event,
      workspacePath: string,
      message: string,
      filesToStage: string[],
      // Optional: when the commit originates from an AI session, recording the
      // link here means the Git Log panel can attribute it even if the widget
      // response round-trip never lands.
      sessionId?: string,
      // Optional: files to stage down to individual hunks rather than whole.
      // Absent means every file in `filesToStage` goes in whole, unchanged.
      hunkSelections?: HunkSelection[],
      // Optional: commit into this repository instead of resolving one per
      // file. Set when the caller already knows the repo (the widget's repo
      // header, an extension passing an explicit target).
      repoPath?: string,
      proposalId?: string
    ): Promise<{
      success: boolean;
      commitHash?: string;
      commitDate?: string;
      error?: string;
      /** Per-repo outcome when the selection spanned more than one repository. */
      repoResults?: Array<{ repoPath: string; success: boolean; commitHash?: string; error?: string }>;
      /** Selected files that belong to no repository and were not committed. */
      uncommittableFiles?: string[];
    }> => {
      // A worktree session commits against the worktree path, which owns no
      // attached folders -- they are keyed by the parent workspace. Without
      // this every attached-folder file resolves to no repo and is dropped.
      const extraRoots = sessionId
        ? await resolveSessionExtraCommitRoots(sessionId, workspacePath)
        : [];

      const execute = () => withGitOperationLog(
        operationLog,
        workspacePath,
        ['commit', '-m', message],
        // Resolves the owning repo per file and splits across repos when the
        // selection spans more than one. A single-repo selection -- every
        // ordinary commit -- behaves exactly as before.
        entry => executeGitCommitAcrossRepos(workspacePath, message, filesToStage, {
          logContext: '[git:commit]',
          env: getGitSubprocessEnv(),
          onOutput: (stream, chunk) => operationLog.appendOutput(workspacePath, entry.id, stream, chunk),
          hunkSelections,
          repoPath,
          extraRoots,
        }),
        result => result.commitHash ? `[${result.commitHash}] commit created` : undefined,
      );

      const result = sessionId && proposalId
        ? await runCommitProposalOnce(sessionId, await resolveGitCommitProposalPromptId(sessionId, proposalId, false), commitProposalIdentity(workspacePath, message, filesToStage, hunkSelections, repoPath), execute)
        : await execute();

      if (sessionId) {
        // Record every commit the operation produced. A selection spanning two
        // repos makes two commits, and recording only `result.commitHash` --
        // the first repo's -- leaves the second unattributed in the Git Log
        // panel. Per-repo results also carry the successful ones on a partial
        // failure, which is exactly when attribution matters most.
        const commitHashes = result.repoResults
          ? result.repoResults.filter((r) => r.success && r.commitHash).map((r) => r.commitHash!)
          : result.success && result.commitHash ? [result.commitHash] : [];
        for (const commitSha of commitHashes) {
          void SessionCommitService.getInstance().recordCommit({
            commitSha,
            sessionId,
            workspaceId: workspacePath,
          });
        }
      }

      return result;
    }
  );

  log.info('Git IPC handlers registered');
}
