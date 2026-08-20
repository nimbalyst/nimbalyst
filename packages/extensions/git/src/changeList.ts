import { buildFileDirectoryTree, type FileDirectoryNode } from '@nimbalyst/extension-sdk/file-tree';

export interface WorkingFile {
  /** Repository-relative path. */
  path: string;
  /** Single-letter git status: M, A, D, ? (untracked) or C (conflicted). */
  status: string;
  /**
   * `path` joined against the repository root. That is NOT the workspace when
   * the workspace is opened at a subfolder of the repo (#124), so anything
   * resolving a real file on disk must use this rather than `path`.
   */
  absolutePath?: string;
}

export interface WorkingChangesResult {
  staged: Array<{ path: string; status: string; absolutePath?: string }>;
  unstaged: Array<{ path: string; status: string; absolutePath?: string }>;
  untracked: Array<{ path: string; absolutePath?: string }>;
  conflicted: Array<{ path: string; absolutePath?: string }>;
}

/**
 * The Changes tab shows one row per path, so a file that appears in more than one
 * of git's groups (staged plus further worktree edits, most commonly) needs a single
 * status. Most combinations follow the rank below. A staged deletion followed
 * by an untracked recreation is the exception: the path exists in the worktree,
 * so relative to HEAD it is modified rather than deleted.
 */
const STATUS_RANK: Record<string, number> = { D: 3, A: 2, M: 1, '?': 0 };

function mergeStatus(a: string, b: string): string {
  if ((a === 'D' && b === '?') || (a === '?' && b === 'D')) return 'M';
  const rankA = STATUS_RANK[a] ?? 0;
  const rankB = STATUS_RANK[b] ?? 0;
  return rankB > rankA ? b : a;
}

/**
 * Collapse git's staged / unstaged / untracked groups into the one flat list the
 * tab renders. Selection — not the index — decides what gets committed, so the
 * split is not user-visible; `git:commit` stages the selected paths into a
 * temporary index at commit time.
 */
export function mergeWorkingChanges(result: WorkingChangesResult): WorkingFile[] {
  const statusByPath = new Map<string, string>();
  const absolutePathByPath = new Map<string, string>();
  // Conflicts are listed separately and are never selectable, so they must not
  // leak into the selectable list even if git also reports them as modified.
  const conflictedPaths = new Set(result.conflicted.map(f => f.path));

  const add = (path: string, status: string, absolutePath?: string) => {
    if (conflictedPaths.has(path)) return;
    const existing = statusByPath.get(path);
    statusByPath.set(path, existing === undefined ? status : mergeStatus(existing, status));
    if (absolutePath && !absolutePathByPath.has(path)) {
      absolutePathByPath.set(path, absolutePath);
    }
  };

  result.staged.forEach(f => add(f.path, f.status, f.absolutePath));
  result.unstaged.forEach(f => add(f.path, f.status, f.absolutePath));
  result.untracked.forEach(f => add(f.path, '?', f.absolutePath));

  return Array.from(statusByPath, ([path, status]) => ({
    path,
    status,
    absolutePath: absolutePathByPath.get(path),
  }));
}

export type ChangeRow =
  | {
      kind: 'dir';
      /** Full repository-relative directory path; stable key for collapse state. */
      path: string;
      /** Display label, e.g. `packages/extensions/git/src/`. */
      label: string;
      depth: number;
      fileCount: number;
      /** Every file path beneath this directory, for the tri-state checkbox. */
      filePaths: string[];
      collapsed: boolean;
    }
  | {
      kind: 'file';
      path: string;
      status: string;
      depth: number;
      /** Non-empty when a single-file directory was folded into this row. */
      dirPrefix: string;
    };

function collectFilePaths(node: FileDirectoryNode<WorkingFile>): string[] {
  const paths = node.files.map(f => f.path);
  node.subdirectories.forEach(sub => paths.push(...collectFilePaths(sub)));
  return paths;
}

/**
 * Flatten the directory tree into the exact rows the tab renders, in render order.
 * Files inside a collapsed directory are omitted, so keyboard navigation can be
 * derived from this list without ever focusing an invisible row.
 */
export function buildChangeRows(files: WorkingFile[], collapsedDirs: Set<string>): ChangeRow[] {
  const tree = buildFileDirectoryTree(files, f => f.path);
  const rows: ChangeRow[] = [];

  const emit = (node: FileDirectoryNode<WorkingFile>, depth: number) => {
    let childDepth = depth;

    if (node.displayPath) {
      // A directory holding exactly one file and no subdirectories folds into a
      // single `dir/file` row -- the largest vertical win in a deep monorepo.
      if (node.subdirectories.size === 0 && node.files.length === 1) {
        const file = node.files[0];
        rows.push({
          kind: 'file',
          path: file.path,
          status: file.status,
          depth,
          dirPrefix: `${node.displayPath}/`,
        });
        return;
      }

      const collapsed = collapsedDirs.has(node.path);
      rows.push({
        kind: 'dir',
        path: node.path,
        label: `${node.displayPath}/`,
        depth,
        fileCount: node.fileCount,
        filePaths: collectFilePaths(node),
        collapsed,
      });
      if (collapsed) return;
      childDepth = depth + 1;
    }

    Array.from(node.subdirectories.values())
      .sort((a, b) => a.displayPath.localeCompare(b.displayPath))
      .forEach(sub => emit(sub, childDepth));

    [...node.files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .forEach(file => {
        rows.push({ kind: 'file', path: file.path, status: file.status, depth: childDepth, dirPrefix: '' });
      });
  };

  emit(tree, 0);
  return rows;
}

/** File paths in render order, skipping anything inside a collapsed directory. */
export function visibleFilePaths(rows: ChangeRow[]): string[] {
  return rows.filter(row => row.kind === 'file').map(row => row.path);
}
