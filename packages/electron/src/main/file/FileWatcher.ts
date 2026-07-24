/**
 * Per-file watcher facade.
 *
 * Previously each open tab created a per-file chokidar watcher. Now the
 * WorkspaceEventBus delivers file-changed-on-disk and file-deleted events
 * for the entire workspace tree, so per-file watchers are unnecessary.
 *
 * These functions are retained as no-ops so call sites don't need to be
 * rewritten — the renderer still calls start-watching-file / stop-watching-file
 * on tab open/close, which harmlessly does nothing.
 */

import { BrowserWindow } from 'electron';

// Start watching a file for changes (no-op — WorkspaceEventBus covers this)
export async function startFileWatcher(_window: BrowserWindow, _filePath: string): Promise<void> {
    // No-op: the WorkspaceEventBus already watches the entire workspace tree
    // and delivers file-changed-on-disk + file-deleted events.
}

// Stop watching a file (no-op)
export function stopFileWatcher(_windowId: number) {
    // No-op
}

// Get file watcher info for debugging
export function getFileWatcherInfo(_windowId: number): any {
    return {
        type: 'WorkspaceEventBus (per-file watchers removed)',
        activeWatchers: 0,
        watchers: [],
    };
}

// Check file for changes manually (no-op)
export async function checkFileForChanges(_window: BrowserWindow, _filePath: string): Promise<void> {
    // No-op: the WorkspaceEventBus detects changes automatically
}

// Stop all file watchers (no-op — bus is stopped via stopAllWorkspaceWatchers)
export async function stopAllFileWatchers() {
    // No-op: WorkspaceEventBus.stopAll() is called by stopAllWorkspaceWatchers()
}
