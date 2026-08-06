import { execFileSync } from 'child_process';
import { sanitizeGitRepositoryEnv } from './gitRepositoryEnv';

/**
 * The git context of a workspace: whether it lives inside a git repository,
 * and where that repository's root (toplevel working directory) is.
 *
 * `gitRoot` may differ from the workspace path when the user opened a
 * subfolder of a repo (issue #124). It equals the workspace path when the
 * workspace is the repo root (including linked worktrees, whose toplevel is
 * the worktree itself).
 */
export interface GitContext {
  isRepo: boolean;
  gitRoot: string | null;
}

// Per-workspace cache of the resolved context. resolveGitContext spawns a git
// subprocess, and its callers sit in the same hot paths where uncached `.git`
// probing measured 18-42% of main-process CPU (nimbalyst#895) -- a spawn there
// is strictly worse than the existsSync it replaces. Git roots do not move
// during a session, so memoizing is safe; same shape and rationale as
// gitDirExistsCache in GitStatusService.
const gitContextCache = new Map<string, GitContext>();

/** Test-only: reset the git-context cache. */
export function __resetGitContextCache(): void {
  gitContextCache.clear();
}

/**
 * Resolve the git context by asking git itself (`rev-parse --show-toplevel`),
 * memoized for the lifetime of the process. A workspace that is not a repo when
 * first resolved keeps that answer until restart, matching the staleness the
 * existing gitDirExistsCache already carries.
 *
 * Repository-selection variables are stripped from the environment: an inherited
 * GIT_DIR/GIT_WORK_TREE (git exports these to hooks) would otherwise override the
 * cwd and resolve the toplevel of an entirely different repository.
 */
export function resolveGitContext(workspacePath: string): GitContext {
  if (!workspacePath) {
    return { isRepo: false, gitRoot: null };
  }

  const cached = gitContextCache.get(workspacePath);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workspacePath,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sanitizeGitRepositoryEnv(process.env),
    }).trim();
    const context: GitContext = gitRoot
      ? { isRepo: true, gitRoot }
      : { isRepo: false, gitRoot: null };
    gitContextCache.set(workspacePath, context);
    return context;
  } catch {
    // Not a repo, git missing, or the path does not exist.
    const context: GitContext = { isRepo: false, gitRoot: null };
    gitContextCache.set(workspacePath, context);
    return context;
  }
}
