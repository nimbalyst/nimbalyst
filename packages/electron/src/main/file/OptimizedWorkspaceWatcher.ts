import { BrowserWindow } from 'electron';
import { getFolderContents } from '../utils/FileTree';
import { logger } from '../utils/logger';
import { getWindowId, markRecentlyDeleted, windows, windowStates } from '../window/WindowManager';
import { windowReferencesWorkspace } from '../window/windowState';
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

    /**
     * Content-only watches kept alive for rail projects that are registered
     * (warm) in a window but not the window's currently-visible project.
     * Keyed by resolved workspacePath -> number of logical callers that
     * asked for a background watch on that path (normally 1; can exceed 1
     * if two windows both keep the same path warm). Only ever forwards
     * `file-changed-on-disk` / `file-deleted` -- never rebuilds or pushes
     * the file tree, because `workspace-file-tree-updated` lands in a
     * renderer atom that isn't workspace-scoped (see WorkspaceWatcher.ts
     * docs on `startBackgroundWorkspaceWatch`).
     */
    private backgroundRefCounts = new Map<string, number>();

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
    // Background (warm, non-visible rail project) watching
    // ---------------------------------------------------------------

    /**
     * Send an IPC event to every window that actually references
     * `workspacePath` (primary or warm rail path) instead of broadcasting to
     * every window in the process, so the fan-out stays bounded by how many
     * windows chose to keep the project warm.
     */
    private sendToReferencingWindows(workspacePath: string, channel: string, payload: unknown): void {
        for (const [windowId, window] of windows) {
            if (window.isDestroyed()) continue;
            if (!windowReferencesWorkspace(windowStates.get(windowId), workspacePath)) continue;
            window.webContents.send(channel, payload);
        }
    }

    /**
     * Start a content-only watch for a warm rail project that is registered
     * in a window but not currently visible. Forwards `file-changed-on-disk`
     * / `file-deleted` so open editor buffers for that project stay correct
     * while it's in the background, but deliberately never triggers a file
     * tree rebuild/push: `workspace-file-tree-updated` lands in a single
     * global renderer atom with no workspacePath on the payload, so pushing
     * a background project's tree would silently clobber whatever tree is
     * currently visible. The visible project's tree is always fetched fresh
     * on activation instead (`initFileTreeListeners` -> `getFolderContents`,
     * an uncached disk read), so no push channel is needed for correctness.
     *
     * Ref-counted per workspacePath (not per window) so multiple callers
     * asking for the same background path don't create duplicate bus
     * subscriptions or race each other's unsubscribe.
     */
    async startBackground(workspacePath: string): Promise<void> {
        const count = this.backgroundRefCounts.get(workspacePath) ?? 0;
        this.backgroundRefCounts.set(workspacePath, count + 1);
        if (count > 0) {
            // Already subscribed for this path; just tracked another caller.
            return;
        }

        const subscriberId = `workspace-watcher-bg-${workspacePath}`;
        await workspaceEventBus.subscribe(workspacePath, subscriberId, {
            onChange: (filePath: string) => {
                this.sendToReferencingWindows(workspacePath, 'file-changed-on-disk', { path: filePath });
            },
            onAdd: (filePath: string, gitignoreBypassed?: boolean) => {
                if (gitignoreBypassed) return; // SessionFileWatcher handles editor notifications
                this.sendToReferencingWindows(workspacePath, 'file-changed-on-disk', { path: filePath });
            },
            onUnlink: (filePath: string, gitignoreBypassed?: boolean) => {
                markRecentlyDeleted(filePath);
                if (gitignoreBypassed) return; // SessionFileWatcher handles editor notifications
                this.sendToReferencingWindows(workspacePath, 'file-changed-on-disk', { path: filePath });
                this.sendToReferencingWindows(workspacePath, 'file-deleted', { filePath });
            },
            // This listener does editor-buffer notification, not file-tree
            // structure tracking (it never rebuilds the tree), so it should
            // NOT opt in to gitignored structural events -- WorkspaceEventBus
            // reserves that flag for tree listeners and explicitly calls out
            // "editor notification" listeners as the case that should leave
            // it off. We already discard gitignoreBypassed events above, so
            // this only saves the bus the round trip of calling us for them.
            receiveGitignoredStructureEvents: false,
        });
    }

    /**
     * Release ONE caller's hold on a background watch started via
     * `startBackground`. No-op if the path was never backgrounded, or if
     * other callers still hold it warm.
     *
     * This is the "I know exactly which single reference I'm dropping"
     * variant -- its only caller is `releaseWarmWatchOnPromotion` (a window
     * promoting ITS OWN warm path to active), which is NOT gated on
     * `anyWindowReferencesWorkspace`: other windows may legitimately still
     * hold the same path warm, and a plain decrement is what keeps their
     * subscription alive. Any release site that has already proven (via
     * `anyWindowReferencesWorkspace`) that NO window references the path
     * anymore must use `releaseAllBackgroundRefs` instead -- decrementing by
     * one there is the bug this pair of methods exists to avoid: with two
     * windows both keeping a path warm, only the LAST window's release call
     * ever runs while the boolean gate is false, so a plain decrement never
     * reaches zero and leaks the bus subscription forever.
     */
    stopBackground(workspacePath: string): void {
        const count = this.backgroundRefCounts.get(workspacePath) ?? 0;
        if (count <= 0) return;

        const next = count - 1;
        if (next > 0) {
            this.backgroundRefCounts.set(workspacePath, next);
            return;
        }

        this.backgroundRefCounts.delete(workspacePath);
        workspaceEventBus.unsubscribe(workspacePath, `workspace-watcher-bg-${workspacePath}`);
    }

    /**
     * Fully release a background watch for `workspacePath`, regardless of
     * how many callers `startBackground` ever counted for it. Callers MUST
     * have independently proven -- via `anyWindowReferencesWorkspace` --
     * that no window references this path anymore before calling this; once
     * that is true there is no live window left to still need the shared bus
     * subscription, no matter what the refcount says. Idempotent: safe to
     * call for a path that was never backgrounded, or one another caller
     * already released.
     */
    releaseAllBackgroundRefs(workspacePath: string): void {
        if (!this.backgroundRefCounts.has(workspacePath)) return;

        this.backgroundRefCounts.delete(workspacePath);
        workspaceEventBus.unsubscribe(workspacePath, `workspace-watcher-bg-${workspacePath}`);
    }

    /** Number of paths currently held warm in the background. Test/diagnostics only. */
    getBackgroundWatchCount(): number {
        return this.backgroundRefCounts.size;
    }

    /** Paths currently held warm in the background. Used to sweep orphans on `stop`/`stopAll`. */
    getBackgroundWatchPaths(): string[] {
        return [...this.backgroundRefCounts.keys()];
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
        logger.workspaceWatcher.info(
            `[CLEANUP] Stopping all workspace watchers (${this.workspacePaths.size} windows, ${this.backgroundRefCounts.size} background)`
        );

        for (const windowId of [...this.subscriberIds.keys()]) {
            this.stop(windowId);
        }

        for (const workspacePath of [...this.backgroundRefCounts.keys()]) {
            workspaceEventBus.unsubscribe(workspacePath, `workspace-watcher-bg-${workspacePath}`);
        }
        this.backgroundRefCounts.clear();

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
            backgroundWorkspaces: [...this.backgroundRefCounts.keys()],
        };
    }
}

export const optimizedWorkspaceWatcher = new OptimizedWorkspaceWatcher();
