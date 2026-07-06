/**
 * Path utilities shared between main and renderer processes.
 * These functions work in both Node.js and browser environments.
 *
 * NOTE: Similar functions exist in main/utils/workspaceDetection.ts but use
 * Node.js path module with path.sep for platform-specific behavior.
 * This file uses forward slashes universally for cross-process compatibility
 * (renderer process doesn't have access to Node's path module with sep).
 *
 * Use this file for:
 * - Renderer process code
 * - Code that needs to work in both main and renderer
 *
 * Use workspaceDetection.ts for:
 * - Main process code that needs platform-native path handling
 * - File system operations that require path.sep
 */

/**
 * Normalize a path by removing trailing slashes and handling separators.
 * Works in both Node.js and browser environments.
 */
export function normalizePath(filePath: string): string {
  // Remove trailing slashes
  let normalized = filePath.replace(/[\\/]+$/, '');
  // Normalize multiple slashes to single
  normalized = normalized.replace(/[\\/]+/g, '/');
  return normalized;
}

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

  const normalizedFile = normalizePath(filePath);
  const normalizedWorkspace = normalizePath(workspacePath);

  // Must either be exactly the workspace path or start with workspace + separator
  return (
    normalizedFile === normalizedWorkspace ||
    normalizedFile.startsWith(normalizedWorkspace + '/')
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

  const normalizedFile = normalizePath(filePath);
  const normalizedWorkspace = normalizePath(workspacePath);

  if (normalizedFile === normalizedWorkspace) {
    return '';
  }

  // +1 for the path separator
  return normalizedFile.substring(normalizedWorkspace.length + 1);
}

/**
 * Check if a path is a worktree path.
 * Matches the pattern: {project}_worktrees/{...name}
 * The trailing name may be nested (branch-style names like `feature/foo`).
 *
 * Mirrors workspaceDetection.ts isWorktreePath() but uses forward slashes.
 */
export function isWorktreePath(workspacePath: string): boolean {
  if (!workspacePath) {
    return false;
  }
  const normalized = normalizePath(workspacePath);
  return /_worktrees\/.+$/.test(normalized);
}

/**
 * Resolve a workspace path to its parent project path.
 * If the path is a worktree (matches {project}_worktrees/<name> pattern, where
 * <name> may be nested for branch-style names like `feature/foo`), returns the
 * parent project path. Otherwise returns the original path.
 *
 * Mirrors workspaceDetection.ts resolveProjectPath() but uses forward slashes.
 */
export function resolveProjectPath(workspacePath: string): string {
  if (!workspacePath) {
    return workspacePath;
  }
  const normalized = normalizePath(workspacePath);
  const match = normalized.match(/^(.+)_worktrees\/.+$/);
  return match ? match[1] : workspacePath;
}
