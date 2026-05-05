import { BrowserWindow } from 'electron';
import { getFolderContents } from '../utils/FileTree';
import { logger } from '../utils/logger';
import { getWindowId, markRecentlyDeleted } from '../window/WindowManager';
import * as workspaceEventBus from './WorkspaceEventBus';

/**
 * Optimized workspace watcher.
 *
 * Subscribes to WorkspaceEventBus (which owns the single fs.watch/chokidar
 * watcher per workspace tree) and translates events into file tree updates
 * and file-changed-on-disk notifications for the renderer.
 */
export class OptimizedWorkspaceWatcher {
    private updateTimers = new Map<number, NodeJS.Timeout>();
    private workspacePaths = new Map<number, string>();
    private watchedPaths = new Map<number, Set<string>>();
    /** Subscriber IDs we've registered with the bus, keyed by windowId */
    private subscriberIds = new Map<number, string>();

    async start(window: BrowserWindow, workspacePath: string) {
        const windowId = getWindowId(window);
        if (windowId === null) {
            logger.workspaceWatcher.error('Failed to find window ID');
            return;
        }

        this.stop(windowId);

        this.workspacePaths.set(windowId, workspacePath);
        this.watchedPaths.set(windowId, new Set([workspacePath]));

        // Debounced update function
        const triggerUpdate = () => {
            const existingTimer = this.updateTimers.get(windowId);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            const timer = setTimeout(() => {
                logger.workspaceWatcher.debug('Updating file tree');
                getFolderContents(workspacePath).then((fileTree) => {
                    if (!window || window.isDestroyed()) {
                        return;
                    }
                    window.webContents.send('workspace-file-tree-updated', { fileTree });
                }).catch((error) => {
                    logger.workspaceWatcher.error('Failed to update file tree:', error);
                });
            }, 500);

            this.updateTimers.set(windowId, timer);
        };

        const subscriberId = `workspace-watcher-${windowId}`;
        this.subscriberIds.set(windowId, subscriberId);

        await workspaceEventBus.subscribe(workspacePath, subscriberId, {
            onChange: (filePath: string) => {
                // Content modification -- notify editors, do NOT rebuild file tree.
                // We send for bypassed (gitignored-but-tracked) files too: SessionFileWatcher
                // skips events that pass through `markEditorSave` (restore from history,
                // manual Cmd+S, autosave), so without this branch a gitignored .md file
                // open in the editor would never reload after the user wrote to it.
                if (!window.isDestroyed()) {
                    window.webContents.send('file-changed-on-disk', { path: filePath });
                }
            },
            onAdd: (filePath: string, gitignoreBypassed?: boolean) => {
                // Always refresh file tree for new files — the tree builder has its
                // own EXCLUDED_DIRS filtering, so gitignored files in non-excluded
                // dirs (e.g. AI-created files) will correctly appear.
                triggerUpdate();
                if (gitignoreBypassed) return; // SessionFileWatcher handles editor notifications
                if (!window.isDestroyed()) {
                    window.webContents.send('file-changed-on-disk', { path: filePath });
                }
            },
            onUnlink: (filePath: string, gitignoreBypassed?: boolean) => {
                // Always refresh file tree for deleted files
                triggerUpdate();
                if (gitignoreBypassed) return; // SessionFileWatcher handles editor notifications
                // Track the deletion in the lifecycle-bound recentlyDeleted
                // map so a stale autosave from any surviving editor cannot
                // recreate the file with old content. Cleared by
                // editor:released-deleted-path once the renderer has fully
                // released the path AND observed a fresh load.
                markRecentlyDeleted(filePath);
                if (!window.isDestroyed()) {
                    window.webContents.send('file-changed-on-disk', { path: filePath });
                    window.webContents.send('file-deleted', { filePath });
                }
            },
            // The file-tree builder shows gitignored paths that aren't in
            // EXCLUDED_DIRS (e.g. `temp/`, `nimbalyst-local/`, `test-results/`),
            // so we need refresh events for gitignored adds/unlinks too. Without
            // this, an agent's `mkdir tmp` against a `tmp/` gitignore pattern
            // never reaches the sidebar until the workspace reopens.
            receiveGitignoredStructureEvents: true,
        });
    }

    // ---------------------------------------------------------------
    // Folder expansion tracking
    // ---------------------------------------------------------------

    /**
     * Add a folder to watch (called when user expands a folder in the UI).
     *
     * On macOS/Windows this is a no-op for watching purposes because the
     * recursive fs.watch already covers the entire tree. We still track
     * the path so getStats() reports accurately.
     *
     * On Linux (chokidar) this adds the folder to the chokidar watcher.
     */
    addWatchedFolder(windowId: number, folderPath: string) {
        const watchedPaths = this.watchedPaths.get(windowId);
        const workspacePath = this.workspacePaths.get(windowId);

        if (!watchedPaths) {
            return;
        }

        // Guard: only watch folders within the workspace
        if (workspacePath && !folderPath.startsWith(workspacePath + '/') && folderPath !== workspacePath) {
            return;
        }

        if (watchedPaths.has(folderPath)) {
            return;
        }

        watchedPaths.add(folderPath);

        // Forward to bus for Linux chokidar expansion
        if (workspacePath) {
            workspaceEventBus.addWatchedPath(workspacePath, folderPath);
        }
    }

    /**
     * Remove a folder from watch (called when user collapses a folder in the UI).
     */
    removeWatchedFolder(windowId: number, folderPath: string) {
        const watchedPaths = this.watchedPaths.get(windowId);
        const workspacePath = this.workspacePaths.get(windowId);
        if (!watchedPaths || !watchedPaths.has(folderPath)) {
            return;
        }

        watchedPaths.delete(folderPath);

        if (workspacePath) {
            workspaceEventBus.removeWatchedPath(workspacePath, folderPath);
        }
    }

    // ---------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------

    stop(windowId: number) {
        const subscriberId = this.subscriberIds.get(windowId);
        const workspacePath = this.workspacePaths.get(windowId);

        if (subscriberId && workspacePath) {
            workspaceEventBus.unsubscribe(workspacePath, subscriberId);
        }

        this.subscriberIds.delete(windowId);
        this.workspacePaths.delete(windowId);
        this.watchedPaths.delete(windowId);

        const timer = this.updateTimers.get(windowId);
        if (timer) {
            clearTimeout(timer);
            this.updateTimers.delete(windowId);
        }
    }

    async stopAll() {
        logger.workspaceWatcher.info(`[CLEANUP] Stopping all workspace watchers (${this.workspacePaths.size} windows)`);

        for (const windowId of [...this.subscriberIds.keys()]) {
            this.stop(windowId);
        }

        for (const timer of this.updateTimers.values()) {
            clearTimeout(timer);
        }
        this.updateTimers.clear();
    }

    getStats() {
        const stats: Array<{ windowId: number; workspacePath: string; watchedFolders: number }> = [];
        for (const [windowId, workspacePath] of this.workspacePaths.entries()) {
            const watchedPaths = this.watchedPaths.get(windowId);
            stats.push({
                windowId,
                workspacePath,
                watchedFolders: watchedPaths?.size ?? 0,
            });
        }

        const busStats = workspaceEventBus.getStats();
        return {
            type: busStats.type,
            activeWorkspaces: this.workspacePaths.size,
            workspaces: stats,
        };
    }
}

export const optimizedWorkspaceWatcher = new OptimizedWorkspaceWatcher();
