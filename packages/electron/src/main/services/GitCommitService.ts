import log from 'electron-log/main';
import { existsSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
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

        const toGitPath = (f: string) => {
          const rel = isAbsolute(f) ? relative(workspacePath, f) : f;
          return rel.replace(/\\/g, '/');
        };

        if (!filesToStage || filesToStage.length === 0) {
          const preStatus = await git.status();
          const stagedCount = preStatus.staged.length + preStatus.created.length;
          if (stagedCount === 0) {
            return {
              success: false,
              error: 'No files are staged for commit.',
            };
          }
          log.info(`${logContext} Index-as-is mode: committing ${stagedCount} staged files`);

          const result = await git.commit(message);
          if (!result.commit) {
            return {
              success: false,
              error: 'No changes were committed.',
            };
          }

          // log.info(`${logContext} Successfully committed: ${result.commit}`);
          let commitDate: string | undefined;
          try {
            const showResult = await git.show([result.commit, '--no-patch', '--format=%aI']);
            commitDate = showResult.trim();
          } catch {
            // Non-critical
          }

          return { success: true, commitHash: result.commit, commitDate };
        }

        const initialStatus = await git.status();
        const originallyStaged = new Set([...initialStatus.staged, ...initialStatus.created]);
        // log.info(`${logContext} Originally staged files: ${originallyStaged.size}`);

        // log.info(`${logContext} Resetting staging area before staging selected files`);
        if (repoHasCommits) {
          await git.reset(['HEAD']);
        } else if (originallyStaged.size > 0) {
          await git.raw(['rm', '--cached', '-r', '.']);
        }

        const filesToStageRelative = filesToStage.map(toGitPath);
        // log.info(`${logContext} Staging files (raw): ${filesToStage.join(', ')}`);
        // log.info(`${logContext} Staging files (git-relative): ${filesToStageRelative.join(', ')}`);

        await git.add(['--all', '--', ...filesToStage]);

        const status = await git.status();
        const stagedFiles = new Set([...status.staged, ...status.created]);
        // log.info(`${logContext} After staging - staged files: [${[...status.staged].join(', ')}], created files: [${[...status.created].join(', ')}]`);

        if (stagedFiles.size === 0) {
          log.warn(`${logContext} No files were staged despite add() succeeding. Requested: [${filesToStage.join(', ')}], git-relative: [${filesToStageRelative.join(', ')}]`);
          if (originallyStaged.size > 0) {
            await git.add(Array.from(originallyStaged));
          }
          return {
            success: false,
            error: 'No files were staged. The files may not exist or have no changes.',
          };
        }

        const filesToStageRelSet = new Set(filesToStageRelative);
        const unexpectedFiles = Array.from(stagedFiles).filter((f) => !filesToStageRelSet.has(f));
        const missingFiles = filesToStageRelative.filter((f) => !stagedFiles.has(f));

        if (unexpectedFiles.length > 0) {
          log.error(`${logContext} Unexpected files staged: ${unexpectedFiles.join(', ')}`);
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
          log.warn(`${logContext} Some selected files were not staged: ${missingFiles.join(', ')}`);
        }

        const result = await git.commit(message);
        // log.info(`${logContext} Commit result: hash=${result.commit || 'empty'}, changes=${result.summary?.changes || 0}`);

        if (!result.commit) {
          log.warn(`${logContext} Commit returned empty hash - nothing was committed`);
          if (originallyStaged.size > 0) {
            await git.add(Array.from(originallyStaged));
          }
          return {
            success: false,
            error: 'No changes were committed. Files may not have been staged correctly.',
          };
        }

        const committedFilesSet = new Set((filesToStage || []).map(toGitPath));
        const filesToRestage = Array.from(originallyStaged).filter((f) => !committedFilesSet.has(f));
        if (filesToRestage.length > 0) {
          log.info(`${logContext} Restoring ${filesToRestage.length} originally staged files`);
          await git.add(filesToRestage);
        }

        // log.info(`${logContext} Successfully committed: ${result.commit}`);

        let commitDate: string | undefined;
        try {
          const showResult = await git.show([result.commit, '--no-patch', '--format=%aI']);
          commitDate = showResult.trim();
        } catch {
          // Non-critical
        }

        return {
          success: true,
          commitHash: result.commit,
          commitDate,
        };
      } catch (error) {
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
