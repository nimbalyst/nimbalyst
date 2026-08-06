/**
 * Path rollup helpers shared by adapters that emit file-derived "module" nodes.
 *
 * A naive graph emits one node per unique file path, which buries everything
 * else in a monorepo. Instead we roll files up to a *module* granularity that is
 * anchored on real package boundaries rather than an arbitrary directory depth:
 *
 *  - `packages/<name>/...` is a workspace package. Large packages split ONE
 *    level deeper (collapsing a leading `src/`) so e.g. the electron package
 *    becomes `electron/main`, `electron/renderer`, `electron/preload` instead of
 *    one giant node OR thousands of leaf nodes. Small packages stay as a single
 *    `packages/<name>` node.
 *  - Everything else collapses to its top two path segments (`design/Collaboration`,
 *    `docs`, `.claude/commands`).
 *
 * Crucially, paths are first made workspace-relative. Session file paths are
 * stored ABSOLUTE (and may live in a sibling git worktree), so without this step
 * every edited file collapsed into a single `Users/<you>/sources` mega-node.
 */

const FILENAME_RE = /\.[A-Za-z0-9]{1,8}$/;

/** Extensionless files that should not become their own "module" node. */
const EXTENSIONLESS_FILES = new Set([
  'dockerfile', 'makefile', 'license', 'readme', 'procfile', 'gemfile', 'rakefile',
]);

/**
 * Does this final path segment look like a file rather than a directory?
 * Catches normal extensions (`foo.ts`), dotfiles (`.gitignore`, `.npmrc` — a
 * dot-DIRECTORY like `.claude` is never the LAST segment of a file path), and a
 * few well-known extensionless files.
 */
function looksLikeFile(seg: string): boolean {
  if (FILENAME_RE.test(seg)) return true;
  if (seg.startsWith('.')) return true;
  return EXTENSIONLESS_FILES.has(seg.toLowerCase());
}

/** Directory segments of a path, with a trailing filename segment stripped. */
function dirSegments(relPath: string): string[] {
  const trimmed = relPath.replace(/^\/+|\/+$/g, '');
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length === 0) return [];
  const last = parts[parts.length - 1]!;
  return looksLikeFile(last) ? parts.slice(0, -1) : parts;
}

/**
 * Make a (possibly absolute, possibly worktree) path relative to the workspace
 * root. Returns:
 *  - a workspace-relative path (no leading slash) when the file is inside the
 *    workspace or one of its sibling git worktrees,
 *  - `''` for the workspace root itself,
 *  - `null` when the path is absolute and lives OUTSIDE the workspace (so the
 *    caller drops it instead of inventing a junk node like `Users/<you>`).
 */
export function relativizeToWorkspace(path: string, workspaceRoot: string): string | null {
  const root = workspaceRoot.replace(/\/+$/, '');
  if (path === root) return '';
  if (path.startsWith(root + '/')) return path.slice(root.length + 1);

  // Sibling git worktree: <parent>/<repo>_worktrees/<wt>/<rest> -> <rest>.
  const repo = root.split('/').filter(Boolean).pop() ?? '';
  if (repo) {
    const marker = `/${repo}_worktrees/`;
    const idx = path.indexOf(marker);
    if (idx !== -1) {
      const after = path.slice(idx + marker.length); // "<wt>/<rest>"
      const slash = after.indexOf('/');
      return slash === -1 ? '' : after.slice(slash + 1);
    }
  }

  if (!path.startsWith('/')) return path; // already relative
  return null; // absolute & outside the workspace
}

/**
 * Resolve a file path to its module node id, or `null` if the file is outside
 * the workspace and should be skipped.
 */
export function moduleForPath(path: string, workspaceRoot: string): string | null {
  const rel = relativizeToWorkspace(path, workspaceRoot);
  if (rel == null) return null;
  const segs = dirSegments(rel);
  if (segs.length === 0) return '(root)';

  if (segs[0] === 'packages' && segs.length >= 2) {
    const rest = segs.slice(2);
    // Collapse a ubiquitous leading `src` so the split lands on a meaningful
    // area (main/renderer/preload) rather than always on `src`.
    const area = rest[0] === 'src' ? rest[1] : rest[0];
    return area ? `packages/${segs[1]}/${area}` : `packages/${segs[1]}`;
  }

  // Non-package areas: keep up to two segments for a little structure.
  return segs.slice(0, 2).join('/');
}

export function dirNodeId(dir: string): string {
  return `dir:${dir}`;
}

/**
 * Parent module of a module id, or `null` if it's already top-level. A split
 * package area rolls up to its package (`packages/electron/main` ->
 * `packages/electron`); a package root and non-package modules are top-level.
 * Used to build a containment tree so a package's areas cluster together.
 */
export function moduleParentId(moduleId: string): string | null {
  const segs = moduleId.split('/').filter(Boolean);
  if (segs[0] === 'packages' && segs.length >= 3) {
    return `packages/${segs[1]}`;
  }
  return null;
}

export function dirLabel(dir: string): string {
  if (dir === '(root)') return '/';
  // Show the last two segments (dropping the noisy `packages` prefix) so a split
  // module reads as "electron/main", a package as "cli", an area as
  // "design/Collaboration".
  const parts = dir.split('/').filter(p => p && p !== 'packages');
  return parts.slice(-2).join('/');
}
