import * as os from 'os';
import * as nodePath from 'path';

type PathModule = Pick<typeof nodePath, 'resolve' | 'parse' | 'relative' | 'isAbsolute' | 'join'>;

/**
 * Directories that only contain other volumes, users, or OS files. Watching one
 * recursively would flood the native watcher. Matched exactly (case-insensitive),
 * so projects nested inside them (`/Volumes/Data/app`, `D:\Users\me\app`) are fine.
 */
const POSIX_CONTAINER_DIRS = [
  '/Volumes', '/mnt', '/media', '/home', '/Users', '/System', '/Library', '/Applications',
  '/private', '/usr', '/etc', '/var', '/tmp', '/opt', '/bin', '/sbin', '/dev', '/proc', '/sys',
];
const WINDOWS_CONTAINER_DIRS = ['Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Users'];

function isContainerDir(resolved: string, root: string, pathModule: PathModule): boolean {
  const lower = resolved.toLowerCase();
  if (root !== '/') {
    return WINDOWS_CONTAINER_DIRS.some((dir) => pathModule.join(root, dir).toLowerCase() === lower);
  }
  return POSIX_CONTAINER_DIRS.some((dir) => dir.toLowerCase() === lower);
}

function isSameOrAncestor(candidate: string, descendant: string, pathModule: PathModule): boolean {
  const rel = pathModule.relative(candidate, descendant);
  return rel === '' || (!rel.startsWith('..') && !pathModule.isAbsolute(rel));
}

/**
 * Validate that a workspace path is safe to watch recursively.
 * Returns an error message if unsafe, or null if safe.
 *
 * Rejects filesystem/drive roots, the home directory and its ancestors, and
 * OS container directories. A segment-count rule used to live here and rejected
 * ordinary Windows projects like `D:\XYZ` because the drive letter counted as depth.
 */
export function validateWorkspaceWatchPath(
  workspacePath: string,
  options: { pathModule?: PathModule; homeDir?: string } = {},
): string | null {
  const pathModule = options.pathModule ?? nodePath;
  const resolved = pathModule.resolve(workspacePath);
  const { root } = pathModule.parse(resolved);
  const homeDir = pathModule.resolve(options.homeDir ?? os.homedir());

  let reason: string | null = null;
  if (pathModule.relative(root, resolved) === '') {
    reason = 'it is a filesystem root';
  } else if (isSameOrAncestor(resolved, homeDir, pathModule)) {
    reason = 'it is your home directory or contains it';
  } else if (isContainerDir(resolved, root, pathModule)) {
    reason = 'it is a system or volume container directory';
  }
  if (!reason) return null;
  return `Workspace path "${workspacePath}" cannot be watched because ${reason}. ` +
    `Watching this path would monitor too much of the filesystem and freeze the process. Open a project folder instead.`;
}
