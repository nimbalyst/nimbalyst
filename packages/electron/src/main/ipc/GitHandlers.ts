/**
 * Git IPC Handlers
 *
 * Handles git operations from the renderer process.
 */

import { ipcMain } from 'electron';
import simpleGit, { SimpleGit } from 'simple-git';
import log from 'electron-log/main';
import { existsSync } from 'fs';
import { join, relative, isAbsolute } from 'path';
import { gitOperationLock } from '../services/GitOperationLock';
import { safeHandle } from '../utils/ipcRegistry';

function isGitRepository(workspacePath: string): boolean {
  try {
    return existsSync(join(workspacePath, '.git'));
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
  /**
   * Get git status for a workspace or worktree
   */
  ipcMain.handle('git:status', async (_event, workspacePath: string): Promise<GitStatusResult> => {
    if (!workspacePath) {
      throw new Error('workspacePath is required');
    }

    if (!isGitRepository(workspacePath)) {
      return { branch: '', ahead: 0, behind: 0, hasUncommitted: false };
    }

    // core.optionalLocks=false tells git to skip the index refresh that would
    // create .git/index.lock, so this read can run concurrently with writes
    // (commit/rebase/etc.) without queueing behind them on gitOperationLock.
    try {
      const git: SimpleGit = simpleGit(workspacePath, { config: ['core.optionalLocks=false'] });
      const status = await git.status();
      const branch = status.current || 'HEAD';

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

      if (!isGitRepository(workspacePath)) {
        return [];
      }

      try {
        const git: SimpleGit = simpleGit(workspacePath);

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
        if (options?.branch) {
          rawArgs.push(options.branch);
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
    if (!isGitRepository(workspacePath)) return { branches: [], current: '' };

    try {
      const git: SimpleGit = simpleGit(workspacePath);
      const summary = await git.branch();
      let current = summary.current;
      let branches = summary.all;

      // In a freshly initialized repo with no commits, `git branch` reports no
      // branches even though `git status` knows the unborn branch name.
      if (!current) {
        const status = await git.status();
        current = status.current || '';
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
      if (!isGitRepository(workspacePath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:push', async () => {
        try {
          const git: SimpleGit = simpleGit(workspacePath);
          const status = await git.status();
          const branch = status.current || '';

          const pushArgs: string[] = [];
          const remote = options?.remote || 'origin';

          if (options?.setUpstream) {
            pushArgs.push('--set-upstream', remote, branch);
          } else if (options?.force) {
            pushArgs.push('--force-with-lease');
          }

          await git.push(remote, branch, pushArgs);
          return { success: true };
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
      if (!isGitRepository(workspacePath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:pull', async () => {
        try {
          const git: SimpleGit = simpleGit(workspacePath);
          const pullArgs: string[] = [];
          if (options?.rebase) {
            pullArgs.push('--rebase');
          } else if (options?.ffOnly) {
            pullArgs.push('--ff-only');
          }
          await git.pull(undefined, undefined, pullArgs);
          return { success: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.error('[git:pull] Failed:', error);

          // Check for conflict markers in error message
          if (message.includes('CONFLICT') || message.includes('conflict')) {
            const git: SimpleGit = simpleGit(workspacePath);
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
      if (!isGitRepository(workspacePath)) return { success: false, error: 'Not a git repository' };

      try {
        const git: SimpleGit = simpleGit(workspacePath);
        await git.fetch(options?.remote || 'origin');
        return { success: true };
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
      if (!isGitRepository(workspacePath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:rebase', async () => {
        try {
          const git: SimpleGit = simpleGit(workspacePath);

          if (options.action === 'continue') {
            await git.rebase(['--continue']);
          } else if (options.action === 'abort') {
            await git.rebase(['--abort']);
          } else if (options.action === 'skip') {
            await git.rebase(['--skip']);
          } else if (options.target) {
            await git.rebase([options.target]);
          } else {
            throw new Error('rebase requires either a target branch or an action (continue/abort/skip)');
          }

          return { success: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.error('[git:rebase] Failed:', error);

          if (message.includes('CONFLICT') || message.includes('conflict')) {
            const git: SimpleGit = simpleGit(workspacePath);
            const status = await git.status();
            return { success: false, error: message, conflicts: status.conflicted };
          }

          return { success: false, error: message };
        }
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
      if (!isGitRepository(workspacePath)) return { isRebasing: false, conflicts: [] };

      try {
        const git: SimpleGit = simpleGit(workspacePath);

        // Check for REBASE_HEAD file as indicator of active rebase
        const rebaseHeadPath = join(workspacePath, '.git', 'REBASE_HEAD');
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
      if (!isGitRepository(workspacePath)) return { success: false, error: 'Not a git repository' };

      try {
        const git: SimpleGit = simpleGit(workspacePath);
        const status = await git.status();
        const targetBranch = branch || status.current || '';
        await git.push(['--set-upstream', remote, targetBranch]);
        return { success: true };
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
      if (!isGitRepository(workspacePath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:checkout', async () => {
        try {
          const git: SimpleGit = simpleGit(workspacePath);
          await git.checkout(ref);
          return { success: true };
        } catch (error) {
          log.error('[git:checkout] Failed:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
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
      if (!isGitRepository(workspacePath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:cherry-pick', async () => {
        try {
          const git: SimpleGit = simpleGit(workspacePath);
          await git.raw(['cherry-pick', hash]);
          return { success: true };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.error('[git:cherry-pick] Failed:', error);
          if (message.includes('CONFLICT') || message.includes('conflict')) {
            const git2: SimpleGit = simpleGit(workspacePath);
            const status = await git2.status();
            return { success: false, error: message, conflicts: status.conflicted };
          }
          return { success: false, error: message };
        }
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
      if (!isGitRepository(workspacePath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:create-branch', async () => {
        try {
          const git: SimpleGit = simpleGit(workspacePath);
          await git.checkoutBranch(branchName, fromHash || 'HEAD');
          return { success: true };
        } catch (error) {
          log.error('[git:create-branch] Failed:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
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
      if (!isGitRepository(workspacePath)) return null;

      try {
        const git: SimpleGit = simpleGit(workspacePath);

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
      if (!isGitRepository(workspacePath)) {
        return { staged: [], unstaged: [], untracked: [], conflicted: [] };
      }

      // core.optionalLocks=false skips the index refresh that would create
      // .git/index.lock, allowing this read to run concurrently with writes
      // without queueing on gitOperationLock.
      try {
        const git: SimpleGit = simpleGit(workspacePath, { config: ['core.optionalLocks=false'] });
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
      if (!isGitRepository(workspacePath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:stage', async () => {
        try {
          const git: SimpleGit = simpleGit(workspacePath);
          await git.add(files);
          return { success: true };
        } catch (error) {
          log.error('[git:stage] Failed:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
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
      if (!isGitRepository(workspacePath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:unstage', async () => {
        try {
          const git: SimpleGit = simpleGit(workspacePath);
          const repoHasCommits = await hasCommits(git);
          if (repoHasCommits) {
            await git.reset(['HEAD', '--', ...files]);
          } else {
            // Fresh repo: use git rm --cached
            await git.raw(['rm', '--cached', ...files]);
          }
          return { success: true };
        } catch (error) {
          log.error('[git:unstage] Failed:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
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
      if (!isGitRepository(workspacePath)) return { success: false, error: 'Not a git repository' };

      return gitOperationLock.withLock(workspacePath, 'git:discard-changes', async () => {
        try {
          const git: SimpleGit = simpleGit(workspacePath);
          await git.checkout(['--', ...files]);
          return { success: true };
        } catch (error) {
          log.error('[git:discard-changes] Failed:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
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
      if (!isGitRepository(workspacePath)) return '';

      try {
        const git: SimpleGit = simpleGit(workspacePath);
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

      if (!isGitRepository(workspacePath)) {
        return '';
      }

      try {
        const git: SimpleGit = simpleGit(workspacePath);

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
      if (!isGitRepository(workspacePath)) {
        return { unifiedDiff: '', isBinary: false };
      }

      const git: SimpleGit = simpleGit(workspacePath);
      const filePath = args.path;
      const group = args.group;
      const repoHasCommits = await hasCommits(git);

      try {
        if (group === 'staged') {
          const diff = repoHasCommits
            ? await git.diff(['--cached', '--', filePath])
            : await git.diff(['--cached', '--', filePath]);
          return { unifiedDiff: diff, isBinary: /\bBinary files\b/.test(diff) };
        }

        if (group === 'unstaged' || group === 'conflicted') {
          const diff = await git.diff(['--', filePath]);
          return { unifiedDiff: diff, isBinary: /\bBinary files\b/.test(diff) };
        }

        if (group === 'working') {
          // Combined HEAD-vs-working-tree diff. For untracked files there's nothing in
          // HEAD, so synthesize against /dev/null. For deleted files HEAD has the
          // content and the working tree doesn't — `git diff HEAD` handles this.
          if (repoHasCommits) {
            const diff = await git.diff(['HEAD', '--', filePath]);
            if (diff && diff.trim().length > 0) {
              return { unifiedDiff: diff, isBinary: /\bBinary files\b/.test(diff) };
            }
          }
          // Fall through to untracked-file synthesis if HEAD diff was empty
          // (e.g. file is brand-new and not staged).
          const absolute = isAbsolute(filePath) ? filePath : join(workspacePath, filePath);
          if (!existsSync(absolute)) {
            return { unifiedDiff: '', isBinary: false };
          }
          try {
            const diff = await git.raw(['diff', '--no-index', '--', '/dev/null', filePath]);
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
          const absolute = isAbsolute(filePath) ? filePath : join(workspacePath, filePath);
          if (!existsSync(absolute)) {
            return { unifiedDiff: '', isBinary: false };
          }
          // Use git diff --no-index against /dev/null to produce a real unified diff
          // for an untracked file. This handles binary detection naturally and respects
          // the user's diff config (e.g. mnemonicPrefix).
          try {
            const diff = await git.raw(['diff', '--no-index', '--', '/dev/null', filePath]);
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
      if (!isGitRepository(workspacePath)) {
        return { unifiedDiff: '', isBinary: false };
      }

      try {
        const git: SimpleGit = simpleGit(workspacePath);
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
      if (!workspacePath) {
        throw new Error('workspacePath is required');
      }
      if (!message) {
        throw new Error('message is required');
      }

      if (!isGitRepository(workspacePath)) {
        return { success: false, error: 'Not a git repository' };
      }

      // Use centralized lock to prevent concurrent commit/staging operations
      return gitOperationLock.withLock(workspacePath, 'git:commit', async () => {
        try {
          const git: SimpleGit = simpleGit(workspacePath);
          const repoHasCommits = await hasCommits(git);
          log.info(`[git:commit] Starting commit in ${workspacePath} with ${filesToStage?.length || 0} files (hasCommits: ${repoHasCommits})`);

          // Convert a file path (possibly absolute) to a git-relative path with forward slashes.
          // git.status() returns relative paths with forward slashes, but filesToStage
          // may contain absolute paths (from renderer). On Windows, path.relative()
          // returns backslashes, so normalize to forward slashes.
          const toGitPath = (f: string) => {
            const rel = isAbsolute(f) ? relative(workspacePath, f) : f;
            return rel.replace(/\\/g, '/');
          };

          // When filesToStage is empty/null, commit whatever is already in the index.
          // This is the "index-as-is" path used by the ChangesTab where the user
          // has already staged files via git:stage. We do NOT touch the index.
          if (!filesToStage || filesToStage.length === 0) {
            const preStatus = await git.status();
            const stagedCount = preStatus.staged.length + preStatus.created.length;
            if (stagedCount === 0) {
              return {
                success: false,
                error: 'No files are staged for commit.',
              };
            }
            log.info(`[git:commit] Index-as-is mode: committing ${stagedCount} staged files`);

            const result = await git.commit(message);
            if (!result.commit) {
              return {
                success: false,
                error: 'No changes were committed.',
              };
            }

            log.info(`[git:commit] Successfully committed: ${result.commit}`);
            let commitDate: string | undefined;
            try {
              const showResult = await git.show([result.commit, '--no-patch', '--format=%aI']);
              commitDate = showResult.trim();
            } catch {
              // Non-critical
            }

            return { success: true, commitHash: result.commit, commitDate };
          }

          // Track originally staged files so we can restore them after commit
          const initialStatus = await git.status();
          const originallyStaged = new Set([...initialStatus.staged, ...initialStatus.created]);
          log.info(`[git:commit] Originally staged files: ${originallyStaged.size}`);

          // Stage-and-commit path: used by AgentMode/AI commit where we need to
          // atomically select which files to include.
          if (filesToStage.length > 0) {
            // First, unstage all files to ensure we only commit what the user selected
            // This prevents previously-staged files from being included in the commit
            log.info(`[git:commit] Resetting staging area before staging selected files`);
            if (repoHasCommits) {
              await git.reset(['HEAD']);
            } else {
              // In a fresh repo with no commits, HEAD doesn't exist.
              // Use `git rm --cached` to unstage files instead.
              if (originallyStaged.size > 0) {
                await git.raw(['rm', '--cached', '-r', '.']);
              }
            }

            const filesToStageRelative = filesToStage.map(toGitPath);
            log.info(`[git:commit] Staging files (raw): ${filesToStage.join(', ')}`);
            log.info(`[git:commit] Staging files (git-relative): ${filesToStageRelative.join(', ')}`);

            // Check which files actually exist on disk before staging
            const fileExistence = filesToStage.map((f) => {
              const absPath = isAbsolute(f) ? f : join(workspacePath, f);
              return { path: f, exists: existsSync(absPath) };
            });
            const missingOnDisk = fileExistence.filter((f) => !f.exists);
            if (missingOnDisk.length > 0) {
              log.warn(`[git:commit] Files missing on disk: ${missingOnDisk.map((f) => f.path).join(', ')}`);
            }

            // Use --all so deletions are staged correctly. Plain `git add <path>`
            // errors with "pathspec did not match any files" when the proposal
            // includes deleted files (e.g., during renames).
            await git.add(['--all', '--', ...filesToStage]);

            // Verify only the selected files are staged
            const status = await git.status();
            const stagedFiles = new Set([...status.staged, ...status.created]);
            log.info(`[git:commit] After staging - staged files: [${[...status.staged].join(', ')}], created files: [${[...status.created].join(', ')}]`);
            log.info(`[git:commit] Full status - modified: [${status.modified.join(', ')}], not_added: [${status.not_added.join(', ')}], deleted: [${status.deleted.join(', ')}], renamed: [${status.renamed.map((r) => `${r.from}->${r.to}`).join(', ')}], conflicted: [${status.conflicted.join(', ')}]`);

            if (stagedFiles.size === 0) {
              log.warn(`[git:commit] No files were staged despite add() succeeding. Requested: [${filesToStage.join(', ')}], git-relative: [${filesToStageRelative.join(', ')}]`);
              // Restore originally staged files before returning
              if (originallyStaged.size > 0) {
                await git.add(Array.from(originallyStaged));
              }
              return {
                success: false,
                error: 'No files were staged. The files may not exist or have no changes.',
              };
            }

            const filesToStageRelSet = new Set(filesToStageRelative);
            const unexpectedFiles = Array.from(stagedFiles).filter(f => !filesToStageRelSet.has(f));
            const missingFiles = filesToStageRelative.filter(f => !stagedFiles.has(f));

            if (unexpectedFiles.length > 0) {
              log.error(`[git:commit] Unexpected files staged: ${unexpectedFiles.join(', ')}`);
              // Restore original state and abort
              if (repoHasCommits) {
                await git.reset(['HEAD']);
              } else {
                await git.raw(['rm', '--cached', '-r', '.']);
              }
              if (originallyStaged.size > 0) {
                await git.add(Array.from(originallyStaged));
              }
              return {
                success: false,
                error: `Unexpected files were staged: ${unexpectedFiles.join(', ')}. Commit aborted.`,
              };
            }

            if (missingFiles.length > 0) {
              log.warn(`[git:commit] Some selected files were not staged: ${missingFiles.join(', ')}`);
            }
          }

          // Commit
          const result = await git.commit(message);
          log.info(`[git:commit] Commit result: hash=${result.commit || 'empty'}, changes=${result.summary?.changes || 0}`);

          // simple-git returns empty commit hash if nothing was committed
          if (!result.commit) {
            log.warn(`[git:commit] Commit returned empty hash - nothing was committed`);
            // Restore originally staged files before returning
            if (originallyStaged.size > 0) {
              await git.add(Array.from(originallyStaged));
            }
            return {
              success: false,
              error: 'No changes were committed. Files may not have been staged correctly.',
            };
          }

          // Restore originally staged files that weren't part of this commit
          const committedFilesSet = new Set((filesToStage || []).map(toGitPath));
          const filesToRestage = Array.from(originallyStaged).filter(f => !committedFilesSet.has(f));
          if (filesToRestage.length > 0) {
            log.info(`[git:commit] Restoring ${filesToRestage.length} originally staged files`);
            await git.add(filesToRestage);
          }

          log.info(`[git:commit] Successfully committed: ${result.commit}`);

          // Get the actual commit date from git
          let commitDate: string | undefined;
          try {
            const showResult = await git.show([result.commit, '--no-patch', '--format=%aI']);
            commitDate = showResult.trim();
          } catch {
            // Non-critical - fall through without date
          }

          return {
            success: true,
            commitHash: result.commit,
            commitDate,
          };
        } catch (error) {
          log.error('[git:commit] Failed to commit:', error);
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });
    }
  );

  log.info('Git IPC handlers registered');
}
