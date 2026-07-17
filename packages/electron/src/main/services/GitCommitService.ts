import log from 'electron-log/main';
import { copyFileSync, existsSync, rmSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import simpleGit, { SimpleGit } from 'simple-git';
import { gitOperationLock } from './GitOperationLock';
import { GIT_INHERITED_ENV_UNSAFE } from './gitInheritedEnvUnsafe';

export interface GitCommitExecutionResult {
  success: boolean;
  commitHash?: string;
  commitDate?: string;
  error?: string;
}

export interface GitCommitProposalResponse {
  action: 'committed' | 'cancelled' | 'error';
  commitHash?: string;
  commitDate?: string;
  error?: string;
  filesCommitted?: string[];
  commitMessage?: string;
}

function isGitRepository(workspacePath: string): boolean {
  try {
    return existsSync(join(workspacePath, '.git'));
  } catch {
    return false;
  }
}

async function hasCommits(git: SimpleGit): Promise<boolean> {
  try {
    await git.revparse(['HEAD']);
    return true;
  } catch {
    return false;
  }
}

function getGitCommitErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

/**
 * Convert a proposal path to a literal path inside the session's repository.
 *
 * MCP commit proposals are deliberately scoped to their session worktree. Do
 * not let an absolute path, `..`, or Git pathspec magic widen that scope. The
 * returned path is always repository-relative and is passed to Git with its
 * literal-pathspec mode enabled below.
 */
function toRepositoryRelativePath(workspacePath: string, filePath: string): string {
  if (!filePath || filePath.includes('\0')) {
    throw new Error('Invalid file path in commit proposal');
  }

  const resolvedPath = resolve(workspacePath, filePath);
  const relativePath = relative(workspacePath, resolvedPath);
  const escapesWorkspace =
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath);

  if (escapesWorkspace || relativePath.length === 0) {
    throw new Error('Commit proposal file is outside the session workspace');
  }

  // Git interprets a leading ':' as pathspec magic, even after '--'. The
  // proposal contract is a list of concrete files, not a Git query language.
  if (relativePath.startsWith(':')) {
    throw new Error('Commit proposal file must be a literal path');
  }

  return relativePath.replace(/\\/g, '/');
}

interface GitIndexBackup {
  hadIndex: boolean;
  restore(): boolean;
  dispose(): void;
}

/**
 * `executeGitCommit` deliberately changes the index to commit an approved
 * subset. Keep a byte-for-byte backup so every rejected or failed proposal can
 * restore the caller's original staged state, including partial hunks.
 */
async function backupGitIndex(git: SimpleGit, workspacePath: string): Promise<GitIndexBackup | null> {
  const rawIndexPath = (await git.raw(['rev-parse', '--git-path', 'index'])).trim();
  if (!rawIndexPath) return null;

  const indexPath = isAbsolute(rawIndexPath)
    ? rawIndexPath
    : resolve(workspacePath, rawIndexPath);
  if (!existsSync(indexPath)) {
    // A new repository may not have an index yet. On a failed proposal, remove
    // the index created by staging so its pre-proposal state is restored.
    return {
      hadIndex: false,
      restore: () => {
        try {
          rmSync(indexPath, { force: true });
          return !existsSync(indexPath);
        } catch {
          return false;
        }
      },
      dispose: () => {},
    };
  }

  const backupPath = join(
    dirname(indexPath),
    `.nimbalyst-index-backup-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  copyFileSync(indexPath, backupPath);

  return {
    hadIndex: true,
    restore: () => {
      try {
        copyFileSync(backupPath, indexPath);
        return true;
      } catch {
        return false;
      }
    },
    dispose: () => rmSync(backupPath, { force: true }),
  };
}

/**
 * Detect the transient ".git/index.lock already exists" failure that happens when
 * another git process (a second AI session, an external terminal, an editor's git
 * integration, a hook, or — on Windows — AV/indexer holding the file handle after
 * git released it) is mid-operation on the same repo. The in-process gitOperationLock
 * only serializes commits originating inside this Electron process, so it cannot
 * prevent these collisions; we back off and retry instead.
 */
function isIndexLockError(error: unknown): boolean {
  const msg = getGitCommitErrorMessage(error);
  return (
    /index\.lock/i.test(msg) &&
    (/File exists/i.test(msg) || /Another git process/i.test(msg))
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_LOCK_MAX_RETRIES = 5;
const DEFAULT_LOCK_BASE_DELAY_MS = 100;

export async function executeGitCommit(
  workspacePath: string,
  message: string,
  filesToStage: string[],
  options?: {
    logContext?: string;
    /** Tuning for index.lock contention backoff. Defaults to 5 retries from 100ms. */
    lockRetry?: { maxRetries?: number; baseDelayMs?: number };
    /**
     * Environment for the git subprocess (and any hooks it runs). Production callers
     * pass an enhanced env (see getGitSubprocessEnv) so husky hooks invoking nvm/Homebrew
     * binaries like `yarn` resolve, since GUI-launched apps don't inherit the shell PATH.
     * When omitted, git inherits process.env as usual.
     */
    env?: Record<string, string>;
    /** Stream git and hook output while the commit workflow is running. */
    onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  }
): Promise<GitCommitExecutionResult> {
  const logContext = options?.logContext || '[git:commit]';
  const maxLockRetries = options?.lockRetry?.maxRetries ?? DEFAULT_LOCK_MAX_RETRIES;
  const lockBaseDelayMs = options?.lockRetry?.baseDelayMs ?? DEFAULT_LOCK_BASE_DELAY_MS;

  if (!workspacePath) {
    return { success: false, error: 'workspacePath is required' };
  }
  if (!message) {
    return { success: false, error: 'message is required' };
  }
  if (!isGitRepository(workspacePath)) {
    return { success: false, error: 'Not a git repository' };
  }

  return gitOperationLock.withLock(workspacePath, 'git:commit', async () => {
    let lastLockError: unknown;
    // Retry the whole commit body when git fails because another process holds
    // .git/index.lock. Each iteration re-reads status, so it is idempotent.
    for (let attempt = 0; attempt <= maxLockRetries; attempt++) {
      if (attempt > 0) {
        const backoffMs = lockBaseDelayMs * 2 ** (attempt - 1);
        log.warn(
          `${logContext} .git/index.lock held by another git process; retrying (attempt ${attempt}/${maxLockRetries}) after ${backoffMs}ms`
        );
        await delay(backoffMs);
      }
      let indexBackup: GitIndexBackup | null = null;
      let indexMutated = false;
      let successfulCommit: { hash: string; date?: string } | null = null;
      const restoreOriginalIndex = (): boolean => {
        if (!indexMutated || !indexBackup) return true;
        const restored = indexBackup.restore();
        if (!restored) {
          log.error(`${logContext} Failed to restore the original staging area; preserving recovery backup`);
        }
        return restored;
      };
      try {
        const git: SimpleGit = options?.env
          ? simpleGit(workspacePath, { unsafe: GIT_INHERITED_ENV_UNSAFE }).env(options.env)
          : simpleGit(workspacePath);
        if (options?.onOutput) {
          git.outputHandler((_command, stdout, stderr) => {
            stdout.on('data', (chunk: Buffer | string) => options.onOutput?.('stdout', chunk.toString()));
            stderr.on('data', (chunk: Buffer | string) => options.onOutput?.('stderr', chunk.toString()));
          });
        }
        const repoHasCommits = await hasCommits(git);
        // log.info(`${logContext} Starting commit in ${workspacePath} with ${filesToStage?.length || 0} files (hasCommits: ${repoHasCommits})`);

        const toGitPath = (f: string) => toRepositoryRelativePath(workspacePath, f);

        if (!filesToStage || filesToStage.length === 0) {
          return {
            success: false,
            error: 'At least one selected file is required for a commit proposal.',
          };
        }

        // Validate every submitted path before resetting the index. A rejected
        // proposal must not be able to disturb the caller's existing staging
        // state.
        const filesToStageRelative = filesToStage.map(toGitPath);

        const initialStatus = await git.status();
        const originallyStaged = new Set([...initialStatus.staged, ...initialStatus.created]);
        // log.info(`${logContext} Originally staged files: ${originallyStaged.size}`);

        try {
          indexBackup = await backupGitIndex(git, workspacePath);
        } catch (backupError) {
          return {
            success: false,
            error: `Could not protect the existing staging area: ${getGitCommitErrorMessage(backupError)}`,
          };
        }
        if (!indexBackup) {
          return {
            success: false,
            error: 'Could not protect the existing staging area: Git did not resolve an index path.',
          };
        }
        const failAfterIndexMutation = (error: string): GitCommitExecutionResult => {
          const restored = restoreOriginalIndex();
          if (restored) indexBackup?.dispose();
          return {
            success: false,
            error: restored ? error : `${error} Original staging could not be restored; recovery backup was retained.`,
          };
        };

        // log.info(`${logContext} Resetting staging area before staging selected files`);
        indexMutated = true;
        if (repoHasCommits) {
          await git.reset(['HEAD']);
        } else if (originallyStaged.size > 0) {
          await git.raw(['rm', '--cached', '-r', '.']);
        }

        // log.info(`${logContext} Staging files (raw): ${filesToStage.join(', ')}`);
        // log.info(`${logContext} Staging files (git-relative): ${filesToStageRelative.join(', ')}`);

        // `--literal-pathspecs` stops Git from interpreting globs or pathspec
        // magic in a proposal. Keep it before the command: it is a global Git
        // option, not an `add` option.
        await git.raw(['--literal-pathspecs', 'add', '--all', '--', ...filesToStageRelative]);

        const status = await git.status();
        const stagedFiles = new Set([...status.staged, ...status.created]);
        // log.info(`${logContext} After staging - staged files: [${[...status.staged].join(', ')}], created files: [${[...status.created].join(', ')}]`);

        if (stagedFiles.size === 0) {
          log.warn(`${logContext} No files were staged despite add() succeeding. Requested: [${filesToStage.join(', ')}], git-relative: [${filesToStageRelative.join(', ')}]`);
          return failAfterIndexMutation('No files were staged. The files may not exist or have no changes.');
        }

        const filesToStageRelSet = new Set(filesToStageRelative);
        const unexpectedFiles = Array.from(stagedFiles).filter((f) => !filesToStageRelSet.has(f));
        const missingFiles = filesToStageRelative.filter((f) => !stagedFiles.has(f));

        if (unexpectedFiles.length > 0) {
          log.error(`${logContext} Unexpected files staged: ${unexpectedFiles.join(', ')}`);
          return failAfterIndexMutation(`Unexpected files were staged: ${unexpectedFiles.join(', ')}. Commit aborted.`);
        }

        if (missingFiles.length > 0) {
          log.warn(`${logContext} Some selected files were not staged: ${missingFiles.join(', ')}`);
          return failAfterIndexMutation(`Some selected files were not staged: ${missingFiles.join(', ')}. Commit aborted.`);
        }

        const result = await git.commit(message);
        // log.info(`${logContext} Commit result: hash=${result.commit || 'empty'}, changes=${result.summary?.changes || 0}`);

        if (!result.commit) {
          log.warn(`${logContext} Commit returned empty hash - nothing was committed`);
          return failAfterIndexMutation('No changes were committed. Files may not have been staged correctly.');
        }

        // From here on, the commit is durable. Post-commit bookkeeping must
        // never restore the old index or retry the commit.
        successfulCommit = { hash: result.commit };

        // Restore the old index byte-for-byte so unrelated partial hunks stay
        // staged exactly as they were, then set committed files to their new
        // HEAD entries.
        if (indexBackup?.hadIndex) {
          if (indexBackup.restore()) {
            try {
              await git.raw(['--literal-pathspecs', 'reset', 'HEAD', '--', ...filesToStageRelative]);
              indexBackup.dispose();
            } catch (recoveryError) {
              // The commit is durable. Preserve the byte-exact recovery copy
              // rather than risk a second mutation or a duplicate commit.
              log.error(`${logContext} Commit succeeded but staging recovery is incomplete; backup retained:`, recoveryError);
            }
          } else {
            log.error(`${logContext} Commit succeeded but the original staging area could not be restored; backup retained`);
          }
        } else {
          indexBackup?.dispose();
        }

        // log.info(`${logContext} Successfully committed: ${result.commit}`);

        let commitDate: string | undefined;
        try {
          const showResult = await git.show([result.commit, '--no-patch', '--format=%aI']);
          commitDate = showResult.trim();
          successfulCommit.date = commitDate;
        } catch {
          // Non-critical
        }

        return {
          success: true,
          commitHash: result.commit,
          commitDate,
        };
      } catch (error) {
        if (successfulCommit) {
          // A durable commit is never rolled back or retried. Post-commit
          // bookkeeping may be incomplete, but returning failure here would
          // invite a duplicate commit.
          // Leave any recovery backup in place. A durable commit must never be
          // retried or have its post-commit index reconstruction overwritten.
          log.warn(`${logContext} Commit succeeded but post-commit bookkeeping failed:`, error);
          return {
            success: true,
            commitHash: successfulCommit.hash,
            commitDate: successfulCommit.date,
          };
        }
        // The catch also covers hook failures after staging. Restore the exact
        // pre-proposal index before returning or retrying a lock collision.
        const restored = restoreOriginalIndex();
        if (restored) indexBackup?.dispose();
        if (!restored) {
          return {
            success: false,
            error: `${getGitCommitErrorMessage(error)} Original staging could not be restored; recovery backup was retained.`,
          };
        }
        if (isIndexLockError(error)) {
          lastLockError = error;
          if (attempt < maxLockRetries) {
            continue;
          }
          log.error(
            `${logContext} .git/index.lock still held after ${maxLockRetries + 1} attempts`,
            error
          );
          return {
            success: false,
            error: `Repository is locked by another git process: .git/index.lock could not be acquired after ${
              maxLockRetries + 1
            } attempts. ${getGitCommitErrorMessage(error)}`,
          };
        }
        log.error(`${logContext} Failed to commit:`, error);
        return {
          success: false,
          error: getGitCommitErrorMessage(error),
        };
      }
    }

    // Unreachable: the loop either returns a result or returns the lock error
    // on its final iteration. Present so the function is provably exhaustive.
    return {
      success: false,
      error: getGitCommitErrorMessage(lastLockError),
    };
  });
}

export function createGitCommitProposalResponse(
  result: GitCommitExecutionResult,
  files: string[],
  commitMessage: string
): GitCommitProposalResponse {
  if (result.success) {
    return {
      action: 'committed',
      commitHash: result.commitHash,
      commitDate: result.commitDate,
      filesCommitted: files,
      commitMessage,
    };
  }

  return {
    action: 'error',
    error: result.error || 'No changes were committed',
  };
}
