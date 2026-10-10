import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Resolve a link target to an existing file inside the workspace.
 *
 * The scan index behind `getDocumentByPath` is capped, so in large workspaces
 * real files (e.g. the root package.json) are missing from it. A link to such a
 * file must still open, so callers fall back to the filesystem. Returns the
 * absolute path, or null when the target is outside the workspace or is not a
 * regular file.
 */
export async function resolveWorkspaceFileForOpen(
  workspacePath: string,
  target: string,
): Promise<string | null> {
  const absolute = path.resolve(workspacePath, target);
  const relative = path.relative(workspacePath, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  try {
    const stats = await fs.stat(absolute);
    return stats.isFile() ? absolute : null;
  } catch {
    return null;
  }
}
