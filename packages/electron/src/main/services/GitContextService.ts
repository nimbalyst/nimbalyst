import { execFileSync } from 'child_process';

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

/**
 * Resolve the git context by asking git itself (`rev-parse --show-toplevel`).
 * Deliberately uncached: mirrors the previous existsSync(.git) semantics, so
 * a `git init` (or a deleted repo) is reflected on the very next call. Every
 * caller is about to spawn a git subprocess anyway, so the extra ~5-10ms
 * rev-parse is marginal.
 */
export function resolveGitContext(workspacePath: string): GitContext {
  if (!workspacePath) {
    return { isRepo: false, gitRoot: null };
  }
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: workspacePath,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return gitRoot
      ? { isRepo: true, gitRoot }
      : { isRepo: false, gitRoot: null };
  } catch {
    // Not a repo, git missing, or the path does not exist.
    return { isRepo: false, gitRoot: null };
  }
}
