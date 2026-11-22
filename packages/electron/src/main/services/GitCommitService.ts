import { execFile } from 'child_process';
import log from 'electron-log/main';
import { existsSync, readdirSync, rmSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import type { SimpleGit } from 'simple-git';
import { createGit } from './gitClient';
import {
  filterPatchToHunks,
  matchHunkRefs,
  parseUnifiedDiffToHunks,
  supportsHunkSelection,
  type HunkRef,
  type HunkSelection,
} from '@nimbalyst/runtime/ui/git/unifiedDiffModel';
import { gitOperationLock } from './GitOperationLock';
import { groupFilesByRepo } from './workspaceRepos';
import { sanitizeGitRepositoryEnv } from './gitRepositoryEnv';

export type { HunkRef, HunkSelection };

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
  /**
   * Per-repo detail when the file list spanned more than one repository and the
   * commit was split. Absent for the ordinary single-repo commit. The top-level
   * fields summarize: `success` is true only if every repo committed, and
   * `commitHash` is the first repo's, so existing single-repo UI still has
   * something to show.
   */
  repoResults?: Array<{ repoPath: string } & GitCommitExecutionResult>;
  /**
   * Files that belong to no repository. They were not committed anywhere;
   * surfaced rather than dropped so the user is not told a file was committed
   * when it was not.
   */
  uncommittableFiles?: string[];
  /**
   * The caller's own path strings for the files that actually landed in a
   * commit. Present whenever the commit was resolved across repos, so a caller
   * can leave everything else selected instead of clearing the whole selection
   * after a partial failure. Absent when the repo was given explicitly.
   */
  committedFiles?: string[];
}

export interface GitCommitProposalResponse {
  action: 'committed' | 'cancelled' | 'error';
  commitHash?: string;
  commitDate?: string;
  error?: string;
  filesCommitted?: string[];
  commitMessage?: string;
  /**
   * Files that belong to no repository. Never committed, and excluded from
   * `filesCommitted` so a partial result is not reported as a complete one.
   */
  uncommittableFiles?: string[];
  /**
   * Per-repo outcome when the proposal spanned several repositories. Present on
   * a partial failure so the caller can retry only the repos that did not
   * commit rather than re-proposing the whole file list.
   */
  repoResults?: Array<{ repoPath: string; success: boolean; commitHash?: string; error?: string }>;
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
 * Convert an IPC-supplied path to a literal path inside one repository.
 *
 * Commit and discard both operate on concrete selected files, never Git query
 * pathspecs. Keep this validation shared so neither destructive path can widen
 * beyond the selected repository-relative filenames.
 */
export function toRepositoryRelativePath(workspacePath: string, filePath: string): string {
  if (!filePath || filePath.includes('\0')) {
    throw new Error('Invalid file path');
  }

  const resolvedWorkspacePath = resolve(workspacePath);
  const resolvedPath = resolve(resolvedWorkspacePath, filePath);
  const relativePath = relative(resolvedWorkspacePath, resolvedPath);
  const escapesRepository =
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath);

  if (escapesRepository || relativePath.length === 0) {
    throw new Error('File is outside the repository');
  }

  // `--` ends option parsing but does not disable a leading `:` pathspec.
  if (relativePath.startsWith(':')) {
    throw new Error('File must be a literal path, not a Git pathspec');
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

/**
 * Global options pinned so a user's diff config cannot produce a patch that
 * `git apply` then rejects: `diff.noprefix` strips the `a/`/`b/` prefixes that
 * `-p1` expects, and a textconv filter yields a rendering of the file rather
 * than its bytes. `@@` numbering is unaffected by any of these, so hunk refs
 * captured from the widget's (unpinned) diff still match.
 */
function hunkDiffArgs(relPath: string): string[] {
  return [
    '--literal-pathspecs',
    '-c',
    'diff.noprefix=false',
    '-c',
    'diff.mnemonicPrefix=false',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    'HEAD',
    '--',
    relPath,
  ];
}

/**
 * Apply a filtered patch to the private index via stdin.
 *
 * simple-git has no stdin channel for raw commands, and writing the patch to
 * disk would leave an artifact to sweep after a crash. The callback form of
 * `execFile` is used deliberately rather than `promisify` -- `promisify.custom`
 * bypasses a mocked `execFile`, which silently turns a spied subprocess
 * boundary into a no-op.
 *
 * `--whitespace=nowarn` because the patch is git's own description of content
 * the user already has on disk; a strict `core.whitespace` must not veto
 * committing it.
 */
function applyPatchToIndex(
  patch: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      'git',
      ['--literal-pathspecs', 'apply', '--cached', '--whitespace=nowarn', '-'],
      { windowsHide: true, cwd, env },
      (error, _stdout, stderr) => {
        if (error) {
          const detail = (typeof stderr === 'string' ? stderr : '').trim();
          reject(new Error(detail || error.message));
          return;
        }
        resolvePromise();
      }
    );
    child.stdin?.end(patch);
  });
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
    /**
     * Stage only the listed hunks for these files instead of the whole file.
     * Every path must also appear in `filesToStage`. Files not named here keep
     * the whole-file path unchanged.
     */
    hunkSelections?: HunkSelection[];
    /**
     * #1682: the caller's turn was stopped. Checked once the repo lock is held;
     * a commit that has started runs to completion.
     */
    signal?: AbortSignal;
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
    if (options?.signal?.aborted) {
      return { success: false, error: 'Commit cancelled before it started: the turn was stopped. No commit was made.' };
    }
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
          createGit(workspacePath, {}, gitEnv)
        );
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

        // Resolve hunk selections against a freshly generated diff *before* any
        // index work. A ref that no longer matches means the file changed since
        // the proposal was built (typically a sibling session writing it), and
        // the selection no longer describes what the user approved.
        const partialPatches = new Map<string, string>();
        if (options?.hunkSelections?.length) {
          const stageable = new Set(filesToStageRelative);

          for (const selection of options.hunkSelections) {
            if (!selection?.hunks?.length) continue;
            const relPath = toGitPath(selection.path);

            if (!stageable.has(relPath)) {
              return {
                success: false,
                error: `Hunk selection references ${relPath}, which is not in the commit's file list.`,
              };
            }
            if (!repoHasCommits) {
              return {
                success: false,
                error: `Cannot stage individual hunks for ${relPath}: the repository has no commits to diff against.`,
              };
            }

            const rawDiff = await git.raw(hunkDiffArgs(relPath));
            const parsed = parseUnifiedDiffToHunks(rawDiff);

            if (!supportsHunkSelection(parsed)) {
              return {
                success: false,
                error: `Cannot stage individual hunks for ${relPath}: only modifications to existing text files support hunk selection.`,
              };
            }

            const { indices, unmatched } = matchHunkRefs(parsed, selection.hunks);
            if (unmatched.length > 0) {
              log.warn(
                `${logContext} Stale hunk selection for ${relPath}: ${unmatched.length} of ${selection.hunks.length} refs no longer match`
              );
              return {
                success: false,
                error: `The selected hunks for ${relPath} are out of date because the file changed after the proposal was created. Refresh the diff and choose again.`,
              };
            }

            const patch = filterPatchToHunks(parsed, indices);
            if (!patch) {
              return {
                success: false,
                error: `No hunks resolved for ${relPath}. Commit aborted.`,
              };
            }
            partialPatches.set(relPath, patch);
          }
        }

        const wholeFileRelative = filesToStageRelative.filter((f) => !partialPatches.has(f));

        const gitDir = await resolveGitDir(git);
        sweepStaleTempIndexes(gitDir, logContext);
        tempIndexPath = createTempIndexPath(gitDir);

        // `sanitizeGitRepositoryEnv` above already dropped any inherited
        // GIT_INDEX_FILE, which would otherwise redirect the index the way a
        // hook-launched process does. Only ours is injected, and only here.
        const stagingGit: SimpleGit = withOutput(
          createGit(workspacePath, {}, { ...gitEnv, GIT_INDEX_FILE: tempIndexPath })
        );

        // Seed the private index from HEAD so the commit carries the whole tree,
        // not just the proposal's files.
        await stagingGit.raw(repoHasCommits ? ['read-tree', 'HEAD'] : ['read-tree', '--empty']);

        // log.info(`${logContext} Staging files (raw): ${filesToStage.join(', ')}`);
        // log.info(`${logContext} Staging files (git-relative): ${filesToStageRelative.join(', ')}`);

        // `--literal-pathspecs` stops Git from interpreting globs or pathspec
        // magic in a proposal. Keep it before the command: it is a global Git
        // option, not an `add` option.
        if (wholeFileRelative.length > 0) {
          await stagingGit.raw(['--literal-pathspecs', 'add', '--all', '--', ...wholeFileRelative]);
        }

        // Partially-staged files go in as patches against the private index,
        // which was just seeded from HEAD. The working tree is never touched,
        // so the hunks the user left behind stay exactly as they are on disk.
        for (const [relPath, patch] of partialPatches) {
          try {
            await applyPatchToIndex(patch, workspacePath, {
              ...gitEnv,
              GIT_INDEX_FILE: tempIndexPath,
            });
          } catch (applyError) {
            const detail = applyError instanceof Error ? applyError.message : String(applyError);
            log.error(`${logContext} Failed to apply hunk selection for ${relPath}: ${detail}`);
            return {
              success: false,
              error: `Failed to stage the selected hunks for ${relPath}: ${detail}`,
            };
          }
        }

        // No longer a time-of-check/time-of-use gap: the index checked here is
        // private to this operation, so nothing can restage between now and the
        // commit below.
        const stagedFiles = new Set(await readStagedPaths(stagingGit, repoHasCommits));
        // log.info(`${logContext} After staging - staged files: [${[...stagedFiles].join(', ')}]`);

        if (stagedFiles.size === 0) {
          log.warn(`${logContext} No files were staged despite staging succeeding. Requested: [${filesToStage.join(', ')}], git-relative: [${filesToStageRelative.join(', ')}]`);
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
    // A successful commit can still have left files behind: anything in no
    // repository was never staged anywhere. Reporting the caller's full input
    // as `filesCommitted` would tell the user those files are committed.
    const skipped = new Set(result.uncommittableFiles ?? []);
    const response: GitCommitProposalResponse = {
      action: 'committed',
      commitHash: result.commitHash,
      commitDate: result.commitDate,
      filesCommitted: skipped.size > 0 ? files.filter((file) => !skipped.has(file)) : files,
      commitMessage,
    };
    if (skipped.size > 0) {
      response.uncommittableFiles = [...skipped];
    }
    // A selection spanning repos makes N commits, and `commitHash` is only the
    // first. Without this the user is told one commit landed when several did,
    // and the others have no hash anywhere in the UI.
    if (result.repoResults) {
      response.repoResults = result.repoResults.map(({ repoPath, success, commitHash, error }) => ({
        repoPath, success, commitHash, error,
      }));
    }
    return response;
  }

  return {
    action: 'error',
    error: result.error || 'No changes were committed',
    // Whatever DID commit before the failure, so the caller can retry only the
    // rest instead of re-proposing files that are already in history.
    ...(result.repoResults ? { repoResults: result.repoResults.map(({ repoPath, success, commitHash, error }) => ({ repoPath, success, commitHash, error })) } : {}),
    ...(result.uncommittableFiles ? { uncommittableFiles: result.uncommittableFiles } : {}),
  };
}

/**
 * Commit a file list that may span several repositories.
 *
 * A multi-root workspace can hand the user a proposal touching two checkouts;
 * git has no notion of a commit across repos, so this splits by owning
 * repository and commits each in turn with the same message. Sequential rather
 * than parallel: each `executeGitCommit` takes that repo's operation lock and
 * runs its hooks, and interleaving two hook runs is how you get confusing,
 * half-attributable output.
 *
 * The single-repo case -- everything real users hit today -- delegates straight
 * to `executeGitCommit` against the resolved repo root and returns its result
 * untouched, so nothing about an ordinary commit changes shape.
 */
export async function executeGitCommitAcrossRepos(
  workspacePath: string,
  message: string,
  filesToStage: string[],
  options?: Parameters<typeof executeGitCommit>[3] & {
    /** Commit only this repo, skipping resolution. Set by an explicit repoPath. */
    repoPath?: string;
    /**
     * Roots to consider besides `workspacePath`'s own. Set when committing from
     * a worktree session: attached folders are keyed by the PARENT workspace, so
     * without them every attached-folder file resolves to no repo, lands in
     * `uncommittableFiles`, and is silently dropped from the commit.
     */
    extraRoots?: string[];
  }
): Promise<GitCommitExecutionResult> {
  if (options?.repoPath) {
    return executeGitCommit(options.repoPath, message, filesToStage, options);
  }

  // Relative paths are workspace-relative by contract, and repo resolution
  // compares against absolute root paths -- so resolve before grouping.
  // `executeGitCommit` takes absolute paths and makes them repo-relative itself.
  const absoluteFiles = filesToStage.map((filePath) =>
    isAbsolute(filePath) ? filePath : resolve(workspacePath, filePath),
  );
  // Callers select by their own path strings and expect to hear back in the
  // same terms, so map resolved paths back before reporting what committed.
  const originalByAbsolute = new Map<string, string>();
  absoluteFiles.forEach((absolute, index) => {
    if (!originalByAbsolute.has(absolute)) originalByAbsolute.set(absolute, filesToStage[index]);
  });
  const toOriginal = (paths: string[]) => paths.map((p) => originalByAbsolute.get(p) ?? p);

  const groups = groupFilesByRepo(workspacePath, absoluteFiles, options?.extraRoots);
  const uncommittableFiles = groups.get(null) ?? [];
  groups.delete(null);

  const repoPaths = [...groups.keys()].filter((repo): repo is string => repo !== null);

  if (repoPaths.length === 0) {
    return {
      success: false,
      error: uncommittableFiles.length > 0
        ? 'None of the selected files are in a git repository'
        : 'No files to commit',
      uncommittableFiles: uncommittableFiles.length > 0 ? toOriginal(uncommittableFiles) : undefined,
      committedFiles: [],
    };
  }

  if (repoPaths.length === 1) {
    const repoFiles = groups.get(repoPaths[0])!;
    const result = await executeGitCommit(repoPaths[0], message, repoFiles, options);
    return {
      ...result,
      committedFiles: result.success ? toOriginal(repoFiles) : [],
      ...(uncommittableFiles.length > 0 ? { uncommittableFiles: toOriginal(uncommittableFiles) } : {}),
    };
  }

  const repoResults: Array<{ repoPath: string } & GitCommitExecutionResult> = [];
  for (const repoPath of repoPaths) {
    const files = groups.get(repoPath)!;
    // Hunk selections are per file, so each repo only gets the ones it owns.
    // Resolved the same way as the file list, since a selection may name the
    // file relative to the workspace while `files` is absolute.
    const repoFiles = new Set(files);
    const hunkSelections = options?.hunkSelections?.filter((selection) =>
      repoFiles.has(
        isAbsolute(selection.path) ? selection.path : resolve(workspacePath, selection.path),
      ),
    );
    const result = await executeGitCommit(repoPath, message, files, {
      ...options,
      hunkSelections,
      logContext: `${options?.logContext ?? '[git:commit]'} ${repoPath}`,
    });
    repoResults.push({ repoPath, ...result });
  }

  const failed = repoResults.filter((result) => !result.success);
  const committedFiles = toOriginal(
    repoResults.filter((result) => result.success).flatMap((result) => groups.get(result.repoPath)!),
  );
  return {
    success: failed.length === 0,
    commitHash: repoResults[0].commitHash,
    commitDate: repoResults[0].commitDate,
    committedFiles,
    error: failed.length > 0
      ? `Committed ${repoResults.length - failed.length} of ${repoResults.length} repositories. `
        + failed.map((result) => `${result.repoPath}: ${result.error ?? 'unknown error'}`).join('; ')
      : undefined,
    repoResults,
    uncommittableFiles: uncommittableFiles.length > 0 ? toOriginal(uncommittableFiles) : undefined,
  };
}
