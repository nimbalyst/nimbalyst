import * as fs from 'fs';
import * as path from 'path';

function isStrictlyInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The folder that holds a repo's worktrees.
 *
 * Normally `<repo>_worktrees`, next to the repo. A repo inside a workspace root
 * that is itself a repo -- a clone the umbrella's `.gitignore` hides -- would
 * get that folder inside the umbrella, untracked and watched there. Its
 * worktrees go next to the outermost such root instead, `<root>_worktrees`, in
 * the same namespace as the root's own worktrees. Every `<project>_worktrees/`
 * convention (`resolveProjectPath`, `listSiblingWorktreePaths`, worktree
 * inference) then maps them back to the project the user opened.
 */
export function resolveWorktreesDir(sourceRepo: string, workspaceRoots: readonly string[]): string {
  const repo = path.resolve(sourceRepo);
  const enclosingRepoRoot = workspaceRoots
    .map((root) => path.resolve(root))
    .filter((root) => isStrictlyInside(repo, root) && fs.existsSync(path.join(root, '.git')))
    .sort((a, b) => a.length - b.length)[0];
  const base = enclosingRepoRoot ?? repo;
  return path.resolve(base, '..', `${path.basename(base)}_worktrees`);
}
