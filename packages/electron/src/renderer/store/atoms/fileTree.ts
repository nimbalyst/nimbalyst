/**
 * File Tree Atoms
 *
 * State for the file tree sidebar, including git status, expanded directories,
 * and selection. Uses file paths as keys (not EditorKey) because git status
 * and file existence are properties of the file on disk, not per-editor.
 *
 * Key principle: File watcher service WRITES git status/structure changes,
 * FileTreeNode components subscribe to only their own path's state.
 */

import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { store } from '@nimbalyst/runtime/store';
import { isNonFilesystemTab } from '../../contexts/TabsContext';

/**
 * Git status codes matching what `simple-git` provides.
 */
export type GitStatusCode =
  | 'M' // Modified
  | 'A' // Added
  | 'D' // Deleted
  | 'R' // Renamed
  | 'C' // Copied
  | 'U' // Unmerged/Conflicted
  | '?' // Untracked
  | '!'; // Ignored

/**
 * Git status for a file.
 */
export interface FileGitStatus {
  index: GitStatusCode | ' '; // Staging area status
  workingTree: GitStatusCode | ' '; // Working tree status
}

/**
 * File tree item representing a file or directory.
 */
export interface FileTreeItem {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileTreeItem[];
}

/**
 * The complete file tree structure.
 * WorkspaceSidebar subscribes to this for the tree structure.
 */
export const fileTreeAtom = atom<FileTreeItem[]>([]);

/**
 * Git status map for all tracked files.
 * This is the source of truth - per-file atoms derive from this.
 */
export const gitStatusMapAtom = atom<Map<string, FileGitStatus>>(new Map());

/**
 * Per-file git status.
 * FileTreeNode subscribes to get its own status.
 * Derives from gitStatusMapAtom so updates are efficient.
 */
export const fileGitStatusAtom = atomFamily((filePath: string) =>
  atom((get) => {
    const statusMap = get(gitStatusMapAtom);
    return statusMap.get(filePath);
  })
);

/**
 * Expanded directories set.
 * Source of truth for which directories are expanded in the tree.
 * FileTree subscribes to this directly -- no local state duplication.
 */
export const expandedDirsAtom = atom<Set<string>>(new Set<string>());

/**
 * Per-directory expanded state.
 * FileTreeNode subscribes to know if it should show children.
 */
export const isDirExpandedAtom = atomFamily((dirPath: string) =>
  atom(
    (get) => get(expandedDirsAtom).has(dirPath),
    (get, set, expanded: boolean) => {
      const current = get(expandedDirsAtom);
      const next = new Set(current);
      if (expanded) {
        next.add(dirPath);
      } else {
        next.delete(dirPath);
      }
      set(expandedDirsAtom, next);
    }
  )
);

/**
 * Currently selected folder path in the tree.
 * Used for folder navigation (e.g., clicking breadcrumb folders) and
 * for visual highlighting of the selected folder.
 */
export const selectedFolderPathAtom = atom<string | null>(null);

/**
 * Reveal request atom -- unified mechanism for scrolling the file tree
 * to a specific file or folder. Used by breadcrumb clicks, quick-open, etc.
 *
 * The timestamp ensures repeated reveals of the same path each trigger a scroll.
 * The revealFileAtom / revealFolderAtom actions expand parent dirs and set this.
 */
export interface RevealRequest {
  path: string;
  type: 'file' | 'folder';
  ts: number;
}
export const revealRequestAtom = atom<RevealRequest | null>(null);

/**
 * The file the main editor's active tab shows; null when no tab is open or the
 * tab is not a file on disk (a tracker item, a shared document, a virtual
 * page). The repo-aware UI -- the title-bar branch, the Git operations panel,
 * the repo a new worktree branches from -- follows it via
 * `activeFileRepoPathAtom`.
 *
 * The main editor's tabs live in TabsContext, not Jotai, so EditorMode keeps
 * this in step with `bindActiveFileToTabs`. It keeps its value while EditorMode
 * is unmounted, so agent mode still knows the file the user was last in.
 */
export const activeFilePathAtom = atom<string | null>(null);

interface ActiveTabSource {
  subscribe: (callback: () => void) => () => void;
  getSnapshot: () => { activeTabId: string | null; tabs: Map<string, { filePath: string }> };
}

/** Mirror the main editor's active tab into `activeFilePathAtom`; returns the unsubscribe. */
export function bindActiveFileToTabs(tabs: ActiveTabSource, target = store): () => void {
  const update = () => {
    const { activeTabId, tabs: open } = tabs.getSnapshot();
    const filePath = activeTabId ? open.get(activeTabId)?.filePath : undefined;
    const next = filePath && !isNonFilesystemTab(filePath) ? filePath : null;
    if (target.get(activeFilePathAtom) !== next) target.set(activeFilePathAtom, next);
  };
  update();
  return tabs.subscribe(update);
}

/**
 * Active filter for file tree (e.g., "modified", "untracked").
 */
export const fileTreeFilterAtom = atom<string | null>(null);

/**
 * Compute aggregate git status for a directory.
 * Shows the "most important" status of any child.
 */
function computeDirectoryStatus(
  dirPath: string,
  statusMap: Map<string, FileGitStatus>
): FileGitStatus | undefined {
  // Priority order: Unmerged > Modified > Added > Untracked > Deleted > none
  const priority: Record<GitStatusCode | ' ', number> = {
    U: 6,
    M: 5,
    A: 4,
    '?': 3,
    D: 2,
    R: 1,
    C: 1,
    '!': 0,
    ' ': 0,
  };

  let highestIndex: GitStatusCode | ' ' = ' ';
  let highestWorking: GitStatusCode | ' ' = ' ';
  let hasAny = false;

  for (const [path, status] of statusMap) {
    if (path.startsWith(dirPath + '/')) {
      hasAny = true;
      if (priority[status.index] > priority[highestIndex]) {
        highestIndex = status.index;
      }
      if (priority[status.workingTree] > priority[highestWorking]) {
        highestWorking = status.workingTree;
      }
    }
  }

  if (!hasAny) return undefined;

  return {
    index: highestIndex,
    workingTree: highestWorking,
  };
}

/**
 * Per-directory aggregate git status.
 * Shows the "most important" status among all files in the directory.
 */
export const directoryGitStatusAtom = atomFamily((dirPath: string) =>
  atom((get) => {
    const statusMap = get(gitStatusMapAtom);
    return computeDirectoryStatus(dirPath, statusMap);
  })
);

/**
 * Derived: count of modified files (for badge/indicator).
 */
export const modifiedFileCountAtom = atom((get) => {
  const statusMap = get(gitStatusMapAtom);
  let count = 0;
  for (const status of statusMap.values()) {
    if (
      status.workingTree === 'M' ||
      status.workingTree === 'A' ||
      status.workingTree === '?'
    ) {
      count++;
    }
  }
  return count;
});

/**
 * Actions for managing file tree state.
 */

/**
 * Update git status for multiple files at once.
 * More efficient than updating one at a time.
 */
export const updateGitStatusAtom = atom(
  null,
  (_get, set, updates: Map<string, FileGitStatus>) => {
    set(gitStatusMapAtom, updates);
  }
);

/**
 * Toggle directory expansion.
 */
export const toggleDirExpandedAtom = atom(null, (get, set, dirPath: string) => {
  const current = get(expandedDirsAtom).has(dirPath);
  set(isDirExpandedAtom(dirPath), !current);
});

/**
 * Helper: compute parent directory paths from a file/folder path.
 * e.g., "/a/b/c/file.txt" -> ["/a", "/a/b", "/a/b/c"]
 */
function getParentDirPaths(targetPath: string): string[] {
  const parts = targetPath.split('/');
  const dirs: string[] = [];
  // Build all parent directories (skip last part which is the file/folder itself)
  for (let i = 1; i < parts.length - 1; i++) {
    dirs.push(parts.slice(0, i + 1).join('/'));
  }
  return dirs;
}

/**
 * Collect all directory paths from a tree structure.
 */
function collectTreeDirPaths(treeItems: RendererFileTreeItem[]): Set<string> {
  const paths = new Set<string>();
  function walk(items: RendererFileTreeItem[]) {
    for (const item of items) {
      if (item.type === 'directory') {
        paths.add(item.path);
        if (item.children) walk(item.children);
      }
    }
  }
  walk(treeItems);
  return paths;
}

/**
 * Expand parent directories for a given path and set a reveal request.
 * Used by revealFileAtom and revealFolderAtom.
 *
 * Only expands directories that actually exist in the file tree to prevent
 * adding arbitrary filesystem paths (e.g. /var, /tmp) to expandedDirsAtom.
 */
function expandAndReveal(
  get: (atom: any) => any,
  set: (atom: any, value: any) => void,
  targetPath: string,
  type: 'file' | 'folder'
) {
  // Get dirs that actually exist in the tree
  const treeDirs = collectTreeDirPaths(get(fileTreeItemsAtom) as RendererFileTreeItem[]);

  // Only expand parent directories that exist in the tree
  const dirs = getParentDirPaths(targetPath).filter(d => treeDirs.has(d));
  const current = get(expandedDirsAtom) as Set<string>;
  const dirsToExpand = dirs.filter(d => !current.has(d));

  if (dirsToExpand.length > 0) {
    const next = new Set(current);
    for (const dir of dirsToExpand) {
      next.add(dir);
    }
    set(expandedDirsAtom, next);
  }

  // Set reveal request (timestamp ensures repeated reveals trigger scroll)
  set(revealRequestAtom, { path: targetPath, type, ts: Date.now() });
}

/**
 * Reveal a file in the file tree by expanding parent directories and scrolling to it.
 * FileTree subscribes to revealRequestAtom and handles the scroll.
 */
export const revealFileAtom = atom(null, (get, set, filePath: string) => {
  expandAndReveal(get, set, filePath, 'file');
});

/**
 * Reveal a folder in the file tree by expanding parent directories and scrolling to it.
 * Also sets selectedFolderPathAtom for visual highlighting.
 */
export const revealFolderAtom = atom(null, (get, set, folderPath: string) => {
  set(selectedFolderPathAtom, folderPath);
  expandAndReveal(get, set, folderPath, 'folder');
});

// Keep old selectedFilePathAtom as alias for backward compatibility (re-exports)
export const selectedFilePathAtom = revealRequestAtom;

/**
 * Request to open a file in Files mode.
 * Written by breadcrumb clicks (from any mode), consumed by App.tsx which
 * handles mode switching and tab opening via handleWorkspaceFileSelect.
 */
export interface OpenFileRequest {
  path: string;
  ts: number;
}
export const openFileRequestAtom = atom<OpenFileRequest | null>(null);

// ============================================================
// Flat Virtualized File Tree Atoms
// ============================================================

/**
 * File tree item as used by the renderer (type-based, not isDirectory-based).
 * This matches what WorkspaceSidebar passes to the file tree component.
 */
export interface RendererFileTreeItem {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: RendererFileTreeItem[];
  /** The main-process walk stopped at its depth limit here; `children` was not read. */
  childrenTruncated?: boolean;
  /** Entries the main-process per-folder cap hid from `children`. */
  omittedChildCount?: number;
}

// Special directories that should always appear first with distinct styling
const SPECIAL_DIRECTORIES = ['nimbalyst-local'];

/**
 * The raw (unfiltered) file tree from the workspace watcher.
 * Written by the centralized file tree listener (fileTreeListeners.ts).
 * WorkspaceSidebar reads this and applies filters before passing to FlatFileTree.
 *
 * In a multi-root workspace this holds a FOREST: one synthetic directory node
 * per root, whose children are that root's contents. With no attached folders
 * it holds the primary root's contents directly, exactly as before -- so a
 * single-folder workspace shows no root header row and nothing downstream
 * changes.
 */
export const rawFileTreeAtom = atom<RendererFileTreeItem[]>([]);

/**
 * Every root the workspace spans, primary first. Empty or single-entry for an
 * ordinary workspace. Read by the tree flattener to mark root header rows and
 * by the explorer to offer "Detach Folder".
 */
export const workspaceRootPathsAtom = atom<string[]>([]);

/**
 * Build the explorer forest from per-root trees.
 *
 * Roots with no loaded tree yet render as empty folders rather than vanishing,
 * so an attached folder appears the moment it is attached instead of popping in
 * when its first scan lands.
 *
 * Pure and exported for testing.
 */
export function buildFileTreeForest(
  rootPaths: string[],
  treesByRoot: Record<string, RendererFileTreeItem[]>,
): RendererFileTreeItem[] {
  // One root is the single-folder case: no synthetic wrapper, no header row.
  if (rootPaths.length <= 1) {
    const only = rootPaths[0];
    return only ? (treesByRoot[only] ?? []) : [];
  }

  return rootPaths.map((rootPath) => ({
    name: basenameOfPath(rootPath),
    path: rootPath,
    type: 'directory' as const,
    children: treesByRoot[rootPath] ?? [],
  }));
}

/** Last path segment, tolerant of trailing slashes and Windows separators. */
function basenameOfPath(rootPath: string): string {
  const trimmed = rootPath.replace(/[\\/]+$/, '');
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || trimmed;
}

/** Forward slashes, no trailing slash (except a bare drive root). */
export function normalizeTreePath(path: string): string {
  if (!path) return '';
  let normalized = path.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\/$/i.test(normalized)) {
    return normalized;
  }
  if (normalized !== '/' && normalized.endsWith('/')) {
    normalized = normalized.replace(/\/+$/, '');
  }
  return normalized;
}

/**
 * Carry children the renderer already loaded into a rebuilt tree, wherever the
 * rebuild stopped at the main-process depth limit. A watcher rebuild replaces a
 * whole root, and without this every folder opened below that depth would turn
 * empty on the next file change. Branches with nothing to carry are shared.
 */
export function keepLoadedTruncatedChildren(
  previous: RendererFileTreeItem[] | undefined,
  next: RendererFileTreeItem[],
): RendererFileTreeItem[] {
  if (!previous?.length) return next;
  const loaded = new Map<string, RendererFileTreeItem[]>();
  const collect = (items: RendererFileTreeItem[]) => {
    for (const item of items) {
      if (item.type === 'directory' && item.children?.length) {
        loaded.set(normalizeTreePath(item.path), item.children);
        collect(item.children);
      }
    }
  };
  collect(previous);

  const graft = (items: RendererFileTreeItem[]): RendererFileTreeItem[] => {
    let changed = false;
    const result = items.map((item) => {
      if (item.type !== 'directory') return item;
      if (item.childrenTruncated) {
        const kept = loaded.get(normalizeTreePath(item.path));
        if (!kept) return item;
        changed = true;
        return { ...item, children: kept };
      }
      if (!item.children?.length) return item;
      const children = graft(item.children);
      if (children === item.children) return item;
      changed = true;
      return { ...item, children };
    });
    return changed ? result : items;
  };
  return graft(next);
}

/**
 * Open folders where a rebuild stopped at the depth limit. Their kept children
 * are only as fresh as the last expand, so the listener re-reads these.
 */
export function findExpandedTruncatedFolders(
  items: RendererFileTreeItem[],
  expanded: Set<string>,
): string[] {
  const found: string[] = [];
  const walk = (nodes: RendererFileTreeItem[]) => {
    for (const node of nodes) {
      if (node.type !== 'directory') continue;
      if (node.childrenTruncated) {
        if (expanded.has(node.path)) found.push(node.path);
      } else if (node.children) {
        walk(node.children);
      }
    }
  };
  walk(items);
  return found;
}

/**
 * Replace one folder's children within a tree, returning the new tree and
 * whether anything matched. Structurally shares untouched branches so React
 * only re-renders the subtree that actually changed.
 */
export function replaceFolderChildren(
  items: RendererFileTreeItem[],
  normalizedFolderPath: string,
  newChildren: RendererFileTreeItem[],
): [RendererFileTreeItem[], boolean] {
  let mutated = false;

  const updatedItems = items.map(item => {
    if (item.type !== 'directory') {
      return item;
    }

    if (normalizeTreePath(item.path) === normalizedFolderPath) {
      mutated = true;
      return { ...item, children: newChildren };
    }

    if (item.children && item.children.length > 0) {
      const [nextChildren, childMutated] = replaceFolderChildren(item.children, normalizedFolderPath, newChildren);
      if (childMutated) {
        mutated = true;
        return { ...item, children: nextChildren };
      }
    }

    return item;
  });

  return [mutated ? updatedItems : items, mutated];
}

/**
 * Whether the initial file tree load has completed.
 * Distinguishes "still loading" from "workspace is genuinely empty".
 */
export const fileTreeLoadedAtom = atom(false);

/**
 * The filtered file tree items that the flat tree component renders.
 * Written by FlatFileTree component when its items prop changes.
 */
export const fileTreeItemsAtom = atom<RendererFileTreeItem[]>([]);

/**
 * Current active file path for the flat tree.
 * Written by FlatFileTree when currentFilePath prop changes.
 */
export const flatTreeActiveFileAtom = atom<string | null>(null);

/**
 * Multi-selection state (UI-only, transient).
 * Replaces the prop-drilled sharedSelectionState.
 */
export const selectedPathsAtom = atom<Set<string>>(new Set<string>());

/**
 * Last selected path for shift-click range selection (UI-only, transient).
 */
export const lastSelectedPathAtom = atom<string | null>(null);

/**
 * Keyboard focus position in visibleNodes (UI-only, transient).
 * For future keyboard navigation support.
 */
export const focusedIndexAtom = atom<number | null>(null);

/**
 * Drag-drop state (UI-only, transient).
 * Replaces the prop-drilled sharedDragState.
 */
export interface DragState {
  sourcePaths: string[];
  dropTargetPath: string | null;
  isCopy: boolean;
}
export const dragStateAtom = atom<DragState | null>(null);

/**
 * Flat tree node for rendering (derived from tree + expanded state).
 * Each node represents one visible row in the virtualized list.
 */
export interface FlatTreeNode {
  path: string;
  name: string;
  type: 'file' | 'directory';
  depth: number;
  index: number;
  parentPath: string | null;
  hasChildren: boolean;
  isExpanded: boolean;
  isActive: boolean;
  isSelected: boolean;
  isMultiSelected: boolean;
  isDragOver: boolean;
  isSpecialDirectory: boolean;
  /**
   * A top-level root of a multi-root workspace. Only ever true when the
   * workspace has attached folders -- a single-folder workspace has no root
   * header rows at all.
   */
  isWorkspaceRoot: boolean;
  /**
   * "N more items" rows to draw after this row, innermost folder first: one
   * per expanded capped folder whose last visible descendant this row is.
   * They ride on a real node so keyboard navigation, selection and scroll
   * indices never see them as items.
   */
  omittedAfter?: OmittedEntriesRow[];
}

export interface OmittedEntriesRow {
  folderPath: string;
  count: number;
  depth: number;
}

/**
 * Pure function that flattens a file tree into a list of visible nodes.
 * Exported for unit testing without Jotai/runtime dependencies.
 */
export interface FlattenTreeOptions {
  items: RendererFileTreeItem[];
  expanded: Set<string>;
  activeFile: string | null;
  selectedFolder: string | null;
  selectedPaths: Set<string>;
  dragState: DragState | null;
  /**
   * Roots of a multi-root workspace. Nodes at depth 0 whose path is in this set
   * render as root header rows. Omit (or pass a set with fewer than two
   * entries) for an ordinary single-folder workspace.
   */
  workspaceRootPaths?: Set<string>;
}

export function flattenTree(options: FlattenTreeOptions): FlatTreeNode[] {
  const { items, expanded, activeFile, selectedFolder, selectedPaths, dragState } = options;
  const rootPaths = options.workspaceRootPaths;
  // One root is a plain workspace: nothing is a "root header row".
  const marksRoots = (rootPaths?.size ?? 0) > 1;
  const result: FlatTreeNode[] = [];

  function walk(treeItems: RendererFileTreeItem[], depth: number, parentPath: string | null) {
    for (const item of treeItems) {
      const isDir = item.type === 'directory';
      const isExpanded = isDir && expanded.has(item.path);

      result.push({
        path: item.path,
        name: item.name,
        type: item.type,
        depth,
        index: result.length,
        parentPath,
        hasChildren: isDir && (item.children?.length ?? 0) > 0,
        isExpanded,
        isActive: item.path === activeFile,
        isSelected: item.path === selectedFolder,
        isMultiSelected: selectedPaths.has(item.path),
        isDragOver: dragState?.dropTargetPath === item.path,
        isSpecialDirectory: isDir && SPECIAL_DIRECTORIES.includes(item.name),
        isWorkspaceRoot: marksRoots && depth === 0 && rootPaths!.has(item.path),
      });

      if (isExpanded && item.children) {
        walk(item.children, depth + 1, item.path);
      }

      if (isExpanded && item.omittedChildCount) {
        const last = result[result.length - 1];
        last.omittedAfter = [
          ...(last.omittedAfter ?? []),
          { folderPath: item.path, count: item.omittedChildCount, depth: depth + 1 },
        ];
      }
    }
  }

  walk(items, 0, null);
  return result;
}

/**
 * Core derived atom: flat list of visible tree nodes.
 *
 * Computed by walking fileTreeItemsAtom, skipping children of collapsed dirs.
 * Annotates each node with depth, expansion state, selection state, etc.
 * This is the only data the Virtuoso renderer sees.
 */
export const visibleNodesAtom = atom<FlatTreeNode[]>((get) => {
  return flattenTree({
    items: get(fileTreeItemsAtom),
    expanded: get(expandedDirsAtom),
    activeFile: get(flatTreeActiveFileAtom),
    selectedFolder: get(selectedFolderPathAtom),
    selectedPaths: get(selectedPathsAtom),
    dragState: get(dragStateAtom),
    workspaceRootPaths: new Set(get(workspaceRootPathsAtom)),
  });
});
