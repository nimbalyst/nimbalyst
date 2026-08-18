import { BrowserWindow } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { getWindowId, windowStates } from '../window/WindowManager';
import { anyWindowReferencesWorkspace } from '../window/windowState';
import { clearGitStatusCache } from '../ipc/GitStatusHandlers';
import { optimizedWorkspaceWatcher } from './OptimizedWorkspaceWatcher';
import { gitRefWatcher } from './GitRefWatcher';
import * as workspaceEventBus from './WorkspaceEventBus';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { readdirSync } from 'fs';
import path from "path";
import { createHash } from 'crypto';
import { getProjectFileSyncService } from '../services/ProjectFileSyncService';
import { isSyncEnabled } from '../services/SyncManager';
import { getReleaseChannel, getSessionSyncConfig } from '../utils/store';

// Helper function to calculate folder depth relative to workspace
function calculateFolderDepth(folderPath: string, workspacePath: string): number {
    const relativePath = path.relative(path.normalize(folderPath), path.normalize(workspacePath));
    if (!relativePath) return 0;
    return relativePath.split(path.sep).length;
}

// Helper function to bucket file counts
function bucketFileCount(count: number): string {
    if (count <= 10) return '1-10';
    if (count <= 50) return '11-50';
    if (count <= 100) return '51-100';
    return '100+';
}

workspaceEventBus.setGitignoreChangeHandler((workspacePath: string) => {
    clearGitStatusCache(workspacePath);

    for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
            window.webContents.send('git:status-changed', { workspacePath });
        }
    }
});

// Set up IPC handlers for folder expand/collapse events
export function registerWorkspaceWatcherHandlers() {
    safeHandle('workspace-folder-expanded', async (event, folderPath: string) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return;

        const windowId = getWindowId(window);
        if (windowId === null) return;

        logger.workspaceWatcher.debug(`Folder expanded: ${folderPath}`);
        optimizedWorkspaceWatcher.addWatchedFolder(windowId, folderPath);

        // Track folder expansion analytics
        try {
            const state = windowStates.get(windowId);
            if (state?.workspacePath) {
                // Calculate depth
                const depth = calculateFolderDepth(folderPath, state.workspacePath);

                // Count files in the expanded folder
                let fileCount = 0;
                try {
                    const entries = readdirSync(folderPath, { withFileTypes: true });
                    fileCount = entries.filter(entry => entry.isFile()).length;
                } catch (error) {
                    // Ignore count errors
                }

                const analytics = AnalyticsService.getInstance();
                analytics.sendEvent('workspace_file_tree_expanded', {
                    depth,
                    fileCount: bucketFileCount(fileCount),
                });
            }
        } catch (error) {
            logger.workspaceWatcher.error('Error tracking workspace_file_tree_expanded event:', error);
        }
    });

    safeHandle('workspace-folder-collapsed', async (event, folderPath: string) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return;

        const windowId = getWindowId(window);
        if (windowId === null) return;

        logger.workspaceWatcher.debug(`Folder collapsed: ${folderPath}`);
        optimizedWorkspaceWatcher.removeWatchedFolder(windowId, folderPath);
    });
}

// Start watching a workspace directory for changes
export function startWorkspaceWatcher(window: BrowserWindow, workspacePath: string) {
    const windowId = getWindowId(window);
    if (windowId === null) {
        logger.workspaceWatcher.error('Failed to find custom window ID');
        return;
    }

    // Use optimized chokidar-based workspace watcher
    // logger.workspaceWatcher.info('Using OptimizedWorkspaceWatcher for:', workspacePath);
    optimizedWorkspaceWatcher.start(window, workspacePath);

    // Start git ref watcher for this workspace (detects commits and staging changes)
    gitRefWatcher.start(workspacePath).catch((error) => {
        logger.workspaceWatcher.error('Failed to start GitRefWatcher:', error);
    });

    // Start project file sync for .md files (non-blocking, non-fatal)
    startProjectFileSync(workspacePath).catch((error) => {
        logger.workspaceWatcher.error('Failed to start ProjectFileSync:', error);
    });
}

// ============================================================================
// Warm (rail-registered, not-currently-visible) workspace watching
//
// The rail lets a window keep several projects registered while only one is
// visible. `OptimizedWorkspaceWatcher` is single-active-per-window (the
// `start`/`stop` pair above), so a warm-but-invisible project historically
// had no watcher at all: its open editor buffers never learned about disk
// changes, and its GitRefWatcher (commit detection / pending-review
// auto-approve / git-status cache invalidation) went dark the moment it
// stopped being the visible project.
//
// The three functions below keep a warm project's *content* events flowing
// without paying the cost -- or the renderer-side risk -- of also pushing
// `workspace-file-tree-updated` for it:
//   - `workspace-file-tree-updated` lands in a single global (not
//     workspace-scoped) renderer atom with no workspacePath on the payload,
//     so pushing a background project's tree would silently clobber
//     whatever tree is currently visible.
//   - The visible project's tree is already fetched fresh on every
//     activation (`initFileTreeListeners` -> `getFolderContents`, an
//     uncached disk read), so no push channel is needed there for
//     correctness -- multiplexing it would be pure waste.
//   - `file-changed-on-disk` / `file-deleted`, by contrast, are consumed by
//     per-file-path atom families (`fileChangedOnDiskAtomFamily`,
//     `fileDeletedAtomFamily`) that DiskBackedStore subscribes to per open
//     tab regardless of which project is visible, so multiplexing those two
//     is both safe and the only way an inactive project's open editor
//     buffers ever learn a file changed underneath them.
// ============================================================================

/**
 * Start (or keep alive) a content-only background watch for a rail project
 * that is registered in a window but not currently visible: forwards
 * `file-changed-on-disk` / `file-deleted`, never pushes a file tree rebuild,
 * and keeps GitRefWatcher running for it (idempotent if already running).
 *
 * Called both when a path is first registered as warm
 * (`workspace:register-additional`) and when the previously-active path is
 * demoted during a rail switch (`workspace:set-active`).
 */
export function startWarmWorkspaceWatch(workspacePath: string): void {
    optimizedWorkspaceWatcher.startBackground(workspacePath).catch((error) => {
        logger.workspaceWatcher.error('Failed to start background workspace watch:', error);
    });
    gitRefWatcher.start(workspacePath).catch((error) => {
        logger.workspaceWatcher.error('Failed to start GitRefWatcher for warm project:', error);
    });
}

/**
 * Release the content-only background watch for a path that is being
 * promoted to a window's full/active watch. Deliberately does NOT touch
 * GitRefWatcher: `startWorkspaceWatcher` starts it for the active path
 * (idempotent no-op if `startWarmWorkspaceWatch` already had it running),
 * and it should keep running uninterrupted across the promotion rather than
 * being stopped and immediately restarted.
 */
export function releaseWarmWatchOnPromotion(workspacePath: string): void {
    optimizedWorkspaceWatcher.stopBackground(workspacePath);
}

/**
 * Fully release the resources started by `startWarmWorkspaceWatch` because a
 * path is no longer referenced by any window (closed from the rail). Callers
 * must gate this on `!anyWindowReferencesWorkspace(path)` first -- see
 * `workspace:unregister-additional` in MultiProjectRailHandlers.ts.
 *
 * Uses `releaseAllBackgroundRefs`, NOT a plain decrement: every caller has
 * already proven no window references this path anymore, which can be true
 * while `startWarmWorkspaceWatch` was called more than once for it (two
 * windows both kept it warm). A plain per-caller decrement only ever gets
 * called once here -- by definition, the boolean gate flips to "unreferenced"
 * exactly once, on whichever window's release happens last -- so it would
 * never fully unwind a refcount above 1 and would leak the bus subscription.
 */
export function stopWarmWorkspaceWatch(workspacePath: string): void {
    optimizedWorkspaceWatcher.releaseAllBackgroundRefs(workspacePath);
    gitRefWatcher.stop(workspacePath).catch((error) => {
        logger.workspaceWatcher.error('Failed to stop GitRefWatcher:', error);
    });
}

// Stop watching a workspace
export function stopWorkspaceWatcher(windowId: number) {
    // Stop project file sync for any workspace this window referenced
    // (primary or rail-warm additional paths) when no other window still
    // references it.
    const state = windowStates.get(windowId);
    if (state) {
        const referencedPaths = new Set<string>();
        if (state.workspacePath) referencedPaths.add(state.workspacePath);
        state.additionalWorkspacePaths?.forEach((p) => referencedPaths.add(p));

        for (const path of referencedPaths) {
            let otherWindowUsesWorkspace = false;
            for (const [otherId, otherState] of windowStates) {
                if (otherId === windowId) continue;
                if (otherState.workspacePath === path || otherState.additionalWorkspacePaths?.includes(path)) {
                    otherWindowUsesWorkspace = true;
                    break;
                }
            }
            if (!otherWindowUsesWorkspace) {
                stopProjectFileSync(path);
            }
        }
    }

    optimizedWorkspaceWatcher.stop(windowId);

    // Sweep orphaned warm-project watches: a path can end up backgrounded
    // (via startWarmWorkspaceWatch, called both from register-additional and
    // from the demote step in workspace:set-active) and then never
    // explicitly released if its owning window closes outright rather than
    // going through workspace:unregister-additional. This runs on every
    // call (switch, unregister, window close) but is a no-op unless a
    // background path has actually gone unreferenced, so it's cheap; it is
    // the only reliable place to catch the window-close case, since by the
    // time WindowManager's 'closed' handler runs, `windowStates` no longer
    // has an entry for this window to read paths off of.
    //
    // `releaseAllBackgroundRefs`, not `stopBackground`: this loop has already
    // proven `!anyWindowReferencesWorkspace(path)`, so whatever the refcount
    // is, there is no live window left to need the subscription -- a plain
    // decrement would leak it when more than one window had kept the path
    // warm (see the leak this replaced, NIM single-window-multi-project
    // review Fix 1).
    for (const path of optimizedWorkspaceWatcher.getBackgroundWatchPaths()) {
        if (anyWindowReferencesWorkspace(path)) continue;
        optimizedWorkspaceWatcher.releaseAllBackgroundRefs(path);
        gitRefWatcher.stop(path).catch((error) => {
            logger.workspaceWatcher.error('Failed to stop orphaned GitRefWatcher:', error);
        });
    }
    // Note: gitRefWatcher for a path that is still its window's *active*
    // (never-backgrounded) path at the moment that window closes is not
    // caught by the sweep above -- it was never demoted to a background
    // watch, so it isn't in `getBackgroundWatchPaths()`. That is pre-existing
    // behavior (gitRefWatcher has always only fully stopped at app quit via
    // stopAllWorkspaceWatchers) and releasing it here would need the
    // window's pre-close path list, which WindowManager.ts already captures
    // as `savedState` for its own doc/fs-service cleanup -- see the 'closed'
    // handler there for the equivalent pattern.
}

// Get workspace watcher info for debugging
export function getWorkspaceWatcherInfo(windowId: number): any {
    return optimizedWorkspaceWatcher.getStats();
}

// Restart the workspace watcher
export function restartWorkspaceWatcher(window: BrowserWindow, workspacePath: string) {
    const windowId = getWindowId(window);
    if (windowId === null) {
        logger.workspaceWatcher.error('Failed to find custom window ID');
        return;
    }
    logger.workspaceWatcher.info(`Restarting workspace watcher for: ${workspacePath}`);

    // Stop existing watcher
    stopWorkspaceWatcher(windowId);

    // Start new watcher
    startWorkspaceWatcher(window, workspacePath);
}

// Stop all workspace watchers (used during app quit)
export async function stopAllWorkspaceWatchers() {
    console.log('[WorkspaceWatcher] stopAllWorkspaceWatchers called');
    logger.workspaceWatcher.info('Stopping all workspace watchers');

    // Stop all project file sync subscriptions
    for (const workspacePath of projectSyncSubscriptions.keys()) {
        stopProjectFileSync(workspacePath);
    }

    try {
        await Promise.all([
            optimizedWorkspaceWatcher.stopAll(),
            gitRefWatcher.stopAll(),
            workspaceEventBus.stopAll(),
        ]);
        console.log('[WorkspaceWatcher] stopAll completed');
    } catch (error) {
        console.error('[WorkspaceWatcher] Error in stopAll:', error);
        throw error;
    }
}

// ============================================================================
// Project File Sync Integration
// ============================================================================

// Track active project sync subscriptions (workspacePath -> subscriberId)
const projectSyncSubscriptions = new Map<string, string>();

/**
 * Derive a deterministic project ID from a workspace path.
 * Uses SHA-256 so the server never sees the actual path.
 */
function hashProjectId(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Start project file sync for a workspace.
 * Subscribes to WorkspaceEventBus for .md file changes and starts initial sync sweep.
 *
 * Called from startWorkspaceWatcher() when sync is enabled.
 */
export async function startProjectFileSync(workspacePath: string): Promise<void> {
  if (!isSyncEnabled()) return;
  if (getReleaseChannel() !== 'alpha') return;

  // Check per-project doc sync opt-in
  const syncConfig = getSessionSyncConfig();
  if (!syncConfig?.docSyncEnabledProjects?.includes(workspacePath)) return;

  // Skip if already subscribed for this workspace
  if (projectSyncSubscriptions.has(workspacePath)) return;

  const projectId = hashProjectId(workspacePath);

  const subscriberId = `project-file-sync-${projectId}`;
  projectSyncSubscriptions.set(workspacePath, subscriberId);

  const service = getProjectFileSyncService();

  // Subscribe to file change events for .md files
  await workspaceEventBus.subscribe(workspacePath, subscriberId, {
    onChange: (filePath) => {
      if (!filePath.endsWith('.md')) return;
      // Skip files that were just written by the sync service (echo suppression)
      if (service.isRecentlyWrittenFromRemote(filePath)) return;
      service.handleFileSaved(filePath, workspacePath, projectId).catch(err => {
        logger.main.error('[ProjectFileSync] handleFileSaved failed:', err);
      });
    },
    onAdd: (filePath) => {
      if (!filePath.endsWith('.md')) return;
      if (service.isRecentlyWrittenFromRemote(filePath)) return;
      service.handleFileSaved(filePath, workspacePath, projectId).catch(err => {
        logger.main.error('[ProjectFileSync] handleFileSaved (add) failed:', err);
      });
    },
    onUnlink: (filePath) => {
      if (!filePath.endsWith('.md')) return;
      // Skip deletes the sync service itself just performed (remote delete echo)
      if (service.isRecentlyWrittenFromRemote(filePath)) return;
      service.handleFileDeletedByPath(filePath, workspacePath, projectId);
    },
  });

  // Start initial sync sweep (non-blocking)
  service.syncProject(workspacePath, projectId).catch(err => {
    logger.main.error('[ProjectFileSync] syncProject failed:', err);
  });

  // logger.main.info(`[ProjectFileSync] Started sync for ${path.basename(workspacePath)} (projectId: ${projectId.slice(0, 8)}...)`);
}

/**
 * Push a newly created/saved markdown document to project sync immediately,
 * bypassing the file watcher. Called when the app itself writes a document
 * (e.g. the createDocument AI tool) so a new design doc syncs to mobile right
 * away rather than waiting on a best-effort OS watcher event.
 *
 * No-op if the workspace isn't an active doc-sync subscriber, so the gating
 * (alpha channel + per-project opt-in) established in startProjectFileSync
 * still holds.
 */
export function pushNewDocumentToSync(filePath: string, workspacePath: string): void {
  if (!filePath.endsWith('.md')) return;
  if (!projectSyncSubscriptions.has(workspacePath)) return;

  const projectId = hashProjectId(workspacePath);
  getProjectFileSyncService()
    .pushLocalFileNow(filePath, workspacePath, projectId)
    .catch(err => {
      logger.main.error('[ProjectFileSync] pushNewDocumentToSync failed:', err);
    });
}

/**
 * Stop project file sync for a workspace.
 */
function stopProjectFileSync(workspacePath: string): void {
  const subscriberId = projectSyncSubscriptions.get(workspacePath);
  if (!subscriberId) return;

  workspaceEventBus.unsubscribe(workspacePath, subscriberId);
  projectSyncSubscriptions.delete(workspacePath);

  getProjectFileSyncService().disconnectProject(hashProjectId(workspacePath));
}

/**
 * Stop ALL project file sync subscriptions.
 *
 * Must be called whenever sync is torn down (SyncManager.shutdownSync), not
 * just at window close: a sync reinitialize (any sync:set-config) creates a
 * new provider with no room connections, and startProjectFileSync would
 * otherwise early-return on the stale subscription entry and never reconnect
 * the project — leaving every later save queued to a room that never opens.
 */
export function stopAllProjectFileSync(): void {
  for (const workspacePath of [...projectSyncSubscriptions.keys()]) {
    stopProjectFileSync(workspacePath);
  }
}

/**
 * Doc sync status for a workspace, for settings-UI feedback on the Docs toggle.
 */
export function getDocSyncStatusForWorkspace(workspacePath: string): {
  subscribed: boolean;
  connected: boolean;
  fileCount: number;
} {
  const subscribed = projectSyncSubscriptions.has(workspacePath);
  const stats = getProjectFileSyncService().getProjectStats(hashProjectId(workspacePath));
  return { subscribed, ...stats };
}
