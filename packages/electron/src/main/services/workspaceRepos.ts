/**
 * Repository resolution for multi-root workspaces.
 *
 * The codebase historically equated "workspace path" with "the git repo". Once
 * a workspace can span several roots that stops holding: a root may be its own
 * repo, may be no repo at all, or may be a container holding several repos.
 * Everything git-related resolves through here instead of assuming the root.
 *
 * Two questions, deliberately answered by different mechanisms:
 *
 * - "Which repo owns THIS file?" -- `resolveRepoForFile`, exact, per file, via
 *   the existing `findGitRootForFile` walk. This is what status, diff, blame,
 *   and commit grouping need, and it handles submodules and nested repos for
 *   free because it walks up from the file.
 * - "Which repos does this workspace contain?" -- `listWorkspaceRepos`, a
 *   bounded scan used only to populate pickers and register ref watchers. It is
 *   lazy and cached because it touches the filesystem.
 */

import { existsSync, readdirSync } from 'fs';
import { isAbsolute, join, resolve as resolvePath } from 'path';
import { getAttachedFolders, getWorkspaceRoots } from '../utils/store';
import { findGitRootForFile } from './GitStatusService';
import { listIgnoredNestedRepositories } from '../utils/gitUtils';
import { isPathInWorkspace } from '../../shared/pathUtils';
import { logger } from '../utils/logger';

/**
 * Discovered repos per root, as the promise of the scan so concurrent callers
 * share one git call. Cleared on attach/detach, when a root's `.gitignore`
 * changes, and by tests. The scan never rejects.
 */
const reposByRoot = new Map<string, Promise<string[]>>();

/** Test-only, and called on attach/detach so a new root is scanned once. */
export function clearWorkspaceRepoCache(rootPath?: string): void {
  if (rootPath) {
    reposByRoot.delete(rootPath);
  } else {
    reposByRoot.clear();
  }
}

function isRepo(dir: string): boolean {
  try {
    return existsSync(join(dir, '.git'));
  } catch {
    return false;
  }
}

/**
 * Repos under a root.
 *
 * A root that is itself a repo answers with itself plus the separate checkouts
 * its ignore rules hide -- an umbrella repo whose clones sit inside it, each
 * gitignored so the umbrella's history stays its own. Submodules are tracked,
 * so they never appear here and are still reached per file by
 * `resolveRepoForFile`. A root that is NOT a repo is treated as a container and
 * scanned one level down -- deep enough for the "folder full of checkouts"
 * case, shallow enough that attaching a large directory does not walk it.
 */
async function scanRootForRepos(rootPath: string): Promise<string[]> {
  if (isRepo(rootPath)) {
    return [rootPath, ...(await listIgnoredNestedRepositories(rootPath))];
  }

  try {
    return readdirSync(rootPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => join(rootPath, entry.name))
      .filter(isRepo);
  } catch (error) {
    logger.main.warn('[workspaceRepos] Could not scan root for repos:', rootPath, error);
    return [];
  }
}

/** Repos under one root, cached. */
export function listReposForRoot(rootPath: string): Promise<string[]> {
  let repos = reposByRoot.get(rootPath);
  if (!repos) {
    repos = scanRootForRepos(rootPath);
    reposByRoot.set(rootPath, repos);
  }
  return repos;
}

/**
 * Every repo this workspace spans, in root order, deduplicated. Empty when no
 * root is or contains a repo -- a perfectly valid workspace, and callers must
 * handle it rather than assuming index 0 exists.
 */
export async function listWorkspaceRepos(workspacePath: string): Promise<string[]> {
  const seen = new Set<string>();
  const repos: string[] = [];
  for (const rootPath of getWorkspaceRoots(workspacePath)) {
    for (const repo of await listReposForRoot(rootPath)) {
      if (!seen.has(repo)) {
        seen.add(repo);
        repos.push(repo);
      }
    }
  }
  return repos;
}

/**
 * Every path a workspace-wide git scan has to visit: each root, plus each repo
 * discovered under it.
 *
 * A root that is itself a repo contributes only itself. A CONTAINER root -- one
 * that holds `checkouts/a` and `checkouts/b` -- is not a repo, so asking git
 * about the root returns nothing; its discovered repos have to be visited
 * individually or attached folders get no status at all. The roots stay in the
 * list so a repo created after the discovery cache warmed (`git init` mid
 * session) still answers.
 */
export async function listRepoScanPaths(workspacePath: string): Promise<string[]> {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const rootPath of getWorkspaceRoots(workspacePath)) {
    for (const candidate of [rootPath, ...(await listReposForRoot(rootPath))]) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        paths.push(candidate);
      }
    }
  }
  return paths;
}

/**
 * The roots a resolution should consider.
 *
 * `extraRoots` exists for the worktree case. Attached folders are stored under
 * the primary workspace's key, so `getWorkspaceRoots(worktreePath)` answers with
 * the worktree alone -- and every file in an attached folder then resolves to no
 * repo at all. The caller that knows both paths (it has the session record)
 * supplies the parent workspace's attached folders here.
 */
function rootsFor(workspacePath: string, extraRoots?: string[]): string[] {
  const roots = getWorkspaceRoots(workspacePath);
  if (!extraRoots?.length) return roots;
  const seen = new Set(roots);
  return [...roots, ...extraRoots.filter((root) => !seen.has(root) && !!seen.add(root))];
}

/**
 * Attached folders that a commit against `commitPath` should still consider.
 *
 * A worktree session commits against the worktree, not the workspace, and
 * attached folders are stored under the workspace's key -- so the worktree sees
 * none of them. Returns the parent workspace's attached folders in that case and
 * nothing at all for an ordinary session, where `getWorkspaceRoots` already
 * answers correctly and adding them twice would be noise.
 */
export function resolveExtraCommitRoots(
  commitPath: string,
  sessionWorkspacePath?: string | null,
): string[] {
  if (!sessionWorkspacePath) return [];
  if (resolvePath(sessionWorkspacePath) === resolvePath(commitPath)) return [];
  return getAttachedFolders(sessionWorkspacePath);
}

/**
 * The repo that owns `filePath`, or null when the file is in no repo (or in no
 * root of this workspace).
 *
 * Resolves within the file's own root, so a file in an attached folder is never
 * attributed to the primary root's repo.
 */
export function resolveRepoForFile(
  workspacePath: string,
  filePath: string,
  extraRoots?: string[],
): string | null {
  const roots = rootsFor(workspacePath, extraRoots);

  // Deepest containing root first: a root nested inside another root bounds the
  // walk more tightly, which is what its own `.git` deserves.
  const owningRoots = roots
    .filter((root) => isPathInWorkspace(filePath, root))
    .sort((a, b) => b.length - a.length);

  for (const root of owningRoots) {
    const repo = findGitRootForFile(filePath, root);
    if (repo) return repo;
  }
  return null;
}

/**
 * The repo a workspace-level git action should default to: the primary root's
 * repo when it has one, otherwise the first repo found in root order.
 *
 * Returns null for a workspace with no repos at all.
 */
export async function resolveDefaultRepo(workspacePath: string): Promise<string | null> {
  return (await listWorkspaceRepos(workspacePath))[0] ?? null;
}

/**
 * The single repo a commit proposal targets, or the groups it wrongly spans.
 *
 * One proposal is one commit in one repo. A list spanning repos would put N
 * commits behind a single approval, all sharing one message, with only the
 * first hash ever shown -- the exact shape that hid multi-repo commits for a
 * release. Callers reject that and let the agent make one call per group.
 *
 * Files in no repo do not make a proposal cross-repo: they are reported as
 * uncommittable after the commit, which is already correct.
 */
export function scopeProposalToRepo(
  workspacePath: string,
  filePaths: string[],
  extraRoots?: string[],
):
  | { ok: true; repoPath: string | null }
  | { ok: false; groups: Array<{ repoPath: string; files: string[] }> } {
  const absolute = filePaths.map((filePath) =>
    isAbsolute(filePath) ? filePath : resolvePath(workspacePath, filePath),
  );
  const groups = groupFilesByRepo(workspacePath, absolute, extraRoots);
  groups.delete(null);

  const repoPaths = [...groups.keys()].filter((repo): repo is string => repo !== null);
  if (repoPaths.length <= 1) {
    return { ok: true, repoPath: repoPaths[0] ?? null };
  }
  return {
    ok: false,
    groups: repoPaths.map((repoPath) => ({ repoPath, files: groups.get(repoPath)! })),
  };
}

/**
 * Group file paths by the workspace ROOT that owns them, primary root first.
 *
 * This is the coarser sibling of `groupFilesByRepo`, for the several services
 * whose repo walk is bounded by the path they are handed -- ask them about the
 * primary root alone and a file in an attached folder resolves to no repo at
 * all. Anything the roots do not contain stays with the primary root, which is
 * also where a relative path resolves.
 */
export function groupFilesByRoot(
  workspacePath: string,
  filePaths: string[],
): Map<string, string[]> {
  const roots = getWorkspaceRoots(workspacePath);
  const groups = new Map<string, string[]>();

  for (const filePath of filePaths) {
    // Deepest attached root wins; the primary root is the fallback, so it is
    // excluded from the match rather than competing on length.
    const owningRoot = roots
      .filter((root) => root !== workspacePath && isPathInWorkspace(filePath, root))
      .sort((a, b) => b.length - a.length)[0] ?? workspacePath;

    const existing = groups.get(owningRoot);
    if (existing) existing.push(filePath);
    else groups.set(owningRoot, [filePath]);
  }
  return groups;
}

/**
 * Group file paths by the repo that owns them, in root order. Files in no repo
 * land under the `null` key so callers can report them rather than silently
 * dropping them.
 */
export function groupFilesByRepo(
  workspacePath: string,
  filePaths: string[],
  extraRoots?: string[],
): Map<string | null, string[]> {
  const groups = new Map<string | null, string[]>();
  for (const filePath of filePaths) {
    const repo = resolveRepoForFile(workspacePath, filePath, extraRoots);
    const existing = groups.get(repo);
    if (existing) {
      existing.push(filePath);
    } else {
      groups.set(repo, [filePath]);
    }
  }
  return groups;
}
