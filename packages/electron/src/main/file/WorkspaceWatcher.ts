import { BrowserWindow } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { getWindowId, windowStates } from '../window/WindowManager';
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
      // Need to look up syncId for this file -- but file is already deleted
      // getSyncId reads from disk, so for deleted files we can't get it.
      // The sync service tracks syncId -> filePath in its state map.
      // For now, deletions are handled by the next sync sweep.
      // TODO: Track filePath -> syncId mapping in ProjectFileSyncService for deletion
    },
  });

  // Start initial sync sweep (non-blocking)
  service.syncProject(workspacePath, projectId).catch(err => {
    logger.main.error('[ProjectFileSync] syncProject failed:', err);
  });

  // logger.main.info(`[ProjectFileSync] Started sync for ${path.basename(workspacePath)} (projectId: ${projectId.slice(0, 8)}...)`);
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
