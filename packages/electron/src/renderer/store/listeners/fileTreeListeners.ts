/**
 * Central File Tree Listeners
 *
 * Subscribes to workspace file tree IPC events ONCE and updates atoms.
 * Components read from atoms, never subscribe to IPC directly.
 *
 * Events handled:
 * - workspace-file-tree-updated        → rawFileTreeAtom (per owning root)
 * - workspace:folders-changed          → workspaceRootPathsAtom + rawFileTreeAtom
 * - workspace-attach-folder-requested  → folder picker + attach
 *
 * A multi-root workspace loads one tree per root and assembles them into a
 * forest. Trees are kept per root here rather than merged eagerly, so a watcher
 * rebuild of one root cannot clobber another root's subtree.
 *
 * Call initFileTreeListeners(workspacePath) once in AgentMode.tsx on mount.
 */

import { store } from '@nimbalyst/runtime/store';
import {
  rawFileTreeAtom,
  fileTreeLoadedAtom,
  workspaceRootPathsAtom,
  buildFileTreeForest,
  normalizeTreePath,
  replaceFolderChildren,
  type RendererFileTreeItem,
} from '../atoms/fileTree';
import { workspaceRepoPathsAtom } from '../atoms/workspaceRepos';
import { attachWorkspaceFolderWithPicker } from '../actions/workspaceFolders';
import { fetchWorkspaceRepos } from '../../utils/workspaceRepos';

/**
 * Loaded contents per root for the workspace this module is currently
 * listening to. Reset whenever the listener is re-initialized, so a rail
 * switch cannot leave the previous project's subtrees in the forest.
 */
let treesByRoot: Record<string, RendererFileTreeItem[]> = {};

function publishForest(rootPaths: string[]): void {
  store.set(workspaceRootPathsAtom, rootPaths);
  store.set(rawFileTreeAtom, buildFileTreeForest(rootPaths, treesByRoot));
}

async function loadRootTree(rootPath: string): Promise<void> {
  if (!window.electronAPI?.getFolderContents) return;
  try {
    treesByRoot[rootPath] = await window.electronAPI.getFolderContents(rootPath);
  } catch (error) {
    console.error('[fileTreeListeners] Error loading tree for root:', rootPath, error);
    treesByRoot[rootPath] = [];
  }
}

/**
 * Republish which repos the workspace spans. Only attach and detach can change
 * the answer, so this runs alongside the root list rather than on a timer --
 * main caches the filesystem scan behind it and clears that cache on both.
 */
async function refreshWorkspaceRepos(
  workspacePath: string,
  isStale: () => boolean,
): Promise<void> {
  const repos = await fetchWorkspaceRepos(workspacePath);
  // The scan touches the filesystem, so a rail switch or a detach can land
  // first. Publishing a stale answer would leave the repo picker offering repos
  // the workspace no longer spans.
  if (isStale()) return;
  store.set(workspaceRepoPathsAtom, repos);
}

/**
 * The workspace's roots, primary first. Falls back to the primary root alone
 * when the host cannot answer, so the explorer still shows the project rather
 * than nothing.
 */
async function fetchRoots(workspacePath: string): Promise<string[]> {
  try {
    const result = await window.electronAPI?.invoke?.('workspace:get-folders', { workspacePath });
    if (result?.success && Array.isArray(result.folders) && result.folders.length > 0) {
      return result.folders;
    }
  } catch (error) {
    console.error('[fileTreeListeners] Error loading workspace folders:', error);
  }
  return [workspacePath];
}

/**
 * Initialize file tree listeners.
 * Loads the initial file tree and subscribes to updates.
 *
 * @param workspacePath - Current workspace path (the primary root)
 * @returns Cleanup function to call on unmount
 */
export function initFileTreeListeners(workspacePath: string): () => void {
  if (!workspacePath || !window.electronAPI) return () => {};

  const cleanups: Array<() => void> = [];
  let disposed = false;
  treesByRoot = {};
  store.set(workspaceRepoPathsAtom, []);

  // Load the initial forest: every root of this workspace.
  void (async () => {
    const rootPaths = await fetchRoots(workspacePath);
    if (disposed) return;

    await Promise.all(rootPaths.map(loadRootTree));
    if (disposed) return;

    publishForest(rootPaths);
    store.set(fileTreeLoadedAtom, true);
    await refreshWorkspaceRepos(workspacePath, () => disposed);
  })();

  // Subscribe to file tree updates from the watcher. The payload names the
  // root it rebuilt; older payloads without one are the primary root.
  if (window.electronAPI.onWorkspaceFileTreeUpdated) {
    const cleanup = window.electronAPI.onWorkspaceFileTreeUpdated(
      (data: { fileTree: RendererFileTreeItem[]; rootPath?: string }) => {
        const rootPath = data.rootPath ?? workspacePath;
        const rootPaths = store.get(workspaceRootPathsAtom);
        // A rebuild for a root this workspace no longer shows (detach racing a
        // pending debounce) must not resurrect it in the forest.
        if (rootPaths.length > 0 && !rootPaths.includes(rootPath)) return;

        treesByRoot[rootPath] = data.fileTree;
        publishForest(rootPaths.length > 0 ? rootPaths : [workspacePath]);
      }
    );
    cleanups.push(cleanup);
  }

  // Attach/detach: reload the affected root and republish.
  if (window.electronAPI.on) {
    // `electronAPI.on` strips Electron's event argument, so the payload is the
    // FIRST parameter -- an `(event, data)` signature here silently never fires.
    const cleanup = window.electronAPI.on(
      'workspace:folders-changed',
      async (data: { workspacePath: string; folders: string[] }) => {
        if (disposed || data?.workspacePath !== workspacePath) return;

        const rootPaths = data.folders ?? [workspacePath];
        for (const known of Object.keys(treesByRoot)) {
          if (!rootPaths.includes(known)) delete treesByRoot[known];
        }
        await Promise.all(rootPaths.filter((r) => !treesByRoot[r]).map(loadRootTree));
        if (disposed) return;

        publishForest(rootPaths);
        await refreshWorkspaceRepos(workspacePath, () => disposed);
      }
    );
    cleanups.push(cleanup);

    // A root's `.gitignore` decides which nested clones count as repos; main
    // rescans on a change and names the root.
    const reposCleanup = window.electronAPI.on(
      'workspace:repos-changed',
      async (data: { workspacePath: string }) => {
        if (disposed || !data?.workspacePath) return;
        if (data.workspacePath !== workspacePath && !treesByRoot[data.workspacePath]) return;
        await refreshWorkspaceRepos(workspacePath, () => disposed);
      }
    );
    cleanups.push(reposCleanup);
  }

  // "Attach Folder to Workspace..." from the File menu. The main process only
  // forwards the request; the picker and the attach call live here so every
  // entry point runs the same flow.
  if (window.electronAPI.on) {
    const cleanup = window.electronAPI.on('workspace-attach-folder-requested', () => {
      void attachWorkspaceFolderWithPicker(workspacePath).then((outcome) => {
        if (!outcome.success && outcome.error) {
          console.error('[fileTreeListeners] Attach folder failed:', outcome.error);
        }
      });
    });
    cleanups.push(cleanup);
  }

  return () => {
    disposed = true;
    treesByRoot = {};
    cleanups.forEach(cleanup => cleanup?.());
  };
}

/** The workspace root that owns `path`, or null when no root contains it. */
function resolveOwningRoot(path: string, rootPaths: string[]): string | null {
  const normalized = normalizeTreePath(path);
  let best: string | null = null;
  for (const root of rootPaths) {
    const normalizedRoot = normalizeTreePath(root);
    if (normalized === normalizedRoot || normalized.startsWith(normalizedRoot + '/')) {
      if (!best || normalizedRoot.length > normalizeTreePath(best).length) {
        best = root;
      }
    }
  }
  return best;
}

/**
 * Fold a lazily-loaded folder's contents into the forest.
 *
 * Writes through the per-root cache rather than straight to `rawFileTreeAtom`:
 * the next watcher rebuild republishes from that cache, so a direct atom write
 * would be silently discarded on the following file change.
 */
export function applyLoadedFolderContents(
  folderPath: string,
  contents: RendererFileTreeItem[],
): void {
  const rootPaths = store.get(workspaceRootPathsAtom);
  const owningRoot = resolveOwningRoot(folderPath, rootPaths);
  if (!owningRoot) return;

  if (normalizeTreePath(folderPath) === normalizeTreePath(owningRoot)) {
    treesByRoot[owningRoot] = contents;
  } else {
    const [next, changed] = replaceFolderChildren(
      treesByRoot[owningRoot] ?? [],
      normalizeTreePath(folderPath),
      contents,
    );
    if (!changed) return;
    treesByRoot[owningRoot] = next;
  }

  publishForest(rootPaths);
}

/**
 * Refresh the file tree by re-fetching from the main process.
 * Call this after file creation/deletion operations.
 *
 * Refreshes the root that owns `path` -- passing the primary root of a
 * multi-root workspace rebuilds only that root, leaving attached folders alone.
 */
export async function refreshFileTree(path: string): Promise<void> {
  if (!path || !window.electronAPI?.getFolderContents) return;

  const rootPaths = store.get(workspaceRootPathsAtom);
  const owningRoot = resolveOwningRoot(path, rootPaths) ?? path;

  await loadRootTree(owningRoot);
  publishForest(rootPaths.length > 0 ? rootPaths : [owningRoot]);
}
