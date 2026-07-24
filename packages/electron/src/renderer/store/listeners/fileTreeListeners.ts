/**
 * Central File Tree Listeners
 *
 * Subscribes to workspace file tree IPC events ONCE and updates atoms.
 * Components read from atoms, never subscribe to IPC directly.
 *
 * Events handled:
 * - workspace-file-tree-updated → rawFileTreeAtom
 *
 * Call initFileTreeListeners(workspacePath) once in AgentMode.tsx on mount.
 */

import { store } from '@nimbalyst/runtime/store';
import { rawFileTreeAtom, fileTreeLoadedAtom, type RendererFileTreeItem } from '../atoms/fileTree';

/**
 * Initialize file tree listeners.
 * Loads the initial file tree and subscribes to updates.
 *
 * @param workspacePath - Current workspace path
 * @returns Cleanup function to call on unmount
 */
export function initFileTreeListeners(workspacePath: string): () => void {
  if (!workspacePath || !window.electronAPI) return () => {};

  const cleanups: Array<() => void> = [];

  // Load initial file tree
  if (window.electronAPI.getFolderContents) {
    window.electronAPI.getFolderContents(workspacePath)
      .then((tree: RendererFileTreeItem[]) => {
        store.set(rawFileTreeAtom, tree);
        store.set(fileTreeLoadedAtom, true);
      })
      .catch((error: unknown) => {
        console.error('[fileTreeListeners] Error loading initial file tree:', error);
        store.set(fileTreeLoadedAtom, true);
      });
  }

  // Subscribe to file tree updates from the watcher
  if (window.electronAPI.onWorkspaceFileTreeUpdated) {
    const cleanup = window.electronAPI.onWorkspaceFileTreeUpdated(
      (data: { fileTree: RendererFileTreeItem[] }) => {
        store.set(rawFileTreeAtom, data.fileTree);
      }
    );
    cleanups.push(cleanup);
  }

  return () => {
    cleanups.forEach(cleanup => cleanup?.());
  };
}

/**
 * Refresh the file tree by re-fetching from the main process.
 * Call this after file creation/deletion operations.
 */
export async function refreshFileTree(workspacePath: string): Promise<void> {
  if (!workspacePath || !window.electronAPI?.getFolderContents) return;

  try {
    const tree = await window.electronAPI.getFolderContents(workspacePath);
    store.set(rawFileTreeAtom, tree);
  } catch (error) {
    console.error('[fileTreeListeners] Error refreshing file tree:', error);
  }
}
