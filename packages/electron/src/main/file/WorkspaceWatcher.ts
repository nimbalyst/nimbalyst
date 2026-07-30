import { BrowserWindow } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { documentServices, getWindowId, windowStates } from '../window/WindowManager';
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

    // Keep the document metadata cache warm on external .md edits (non-blocking)
    startTrackerMetadataWatch(workspacePath).catch((error) => {
        logger.workspaceWatcher.error('Failed to start tracker metadata watch:', error);
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
                stopTrackerMetadataWatch(path);
            }
        }
    }

    optimizedWorkspaceWatcher.stop(windowId);
    // Note: gitRefWatcher is keyed by workspacePath, not windowId.
    // It will be stopped when stopAllWorkspaceWatchers is called.
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

    for (const workspacePath of [...trackerMetadataWatches.keys()]) {
        stopTrackerMetadataWatch(workspacePath);
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
// Tracker Metadata Refresh
// ============================================================================

/**
 * A workspace-wide watcher already existed on the bus, but none of its
 * subscribers told ElectronDocumentService anything: the file tree consumed
 * `file-changed-on-disk` for open editors only, and `refreshFileMetadata` was
 * reachable only from the in-app save path. That left the tracker metadata
 * cache -- what the Tracker view renders from -- refreshed once per renderer
 * lifetime, so an external edit stayed invisible until the app restarted.
 *
 * `refreshFileMetadata` already fires the metadata + tracker-item watcher
 * events the Tracker view subscribes to, so feeding it here updates the view
 * live with no renderer changes.
 *
 * Note this covers files the bus reports on. Gitignored tracker files get no
 * `change` events, so reads stay honest via the document service's own
 * mtime revalidation rather than this watcher.
 */

/** Coalesces an editor's write-truncate-write burst without feeling laggy. */
const TRACKER_METADATA_DEBOUNCE_MS = 300;

/**
 * Past this many distinct paths in one window, do a single workspace refresh
 * instead of N bounded reads -- a git checkout or bulk agent rewrite otherwise
 * turns into a per-file storm.
 */
const TRACKER_METADATA_BULK_THRESHOLD = 25;

const TRACKER_METADATA_SUBSCRIBER_ID = 'tracker-metadata';

interface TrackerMetadataWatch {
  pendingPaths: Set<string>;
  timer: NodeJS.Timeout | null;
  needsFullRefresh: boolean;
}

const trackerMetadataWatches = new Map<string, TrackerMetadataWatch>();

export async function startTrackerMetadataWatch(workspacePath: string): Promise<void> {
  if (trackerMetadataWatches.has(workspacePath)) return;

  const watch: TrackerMetadataWatch = {
    pendingPaths: new Set(),
    timer: null,
    needsFullRefresh: false,
  };
  trackerMetadataWatches.set(workspacePath, watch);

  const queue = (filePath: string, fullRefresh: boolean): void => {
    if (!filePath.endsWith('.md')) return;

    if (fullRefresh) {
      watch.needsFullRefresh = true;
    } else {
      watch.pendingPaths.add(filePath);
    }

    if (watch.timer) return;
    watch.timer = setTimeout(() => {
      void flushTrackerMetadata(workspacePath);
    }, TRACKER_METADATA_DEBOUNCE_MS);
  };

  try {
    await workspaceEventBus.subscribe(workspacePath, TRACKER_METADATA_SUBSCRIBER_ID, {
      onChange: (filePath) => queue(filePath, false),
      onAdd: (filePath) => queue(filePath, false),
      // There is no per-file removal API on the document service; a workspace
      // refresh diffs mtimes and emits the `removed` metadata events the Tracker
      // view already listens for.
      onUnlink: (filePath) => queue(filePath, true),
    });
  } catch (error) {
    // Drop the entry so a later start can retry rather than early-returning on
    // a registration that never happened.
    trackerMetadataWatches.delete(workspacePath);
    throw error;
  }
}

async function flushTrackerMetadata(workspacePath: string): Promise<void> {
  const watch = trackerMetadataWatches.get(workspacePath);
  if (!watch) return;

  watch.timer = null;
  const paths = [...watch.pendingPaths];
  const fullRefresh = watch.needsFullRefresh || paths.length > TRACKER_METADATA_BULK_THRESHOLD;
  watch.pendingPaths.clear();
  watch.needsFullRefresh = false;

  const documentService = documentServices.get(workspacePath);
  if (!documentService) return;

  try {
    if (fullRefresh) {
      await documentService.refreshWorkspaceData();
      return;
    }
    // Bounded 4KB read behind a hash guard, so the echo of an in-app save that
    // already updated the cache costs a stat and nothing else.
    await Promise.all(paths.map((filePath) => documentService.refreshFileMetadata(filePath)));
  } catch (error) {
    logger.workspaceWatcher.error('Failed to refresh tracker metadata:', error);
  }
}

export function stopTrackerMetadataWatch(workspacePath: string): void {
  const watch = trackerMetadataWatches.get(workspacePath);
  if (!watch) return;

  if (watch.timer) clearTimeout(watch.timer);
  trackerMetadataWatches.delete(workspacePath);
  workspaceEventBus.unsubscribe(workspacePath, TRACKER_METADATA_SUBSCRIBER_ID);
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
