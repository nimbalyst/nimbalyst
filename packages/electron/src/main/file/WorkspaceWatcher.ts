import { BrowserWindow } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { getWindowId, windowStates } from '../window/WindowManager';
import { clearGitStatusCache } from '../ipc/GitStatusHandlers';
import { optimizedWorkspaceWatcher } from './OptimizedWorkspaceWatcher';
import { gitRefWatcher } from './GitRefWatcher';
import { initGitWatcherLifecycle, pruneUnusedGitWatchers } from './GitWatcherLifecycle';
import * as workspaceEventBus from './WorkspaceEventBus';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { readdirSync } from 'fs';
import path from "path";
import { createHash } from 'crypto';
import { getProjectFileSyncService } from '../services/ProjectFileSyncService';
import { isProjectSyncPath } from '../services/sync/projectSyncWikiRules';
import { isSyncEnabled } from '../services/SyncManager';
import { getReleaseChannel, getSessionSyncConfig, getWorkspaceRoots } from '../utils/store';
import { anyWindowReferencesWorkspace } from '../window/windowState';
import { clearWorkspaceRepoCache, listReposForRoot } from '../services/workspaceRepos';

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

/**
 * The repos each root's git-ref watchers were started for. A detach stops
 * exactly these instead of rescanning, which would miss a nested clone the
 * cleared discovery cache no longer answers for synchronously.
 */
interface RootRefWatchers {
    owningWorkspace: string;
    repos: string[];
}
const refWatchersByRoot = new Map<string, RootRefWatchers>();

function startRefWatchers(rootPath: string, owningWorkspace: string): void {
    const entry: RootRefWatchers = { owningWorkspace, repos: [] };
    refWatchersByRoot.set(rootPath, entry);
    void listReposForRoot(rootPath).then((repos) => {
        if (refWatchersByRoot.get(rootPath) !== entry) return; // stopped or restarted meanwhile
        entry.repos = repos;
        for (const repoPath of repos) {
            gitRefWatcher.start(repoPath, owningWorkspace).catch((error) => {
                logger.workspaceWatcher.error('Failed to start GitRefWatcher:', error);
            });
        }
    });
}

/**
 * A root's ignore rules decide which nested clones count as its repos, so a
 * `.gitignore` change rescans the root, moves the ref watchers to match, and
 * tells the repo pickers.
 */
function refreshRootRepos(rootPath: string): void {
    const entry = refWatchersByRoot.get(rootPath);
    if (!entry) return;
    clearWorkspaceRepoCache(rootPath);
    void listReposForRoot(rootPath).then((repos) => {
        if (refWatchersByRoot.get(rootPath) !== entry) return;
        const added = repos.filter((repo) => !entry.repos.includes(repo));
        const removed = entry.repos.filter((repo) => !repos.includes(repo));
        if (added.length === 0 && removed.length === 0) return;
        entry.repos = repos;
        for (const repoPath of added) {
            gitRefWatcher.start(repoPath, entry.owningWorkspace).catch((error) => {
                logger.workspaceWatcher.error('Failed to start GitRefWatcher:', error);
            });
        }
        for (const repoPath of removed) {
            gitRefWatcher.stop(repoPath).catch((error) => {
                logger.workspaceWatcher.error('Failed to stop GitRefWatcher:', error);
            });
        }
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) {
                window.webContents.send('workspace:repos-changed', { workspacePath: rootPath });
            }
        }
    });
}

workspaceEventBus.setGitignoreChangeHandler((workspacePath: string) => {
    clearGitStatusCache(workspacePath);
    refreshRootRepos(workspacePath);

    for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
            window.webContents.send('git:status-changed', { workspacePath });
        }
    }
});

// Set up IPC handlers for folder expand/collapse events
export function registerWorkspaceWatcherHandlers() {
    initGitWatcherLifecycle();
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

/**
 * Start watching a workspace for changes: the primary root and every folder
 * attached to it. Each root gets its own tree watcher and its own git-ref
 * watcher, because roots have independent `.gitignore` files and may be
 * separate repos (or no repo at all).
 */
export function startWorkspaceWatcher(window: BrowserWindow, workspacePath: string) {
    const windowId = getWindowId(window);
    if (windowId === null) {
        logger.workspaceWatcher.error('Failed to find custom window ID');
        return;
    }

    for (const rootPath of getWorkspaceRoots(workspacePath)) {
        startRootWatcher(window, rootPath, workspacePath);
    }

    // Project file sync is a workspace-level (primary root) concern: it syncs
    // the project's own .md documents to mobile, and attached folders have no
    // workspace identity to sync under.
    startProjectFileSync(workspacePath).catch((error) => {
        logger.workspaceWatcher.error('Failed to start ProjectFileSync:', error);
    });
}

/**
 * Start watching one root. Idempotent, and additive -- the window's other roots
 * keep running. Called for each root at workspace open and again when a folder
 * is attached.
 */
export function startRootWatcher(window: BrowserWindow, rootPath: string, owningWorkspace?: string) {
    // Use optimized chokidar-based workspace watcher
    void optimizedWorkspaceWatcher.start(window, rootPath).catch(error => {
        logger.workspaceWatcher.error('Failed to register workspace watcher:', error);
    });

    // One git-ref watcher per repo the root contains, not per root: a root may
    // be no repo at all (nothing to watch) or a container holding several
    // (watching only the container would miss every commit).
    //
    // The owning workspace goes with it: git status is routed per repo, but
    // pending reviews are workspace-scoped, and a repo under an attached folder
    // has no workspace identity of its own to broadcast under.
    startRefWatchers(rootPath, owningWorkspace ?? rootPath);
}

/**
 * Stop watching one root, leaving the window's other roots alone. Called when a
 * folder is detached.
 *
 * The git-ref watcher is keyed by path rather than window, so it is only
 * stopped when no window still shows this root.
 */
export function stopRootWatcher(windowId: number, rootPath: string) {
    optimizedWorkspaceWatcher.stopRoot(windowId, rootPath);

    if (!anyWindowReferencesWorkspace(rootPath)) {
        const entry = refWatchersByRoot.get(rootPath);
        refWatchersByRoot.delete(rootPath);
        for (const repoPath of entry?.repos ?? []) {
            gitRefWatcher.stop(repoPath).catch((error) => {
                logger.workspaceWatcher.error('Failed to stop GitRefWatcher:', error);
            });
        }
    }
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
    void pruneUnusedGitWatchers().catch(error => {
        logger.workspaceWatcher.error('Failed to release unused Git watchers:', error);
    });
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
      if (!isProjectSyncPath(filePath, workspacePath)) return;
      // Skip files that were just written by the sync service (echo suppression)
      if (service.isRecentlyWrittenFromRemote(filePath)) return;
      service.handleFileSaved(filePath, workspacePath, projectId).catch(err => {
        logger.main.error('[ProjectFileSync] handleFileSaved failed:', err);
      });
    },
    onAdd: (filePath) => {
      if (!isProjectSyncPath(filePath, workspacePath)) return;
      if (service.isRecentlyWrittenFromRemote(filePath)) return;
      service.handleFileSaved(filePath, workspacePath, projectId).catch(err => {
        logger.main.error('[ProjectFileSync] handleFileSaved (add) failed:', err);
      });
    },
    onUnlink: (filePath) => {
      if (!isProjectSyncPath(filePath, workspacePath)) return;
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
  if (!isProjectSyncPath(filePath, workspacePath)) return;
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
