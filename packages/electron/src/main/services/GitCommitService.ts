import log from 'electron-log/main';
import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import simpleGit, { SimpleGit } from 'simple-git';
import {
  describeForbiddenGitAuthor,
  resolveGitAuthorIdentity,
  type ResolvedGitAuthor,
} from './GitAuthorIdentityGuard';
import { gitOperationLock } from './GitOperationLock';
import { GIT_INHERITED_ENV_UNSAFE } from './gitInheritedEnvUnsafe';
import { sanitizeGitRepositoryEnv } from './gitRepositoryEnv';

export interface GitCommitExecutionResult {
  success: boolean;
  commitHash?: string;
  commitDate?: string;
  error?: string;
  /**
   * The commit is durable, but the repository's index still shows the committed
   * files as pending changes because the post-commit refresh could not take
   * .git/index.lock. Cosmetic and self-correcting on the next Git write, but
   * callers should not report a spotless working tree.
   */
  indexRefreshFailed?: boolean;
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

/**
 * A commit proposal stages an approved subset, which used to mean mutating the
 * repository's real index and repairing it afterwards from a byte-for-byte
 * backup. That repair wrote `.git/index` outside Git's `index.lock` protocol,
 * so no well-behaved concurrent Git process could defend against it: a
 * concurrent `git add` was silently erased, and an index overwrite landing
 * between the staged-set check and `git commit` could put an unapproved file
 * into the commit. See NIM-2284.
 *
 * Everything up to and including `git commit` now runs against a private index
 * named below, so the real index is never written outside Git's own locking.
 */
const TEMP_INDEX_PREFIX = 'nimbalyst-commit-';
const TEMP_INDEX_SUFFIX = '.index';
/** No commit runs for an hour, so anything older was abandoned by a crash. */
const STALE_TEMP_INDEX_AGE_MS = 60 * 60 * 1000;

async function resolveGitDir(git: SimpleGit): Promise<string> {
  // Resolves a linked worktree to its own private git dir, which is where that
  // worktree's index lives — so the temp index always lands beside the real one.
  const gitDir = (await git.raw(['rev-parse', '--absolute-git-dir'])).trim();
  if (!gitDir) {
    throw new Error('Git did not resolve a repository directory');
  }
  return gitDir;
}

function createTempIndexPath(gitDir: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return join(gitDir, `${TEMP_INDEX_PREFIX}${unique}${TEMP_INDEX_SUFFIX}`);
}

/**
 * A killed process cannot run its own cleanup, so reclaim abandoned temp
 * indexes here. Deliberately matches only this service's own naming: it must
 * never remove one of Git's files, nor a legacy `.nimbalyst-index-backup-*`
 * that a previous version wrote.
 */
function sweepStaleTempIndexes(gitDir: string, logContext: string): void {
  try {
    const now = Date.now();
    for (const entry of readdirSync(gitDir)) {
      const isTempIndex =
        entry.startsWith(TEMP_INDEX_PREFIX) &&
        (entry.endsWith(TEMP_INDEX_SUFFIX) || entry.endsWith(`${TEMP_INDEX_SUFFIX}.lock`));
      if (!isTempIndex) continue;

      const candidate = join(gitDir, entry);
      try {
        if (now - statSync(candidate).mtimeMs < STALE_TEMP_INDEX_AGE_MS) continue;
        rmSync(candidate, { force: true });
      } catch {
        // Raced with another sweep or an in-flight commit; leave it.
      }
    }
  } catch (error) {
    log.warn(`${logContext} Could not sweep abandoned commit indexes:`, error);
  }
}

function removeTempIndex(tempIndexPath: string): void {
  try {
    rmSync(tempIndexPath, { force: true });
    rmSync(`${tempIndexPath}.lock`, { force: true });
  } catch (error) {
    log.warn(`[git:commit] Could not remove the temporary commit index:`, error);
  }
}

/**
 * Paths staged in the given index relative to HEAD. Compares index against HEAD
 * only — never the worktree — because the temp index is built by `read-tree`
 * and so carries no stat cache; a full `git status` would re-hash the entire
 * checkout on every commit.
 */
async function readStagedPaths(git: SimpleGit, repoHasCommits: boolean): Promise<string[]> {
  const raw = repoHasCommits
    ? await git.raw(['diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD'])
    : await git.raw(['ls-files', '--cached', '-z']);
  return raw.split('\0').filter((entry) => entry.length > 0);
}

/**
 * `git commit` moved HEAD, but the real index still holds the pre-commit blobs
 * for the paths just committed — so without this they read as staged reverts,
 * and brand-new files as staged deletions. This is the ONLY command in the
 * workflow that writes the real index.
 *
 * Unlike the commit it is idempotent and has nothing to lose, so losing the
 * lock costs only a retry. Failing it leaves a stale-looking index, which was
 * the whole of NIM-2284; be patient, because by this point the commit is
 * already durable and waiting is free.
 */
async function refreshCommittedPathsInRealIndex(
  git: SimpleGit,
  relativePaths: string[],
  retry: { maxRetries: number; baseDelayMs: number },
  logContext: string
): Promise<boolean> {
  for (let attempt = 0; attempt <= retry.maxRetries; attempt++) {
    if (attempt > 0) {
      await delay(retry.baseDelayMs * 2 ** (attempt - 1));
    }
    try {
      await git.raw(['--literal-pathspecs', 'reset', 'HEAD', '--', ...relativePaths]);
      return true;
    } catch (error) {
      if (!isIndexLockError(error)) {
        log.error(`${logContext} Could not refresh the staging area after committing:`, error);
        return false;
      }
    }
  }
  log.error(
    `${logContext} .git/index.lock stayed held after ${retry.maxRetries + 1} attempts; ` +
    'the commit is durable but the staging area still shows the committed files as pending changes'
  );
  return false;
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
/**
 * Higher than the pre-commit budget: by the time the post-commit refresh runs
 * the commit is durable, so waiting out a busy repository costs nothing while
 * giving up leaves a stale-looking index.
 */
const DEFAULT_INDEX_REFRESH_MAX_RETRIES = 6;

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
     * Repository-selection variables are always removed so workspacePath remains
     * authoritative. When omitted, all other values come from process.env.
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
      let tempIndexPath: string | null = null;
      let successfulCommit: { hash: string; date?: string } | null = null;
      try {
        const gitEnv = sanitizeGitRepositoryEnv(options?.env ?? process.env);
        const withOutput = (instance: SimpleGit): SimpleGit => {
          if (options?.onOutput) {
            instance.outputHandler((_command, stdout, stderr) => {
              stdout.on('data', (chunk: Buffer | string) => options.onOutput?.('stdout', chunk.toString()));
              stderr.on('data', (chunk: Buffer | string) => options.onOutput?.('stderr', chunk.toString()));
            });
          }
          return instance;
        };
        const git: SimpleGit = withOutput(
          simpleGit(workspacePath, { unsafe: GIT_INHERITED_ENV_UNSAFE }).env(gitEnv)
        );

        // Reject before touching the index at all: a fixture identity (the
        // "Test User" denylist scripts/check-push-authors.mjs enforces at push
        // time -- 2026-07-22 incident) must never reach a real commit in the
        // first place. Resolve via `git var GIT_AUTHOR_IDENT` so an
        // env-only override (GIT_AUTHOR_NAME/EMAIL) is caught too, not just
        // repo/global config.
        let authorIdentity: ResolvedGitAuthor;
        try {
          authorIdentity = await resolveGitAuthorIdentity(git);
        } catch (identityError) {
          return {
            success: false,
            error: `Could not resolve the git author identity for this commit: ${getGitCommitErrorMessage(identityError)}`,
          };
        }
        const forbiddenAuthor = describeForbiddenGitAuthor(authorIdentity);
        if (forbiddenAuthor) {
          log.error(`${logContext} Refusing to commit with a test-fixture git identity: ${forbiddenAuthor}`);
          return {
            success: false,
            error: `Refusing to commit as a test-fixture git identity (${forbiddenAuthor}). Set a real git user.name/user.email before committing.`,
          };
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

        // Validate every submitted path before touching any index, so a rejected
        // proposal cannot disturb the caller's existing staging state.
        const filesToStageRelative = filesToStage.map(toGitPath);

        const gitDir = await resolveGitDir(git);
        sweepStaleTempIndexes(gitDir, logContext);
        tempIndexPath = createTempIndexPath(gitDir);

        // `sanitizeGitRepositoryEnv` above already dropped any inherited
        // GIT_INDEX_FILE, which would otherwise redirect the index the way a
        // hook-launched process does. Only ours is injected, and only here.
        const stagingGit: SimpleGit = withOutput(
          simpleGit(workspacePath, { unsafe: GIT_INHERITED_ENV_UNSAFE })
            .env({ ...gitEnv, GIT_INDEX_FILE: tempIndexPath })
        );

        // Seed the private index from HEAD so the commit carries the whole tree,
        // not just the proposal's files.
        await stagingGit.raw(repoHasCommits ? ['read-tree', 'HEAD'] : ['read-tree', '--empty']);

        // log.info(`${logContext} Staging files (raw): ${filesToStage.join(', ')}`);
        // log.info(`${logContext} Staging files (git-relative): ${filesToStageRelative.join(', ')}`);

        // `--literal-pathspecs` stops Git from interpreting globs or pathspec
        // magic in a proposal. Keep it before the command: it is a global Git
        // option, not an `add` option.
        await stagingGit.raw(['--literal-pathspecs', 'add', '--all', '--', ...filesToStageRelative]);

        // No longer a time-of-check/time-of-use gap: the index checked here is
        // private to this operation, so nothing can restage between now and the
        // commit below.
        const stagedFiles = new Set(await readStagedPaths(stagingGit, repoHasCommits));
        // log.info(`${logContext} After staging - staged files: [${[...stagedFiles].join(', ')}]`);

        if (stagedFiles.size === 0) {
          log.warn(`${logContext} No files were staged despite add() succeeding. Requested: [${filesToStage.join(', ')}], git-relative: [${filesToStageRelative.join(', ')}]`);
          return { success: false, error: 'No files were staged. The files may not exist or have no changes.' };
        }

        const filesToStageRelSet = new Set(filesToStageRelative);
        const unexpectedFiles = Array.from(stagedFiles).filter((f) => !filesToStageRelSet.has(f));
        const missingFiles = filesToStageRelative.filter((f) => !stagedFiles.has(f));

        if (unexpectedFiles.length > 0) {
          log.error(`${logContext} Unexpected files staged: ${unexpectedFiles.join(', ')}`);
          return { success: false, error: `Unexpected files were staged: ${unexpectedFiles.join(', ')}. Commit aborted.` };
        }

        if (missingFiles.length > 0) {
          log.warn(`${logContext} Some selected files were not staged: ${missingFiles.join(', ')}`);
          return { success: false, error: `Some selected files were not staged: ${missingFiles.join(', ')}. Commit aborted.` };
        }

        const result = await stagingGit.commit(message);
        // log.info(`${logContext} Commit result: hash=${result.commit || 'empty'}, changes=${result.summary?.changes || 0}`);

        if (!result.commit) {
          log.warn(`${logContext} Commit returned empty hash - nothing was committed`);
          return { success: false, error: 'No changes were committed. Files may not have been staged correctly.' };
        }

        // From here on the commit is durable. Post-commit bookkeeping must never
        // retry the commit.
        successfulCommit = { hash: result.commit };

        // The real index was never touched, so unrelated staged hunks — and any
        // concurrent `git add` — are still intact. Only the committed paths need
        // moving to their new HEAD entries.
        const indexRefreshed = await refreshCommittedPathsInRealIndex(
          git,
          filesToStageRelative,
          {
            maxRetries: options?.lockRetry?.maxRetries ?? DEFAULT_INDEX_REFRESH_MAX_RETRIES,
            baseDelayMs: lockBaseDelayMs,
          },
          logContext
        );

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
          ...(indexRefreshed ? {} : { indexRefreshFailed: true }),
        };
      } catch (error) {
        if (successfulCommit) {
          // A durable commit is never rolled back or retried. Post-commit
          // bookkeeping may be incomplete, but returning failure here would
          // invite a duplicate commit.
          log.warn(`${logContext} Commit succeeded but post-commit bookkeeping failed:`, error);
          return {
            success: true,
            commitHash: successfulCommit.hash,
            commitDate: successfulCommit.date,
            indexRefreshFailed: true,
          };
        }
        // Also covers hook failures after staging. Nothing to unwind: every
        // mutation so far landed in the temp index, which the `finally` removes.
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
      } finally {
        // Every staging mutation lived here, so discarding it is the whole of
        // the cleanup — on success, on failure, and between lock retries.
        if (tempIndexPath) removeTempIndex(tempIndexPath);
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
