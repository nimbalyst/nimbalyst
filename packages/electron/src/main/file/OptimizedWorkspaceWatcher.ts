import { BrowserWindow } from 'electron';
import { getFolderContents } from '../utils/FileTree';
import { logger } from '../utils/logger';
import { getWindowId, markRecentlyDeleted } from '../window/WindowManager';
import { openFileReconciler } from './OpenFileReconciler';
import * as workspaceEventBus from './WorkspaceEventBus';

/**
 * Optimized workspace watcher.
 *
 * Subscribes to WorkspaceEventBus (which owns the single fs.watch/chokidar
 * watcher per workspace tree) and translates events into file tree updates
 * and file-changed-on-disk notifications for the renderer.
 *
 * A window watches a SET of roots -- the primary workspace plus every attached
 * folder -- not one root. Each root gets its own bus subscription and its own
 * debounce timer, and tree updates name the root they rebuilt so the renderer
 * can replace exactly that subtree.
 */
export class OptimizedWorkspaceWatcher {
    /** Debounce timers, keyed `${windowId}:${rootPath}` -- one per root. */
    private updateTimers = new Map<string, NodeJS.Timeout>();
    /** Roots each window watches, in attachment order (primary first). */
    private roots = new Map<number, Set<string>>();
    private watchedPaths = new Map<number, Set<string>>();
    /** Subscriber IDs we've registered with the bus, keyed by windowId */
    private subscriberIds = new Map<number, string>();

    private timerKey(windowId: number, rootPath: string): string {
        return `${windowId}:${rootPath}`;
    }

    /**
     * Begin watching one root for a window. Idempotent, and additive: starting
     * a second root leaves the first running. Callers that want a clean slate
     * (a rail switch) call `stop(windowId)` first.
     */
    async start(window: BrowserWindow, workspacePath: string) {
        const windowId = getWindowId(window);
        if (windowId === null) {
            logger.workspaceWatcher.error('Failed to find window ID');
            return;
        }

        const existingRoots = this.roots.get(windowId);
        if (existingRoots?.has(workspacePath)) {
            return;
        }

        if (existingRoots) {
            existingRoots.add(workspacePath);
        } else {
            this.roots.set(windowId, new Set([workspacePath]));
        }

        const watched = this.watchedPaths.get(windowId);
        if (watched) {
            watched.add(workspacePath);
        } else {
            this.watchedPaths.set(windowId, new Set([workspacePath]));
        }

        // Debounced update function
        const triggerUpdate = () => {
            const key = this.timerKey(windowId, workspacePath);
            const existingTimer = this.updateTimers.get(key);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }

            const timer = setTimeout(() => {
                logger.workspaceWatcher.debug('Updating file tree');
                getFolderContents(workspacePath).then((fileTree) => {
                    if (!window || window.isDestroyed()) {
                        return;
                    }
                    // `rootPath` tells a multi-root renderer which subtree this
                    // rebuild replaces. Single-root windows ignore it.
                    window.webContents.send('workspace-file-tree-updated', {
                        rootPath: workspacePath,
                        fileTree,
                    });
                }).catch((error) => {
                    logger.workspaceWatcher.error('Failed to update file tree:', error);
                });
            }, 500);

            this.updateTimers.set(key, timer);
        };

        const subscriberId = `workspace-watcher-${windowId}`;
        this.subscriberIds.set(windowId, subscriberId);

        let recovering = false;
        try {
            await workspaceEventBus.subscribe(workspacePath, subscriberId, {
                onHealthChanged: (health) => {
                    if (!window.isDestroyed()) window.webContents.send('file:watch-health', { root: workspacePath, ...health });
                    if (health.state === 'recovering') recovering = true;
                    if (health.state === 'watching' && recovering) {
                        recovering = false;
                        triggerUpdate();
                        void openFileReconciler.reconcileRoot(workspacePath);
                    }
                },
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
                    if (gitignoreBypassed && !filePath.toLowerCase().endsWith('.md') && !workspaceEventBus.hasGitignoreBypass(workspacePath, filePath)) return;
                    if (!window.isDestroyed()) {
                        window.webContents.send('file-changed-on-disk', { path: filePath });
                    }
                },
                onUnlink: (filePath: string, gitignoreBypassed?: boolean) => {
                    // Always refresh file tree for deleted files
                    triggerUpdate();
                    if (gitignoreBypassed && !filePath.toLowerCase().endsWith('.md') && !workspaceEventBus.hasGitignoreBypass(workspacePath, filePath)) return;
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
        } catch (error) {
            this.stopRoot(windowId, workspacePath);
            throw error;
        }
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

        if (!watchedPaths) {
            return;
        }

        // Guard: only watch folders inside one of this window's roots. Which
        // root owns the folder also decides which bus subscription gets the
        // Linux chokidar expansion.
        const owningRoot = this.resolveOwningRoot(windowId, folderPath);
        if (!owningRoot) {
            return;
        }

        if (watchedPaths.has(folderPath)) {
            return;
        }

        watchedPaths.add(folderPath);

        // Forward to bus for Linux chokidar expansion
        workspaceEventBus.addWatchedPath(owningRoot, folderPath);
    }

    /**
     * Remove a folder from watch (called when user collapses a folder in the UI).
     */
    removeWatchedFolder(windowId: number, folderPath: string) {
        const watchedPaths = this.watchedPaths.get(windowId);
        if (!watchedPaths || !watchedPaths.has(folderPath)) {
            return;
        }

        watchedPaths.delete(folderPath);

        const owningRoot = this.resolveOwningRoot(windowId, folderPath);
        if (owningRoot) {
            workspaceEventBus.removeWatchedPath(owningRoot, folderPath);
        }
    }

    /**
     * The watched root that contains `folderPath`, or null when the folder sits
     * outside every root this window shows. Deepest root wins, so a folder
     * attached inside another root is attributed to the nearer one.
     */
    private resolveOwningRoot(windowId: number, folderPath: string): string | null {
        const roots = this.roots.get(windowId);
        if (!roots) return null;

        let best: string | null = null;
        for (const root of roots) {
            if (folderPath === root || folderPath.startsWith(root + '/')) {
                if (!best || root.length > best.length) {
                    best = root;
                }
            }
        }
        return best;
    }

    /** Roots this window currently watches, in the order they were started. */
    getRoots(windowId: number): string[] {
        return [...(this.roots.get(windowId) ?? [])];
    }

    // ---------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------

    /**
     * Stop watching a single root, leaving the window's other roots running.
     * Used when a folder is detached.
     */
    stopRoot(windowId: number, rootPath: string) {
        const roots = this.roots.get(windowId);
        if (!roots?.has(rootPath)) {
            return;
        }

        const subscriberId = this.subscriberIds.get(windowId);
        if (subscriberId) {
            workspaceEventBus.unsubscribe(rootPath, subscriberId);
        }

        roots.delete(rootPath);
        if (roots.size === 0) {
            this.roots.delete(windowId);
            this.subscriberIds.delete(windowId);
        }

        // Drop expanded-folder tracking for anything under the departing root,
        // or a re-attach would see them as already watched and never re-add
        // them to the bus.
        const watched = this.watchedPaths.get(windowId);
        if (watched) {
            for (const folderPath of [...watched]) {
                if (folderPath === rootPath || folderPath.startsWith(rootPath + '/')) {
                    watched.delete(folderPath);
                }
            }
        }

        const key = this.timerKey(windowId, rootPath);
        const timer = this.updateTimers.get(key);
        if (timer) {
            clearTimeout(timer);
            this.updateTimers.delete(key);
        }
    }

    stop(windowId: number) {
        for (const rootPath of [...(this.roots.get(windowId) ?? [])]) {
            this.stopRoot(windowId, rootPath);
        }

        this.subscriberIds.delete(windowId);
        this.roots.delete(windowId);
        this.watchedPaths.delete(windowId);
    }

    async stopAll() {
        logger.workspaceWatcher.info(`[CLEANUP] Stopping all workspace watchers (${this.roots.size} windows)`);

        for (const windowId of [...this.roots.keys()]) {
            this.stop(windowId);
        }

        for (const timer of this.updateTimers.values()) {
            clearTimeout(timer);
        }
        this.updateTimers.clear();
    }

    getStats() {
        const stats: Array<{ windowId: number; workspacePath: string; watchedFolders: number }> = [];
        for (const [windowId, roots] of this.roots.entries()) {
            const watchedPaths = this.watchedPaths.get(windowId);
            for (const workspacePath of roots) {
                stats.push({
                    windowId,
                    workspacePath,
                    watchedFolders: [...(watchedPaths ?? [])].filter(
                        (p) => p === workspacePath || p.startsWith(workspacePath + '/'),
                    ).length,
                });
            }
        }

        const busStats = workspaceEventBus.getStats();
        return {
            type: busStats.type,
            activeWorkspaces: busStats.activeWorkspaces,
            registeredWorkspaces: stats.length,
            health: busStats.workspaces,
            reconciliation: openFileReconciler.getStats(),
            workspaces: stats,
        };
    }
}

export const optimizedWorkspaceWatcher = new OptimizedWorkspaceWatcher();
