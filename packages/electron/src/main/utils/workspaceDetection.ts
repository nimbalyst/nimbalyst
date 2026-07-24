import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { getRecentItems } from './store';

/**
 * NOTE: isPathInWorkspace and getRelativeWorkspacePath have similar implementations
 * in shared/pathUtils.ts. The duplication exists because:
 *
 * - This file (workspaceDetection.ts): Uses Node.js path.normalize() and path.sep
 *   for platform-native path handling in the main process.
 *
 * - shared/pathUtils.ts: Uses forward slashes universally for cross-process
 *   compatibility (renderer process doesn't have path.sep).
 *
 * Both implementations have the same logic but different path normalization.
 * Use workspaceDetection.ts for main process, shared/pathUtils.ts for renderer.
 */

/**
 * Check if a file path is inside a workspace directory.
 * This properly handles path boundaries to avoid false positives like
 * '/foo/bar_worktrees/...' being considered inside '/foo/bar'.
 *
 * @param filePath - The file path to check
 * @param workspacePath - The workspace path to check against
 * @returns true if the file is inside the workspace
 */
export function isPathInWorkspace(filePath: string, workspacePath: string): boolean {
  if (!filePath || !workspacePath) {
    return false;
  }

  const normalizedFile = path.normalize(filePath);
  const normalizedWorkspace = path.normalize(workspacePath);

  // Must either be exactly the workspace path or start with workspace + separator
  return (
    normalizedFile === normalizedWorkspace ||
    normalizedFile.startsWith(normalizedWorkspace + path.sep)
  );
}

/**
 * Get the relative path of a file within a workspace.
 * Returns null if the file is not inside the workspace.
 *
 * @param filePath - The absolute file path
 * @param workspacePath - The workspace path
 * @returns The relative path, or null if the file is not in the workspace
 */
export function getRelativeWorkspacePath(filePath: string, workspacePath: string): string | null {
  if (!isPathInWorkspace(filePath, workspacePath)) {
    return null;
  }

  const normalizedFile = path.normalize(filePath);
  const normalizedWorkspace = path.normalize(workspacePath);

  if (normalizedFile === normalizedWorkspace) {
    return '';
  }

  // +1 for the path separator
  return normalizedFile.substring(normalizedWorkspace.length + 1);
}

/**
 * A path's git-worktree identity: whether it is a linked worktree, and if so,
 * the canonical (symlink-resolved) path of its parent (main) repository.
 */
interface WorktreeIdentity {
  isWorktree: boolean;
  parentRoot: string | null;
  canonical: string;
}

const WORKTREE_IDENTITY_CACHE = new Map<string, { value: WorktreeIdentity; expiresAt: number }>();
const WORKTREE_IDENTITY_CACHE_TTL_MS = 30_000;

/**
 * Clear the worktree-identity cache. Exposed for tests and for callers that
 * know a workspace's git structure just changed (e.g. a worktree was created
 * or removed) and want a fresh resolution on the next call.
 */
export function clearWorktreeIdentityCache(): void {
  WORKTREE_IDENTITY_CACHE.clear();
}

function cacheWorktreeIdentity(key: string, value: WorktreeIdentity): WorktreeIdentity {
  WORKTREE_IDENTITY_CACHE.set(key, { value, expiresAt: Date.now() + WORKTREE_IDENTITY_CACHE_TTL_MS });
  return value;
}

/**
 * Resolve a path's real git-worktree identity by reading actual git metadata
 * on disk, instead of lexically matching a `_worktrees` naming convention.
 *
 * A linked worktree's `.git` is a FILE (not a directory) containing a single
 * `gitdir: <path>` line pointing at `<main-repo>/.git/worktrees/<name>` --
 * this has been git's stable on-disk format for linked worktrees since the
 * feature was introduced (git 2.5). We read that structure directly (no git
 * subprocess) and verify it two ways before trusting it:
 *
 * 1. The gitdir path must resolve to a real `.git/worktrees/<name>` directory
 *    (NOT `.git/modules/<name>`, which is a submodule -- submodules are a
 *    distinct trust boundary, not a worktree relationship, so they must
 *    never inherit the parent's trust/tool-approval settings).
 * 2. SECURITY (bidirectional verification): that worktree-registration
 *    directory's own `gitdir` back-pointer file must point back at this
 *    exact path's `.git` file. Without this check, a directory with a
 *    forged `.git` file could name ANY other project's worktree-registration
 *    path and silently inherit that project's trust -- this check makes
 *    that require write access to the target project's own `.git/worktrees/`
 *    directory, which an attacker who could already do would not need this
 *    to begin with.
 *
 * Fails CLOSED on any error (unreadable path, missing/malformed `.git`,
 * mismatched back-pointer, submodule, or anything else unexpected): the path
 * is treated as its own, non-worktree, standalone project. This is a
 * deliberate inversion of the old lexical matcher, which failed OPEN (any
 * path containing `_worktrees/<segment>` was trusted as a worktree even if
 * nothing on disk backed that up). The worst case of failing closed is one
 * extra trust prompt for a legitimate worktree Node could not introspect;
 * the worst case of failing open is silently granting one project's tool
 * approvals to an unrelated directory.
 */
function resolveWorktreeIdentity(workspacePath: string): WorktreeIdentity {
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(workspacePath);
  } catch {
    // Cannot even resolve the path (does not exist, unreadable, etc).
    // Fail closed: treat as its own project, not a worktree.
    return { isWorktree: false, parentRoot: null, canonical: workspacePath };
  }

  const cached = WORKTREE_IDENTITY_CACHE.get(canonical);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const notAWorktree: WorktreeIdentity = { isWorktree: false, parentRoot: null, canonical };

  try {
    const dotGitPath = path.join(canonical, '.git');
    const dotGitStat = fs.lstatSync(dotGitPath);

    if (dotGitStat.isDirectory()) {
      // Main repository root (or an unrelated directory with its own
      // unrelated `.git` dir) -- not a linked worktree.
      return cacheWorktreeIdentity(canonical, notAWorktree);
    }

    if (!dotGitStat.isFile()) {
      return cacheWorktreeIdentity(canonical, notAWorktree);
    }

    const dotGitContent = fs.readFileSync(dotGitPath, 'utf8');
    const gitdirMatch = /^gitdir:\s*(.+?)\s*$/m.exec(dotGitContent);
    if (!gitdirMatch) {
      return cacheWorktreeIdentity(canonical, notAWorktree);
    }

    const gitdirRaw = gitdirMatch[1];
    const gitdirAbs = path.isAbsolute(gitdirRaw) ? gitdirRaw : path.resolve(canonical, gitdirRaw);
    const gitdirReal = fs.realpathSync.native(gitdirAbs);

    // Must be exactly <parent>/.git/worktrees/<name> -- rejects submodules
    // (.git/modules/<name>) and anything else non-standard.
    const worktreesMatch = /^(.+)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(gitdirReal);
    if (!worktreesMatch) {
      return cacheWorktreeIdentity(canonical, notAWorktree);
    }

    // Bidirectional verification: the worktree-registration dir's own
    // gitdir back-pointer must point back at this exact worktree's .git file.
    const backPointerPath = path.join(gitdirReal, 'gitdir');
    const backPointerRaw = fs.readFileSync(backPointerPath, 'utf8').trim();
    const backPointerAbs = path.isAbsolute(backPointerRaw)
      ? backPointerRaw
      : path.resolve(gitdirReal, backPointerRaw);
    const backPointerReal = fs.realpathSync.native(backPointerAbs);
    const backPointerDirReal = fs.realpathSync.native(path.dirname(backPointerReal));
    if (backPointerDirReal !== canonical) {
      // Forged or stale registration -- do not trust it.
      return cacheWorktreeIdentity(canonical, notAWorktree);
    }

    const parentRoot = fs.realpathSync.native(worktreesMatch[1]);
    return cacheWorktreeIdentity(canonical, { isWorktree: true, parentRoot, canonical });
  } catch {
    // Any unexpected filesystem error -- fail closed.
    return cacheWorktreeIdentity(canonical, notAWorktree);
  }
}

/**
 * Resolve a workspace path to its parent project path.
 * If the path is a linked git worktree (verified via real git metadata on
 * disk, not a naming convention), returns the parent (main) repository's
 * canonical path. Otherwise returns the original path unchanged.
 *
 * This is used by the permission system to ensure worktrees inherit
 * trust status and tool patterns from their parent project.
 *
 * @param workspacePath - The workspace path to resolve
 * @returns The parent project path, or the original path if not a worktree
 */
export function resolveProjectPath(workspacePath: string): string {
  if (!workspacePath) {
    return workspacePath;
  }

  const identity = resolveWorktreeIdentity(workspacePath);
  if (identity.isWorktree && identity.parentRoot) {
    return identity.parentRoot;
  }
  return normalizeWorkspacePath(workspacePath);
}

/**
 * Check if a path is a linked git worktree, verified via real git metadata
 * on disk (not a `_worktrees` naming convention).
 *
 * @param workspacePath - The path to check
 * @returns true if the path is a linked git worktree
 */
export function isWorktreePath(workspacePath: string): boolean {
  if (!workspacePath) {
    return false;
  }

  return resolveWorktreeIdentity(workspacePath).isWorktree;
}

/**
 * Walk up the directory tree from `startPath` (inclusive) and return the first
 * ancestor for which `predicate` is true, or null if none match.
 *
 * If `stopAt` is provided, the walk is bounded above by that directory
 * (inclusive): `stopAt` is still tested, but the walk never climbs past it.
 * Otherwise the walk is bounded only by the filesystem root.
 *
 * Used by the permission layer so a subfolder inherits the agent permissions of
 * the nearest ancestor directory that has them explicitly set (the project the
 * user trusted), while `stopAt` keeps that inheritance from crossing a project
 * boundary. Pure and synchronous — the caller supplies the lookup.
 */
export function findNearestAncestor(
  startPath: string,
  predicate: (dir: string) => boolean,
  stopAt?: string,
): string | null {
  if (!startPath) {
    return null;
  }

  let current = normalizeWorkspacePath(startPath);
  const root = path.parse(current).root;
  const boundary = stopAt ? normalizeWorkspacePath(stopAt) : null;

  // Bounded by `stopAt` (if given) and the filesystem root; dirname() converges.
  while (true) {
    if (predicate(current)) {
      return current;
    }
    // Reached the inclusive upper boundary without a match - do not climb past it.
    if (boundary && current === boundary) {
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current || current === root) {
      return null;
    }
    current = parent;
  }
}

/**
 * Walk up from `startPath` (inclusive) to the nearest directory that is a git
 * repository root (contains a `.git` directory or file), or null if none is
 * found up to the filesystem root.
 *
 * The permission cascade uses this as the upper bound of its trust walk: a real
 * project is a git repo, so bounding the walk here means a subfolder inherits
 * its OWN project's trust, but a distinct project (its own `.git`) nested under
 * a trusted parent directory does not silently inherit that parent's trust.
 */
export function findProjectRoot(startPath: string): string | null {
  return findNearestAncestor(startPath, (dir) => {
    try {
      return fs.existsSync(path.join(dir, '.git'));
    } catch {
      return false;
    }
  });
}

/**
 * Normalize workspace paths for matching while preserving filesystem roots.
 * Example: "C:\\" must stay "C:\\" (not "C:").
 */
function normalizeWorkspacePath(workspacePath: string): string {
  const normalizedPath = path.normalize(workspacePath);

  // Preserve Windows roots (drive and UNC) even when running on non-Windows hosts.
  const windowsRoot = path.win32.parse(normalizedPath).root;
  if (
    windowsRoot &&
    normalizedPath.replace(/[\\/]/g, '/') === windowsRoot.replace(/[\\/]/g, '/')
  ) {
    return windowsRoot;
  }

  // Preserve POSIX root.
  const posixRoot = path.posix.parse(normalizedPath).root;
  if (normalizedPath === posixRoot) {
    return posixRoot;
  }

  return normalizedPath.replace(/[\\/]+$/, '');
}

/**
 * Check if a file is within a workspace, including worktree relationships.
 * This handles three cases:
 * 1. Direct match - file is inside the workspace path
 * 2. Worktree parent - if workspace is a worktree, checks if file is in the parent project
 * 3. Worktree child - if file is in a worktree of the workspace
 *
 * @param filePath - The file path to check
 * @param workspacePath - The workspace path to check against
 * @returns true if the file is within the workspace or a related worktree
 */
export function isFileInWorkspaceOrWorktree(filePath: string, workspacePath: string): boolean {
  if (!filePath || !workspacePath) {
    return false;
  }

  // Direct match - use path.sep for cross-platform compatibility
  if (filePath.startsWith(workspacePath + path.sep) || filePath === workspacePath) {
    return true;
  }

  // If workspace is a worktree, check if file is in the parent project
  if (isWorktreePath(workspacePath)) {
    const projectPath = resolveProjectPath(workspacePath);
    if (filePath.startsWith(projectPath + path.sep) || filePath === projectPath) {
      return true;
    }
  }

  // If file path looks like it's in a worktree of this workspace
  // e.g., workspace is /foo/bar, file is /foo/bar_worktrees/branch/file.txt
  // Use escaped path.sep in regex for cross-platform compatibility
  const escapedSep = path.sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const worktreePattern = new RegExp(`^${workspacePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_worktrees${escapedSep}`);
  if (worktreePattern.test(filePath)) {
    return true;
  }

  return false;
}

/**
 * Detects which known workspace (if any) contains the given file path.
 * Checks recent workspaces and returns the workspace path if the file
 * is located within any known workspace directory.
 *
 * @param filePath - Absolute path to the file
 * @returns The workspace path if found, null otherwise
 */
export function detectFileWorkspace(filePath: string): string | null {
  if (!filePath || !path.isAbsolute(filePath)) {
    return null;
  }

  const recentWorkspaces = getRecentItems('workspaces');

  // Normalize the file path for comparison
  const normalizedFilePath = path.normalize(filePath);

  for (const workspace of recentWorkspaces) {
    const normalizedWorkspacePath = path.normalize(workspace.path);

    // Check if file is inside this workspace
    // Use path.sep to ensure we match complete directory names
    if (
      normalizedFilePath.startsWith(normalizedWorkspacePath + path.sep) ||
      normalizedFilePath === normalizedWorkspacePath
    ) {
      return workspace.path;
    }
  }

  return null;
}

/**
 * Finds the closest parent directory that could be a workspace root.
 * Looks for common project indicators like .git, package.json, etc.
 *
 * @param filePath - Absolute path to the file
 * @returns Suggested workspace path or the file's directory
 */
export function suggestWorkspaceForFile(filePath: string): string {
  const fs = require('fs');

  let currentDir = path.dirname(filePath);
  const root = path.parse(currentDir).root;

  // Walk up the directory tree looking for project indicators
  while (currentDir !== root) {
    // Check for common project root indicators
    const indicators = ['.git', 'package.json', '.vscode', '.idea', 'Cargo.toml', 'go.mod'];

    for (const indicator of indicators) {
      const indicatorPath = path.join(currentDir, indicator);
      try {
        if (fs.existsSync(indicatorPath)) {
          return currentDir;
        }
      } catch (err) {
        // Ignore errors checking for indicators
      }
    }

    // Move up one directory
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break; // Reached root
    }
    currentDir = parentDir;
  }

  // If no project root found, use the file's directory
  return path.dirname(filePath);
}

/**
 * Checks if a workspace directory is a Nimbalyst extension project.
 * An extension project is identified by having a manifest.json with an 'id' field
 * that looks like an extension ID (contains a dot, e.g., 'com.example.my-extension').
 *
 * @param workspacePath - Absolute path to the workspace directory
 * @returns true if the workspace appears to be an extension project
 */
export function isExtensionProject(workspacePath: string): boolean {
  if (!workspacePath) {
    return false;
  }

  const manifestPath = path.join(workspacePath, 'manifest.json');

  try {
    if (!fs.existsSync(manifestPath)) {
      return false;
    }

    const manifestContent = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestContent);

    // Check for extension-like manifest structure:
    // - Has an 'id' field with a dot (like 'com.example.extension')
    // - Has a 'name' field
    // - Has 'contributions' or 'main' field (extension entry point indicators)
    if (
      manifest.id &&
      typeof manifest.id === 'string' &&
      manifest.id.includes('.') &&
      manifest.name &&
      (manifest.contributions || manifest.main)
    ) {
      return true;
    }
  } catch (error) {
    // Invalid JSON or read error - not an extension project
  }

  return false;
}

/**
 * Gets the path to the Extension SDK documentation.
 * In development, this is the source folder. In production, it's bundled in resources.
 *
 * @returns The path to the SDK docs, or null if not found
 */
export function getExtensionSDKDocsPath(): string | null {
  // In development: use the source folder
  // __dirname is packages/electron/out/main when running from built code
  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    // Go up to packages/electron, then to packages/extension-sdk-docs
    const devPath = path.join(__dirname, '..', '..', '..', 'extension-sdk-docs');
    if (fs.existsSync(devPath)) {
      return devPath;
    }
  }

  // In production: use bundled resources
  const resourcesPath = path.join(process.resourcesPath, 'extension-sdk-docs');
  if (fs.existsSync(resourcesPath)) {
    return resourcesPath;
  }

  return null;
}

/**
 * Gets additional directories that should be accessible to the agent for the
 * given workspace. This includes:
 * - Extension SDK documentation when working on an extension project
 * - Parent project directory when working in a worktree
 * - Sibling worktrees (unless opted out — see includeSiblingWorktrees)
 *
 * @param workspacePath - The current workspace path
 * @param options.includeSiblingWorktrees - default true. The Claude Code
 *   loader passes false: the Claude CLI discovers `.claude/commands` skills in
 *   every additional directory, so with N sibling worktrees every project
 *   skill appears N+1 times in the system prompt (~7K tokens of duplicates per
 *   session in a many-worktree repo). Codex keeps true — its workspace-write
 *   sandbox blocks sibling-worktree edits without `--add-dir`, and it loads no
 *   skills from those directories.
 * @returns Array of additional directory paths the agent should have access to
 */
export function getAdditionalDirectoriesForWorkspace(
  workspacePath: string,
  options?: { includeSiblingWorktrees?: boolean },
): string[] {
  const additionalDirs = new Set<string>();
  const workspaceIdentity = resolveWorktreeIdentity(workspacePath);
  const projectPath = resolveProjectPath(workspacePath);

  // If this is a worktree, add the parent project directory so the agent can
  // read shared configs (.claude/settings.json, package.json) and reach the
  // shared .git common dir for operations like `git rebase --continue`.
  if (workspaceIdentity.isWorktree) {
    additionalDirs.add(projectPath);
  }

  // Include every sibling worktree for this project. Without this, an
  // orchestrator session running in the parent project (or in one worktree)
  // hits Codex's workspace-write sandbox the moment it tries to coordinate
  // edits in a sibling worktree, and `--add-dir` is never set on the spawned
  // CLI invocation. Listing the filesystem keeps this sync and self-contained
  // (no DB query) and matches the existing worktree directory convention used
  // by GitWorktreeService.
  if (options?.includeSiblingWorktrees !== false) {
    const siblingWorktrees = listSiblingWorktreePaths(projectPath);
    for (const siblingPath of siblingWorktrees) {
      if (siblingPath !== workspaceIdentity.canonical) {
        additionalDirs.add(siblingPath);
      }
    }
  }

  if (isExtensionProject(projectPath)) {
    const sdkDocsPath = getExtensionSDKDocsPath();
    if (sdkDocsPath) {
      additionalDirs.add(sdkDocsPath);
    }
  }

  return Array.from(additionalDirs);
}

/**
 * List full filesystem paths of every sibling worktree directory for a
 * project, following Nimbalyst's `<project>_worktrees/<name>` convention.
 * Returns an empty list if the worktrees directory does not exist or cannot
 * be read. Sync so it can be used from the synchronous additionalDirectories
 * loader contract.
 */
function listSiblingWorktreePaths(projectPath: string): string[] {
  if (!projectPath) {
    return [];
  }
  const projectName = path.basename(projectPath);
  const worktreesDir = path.resolve(projectPath, '..', `${projectName}_worktrees`);
  if (!fs.existsSync(worktreesDir)) {
    return [];
  }
  try {
    const entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(worktreesDir, entry.name));
  } catch {
    return [];
  }
}
