/**
 * IPC handlers for the multi-project rail.
 *
 * The rail lets a single Electron window host several workspace projects
 * side by side. Switching between them must not tear down the inactive
 * projects' main-process services (file watchers, document caches, MCP
 * config watchers); these handlers manage the per-window registration so
 * services for warm projects stay alive.
 *
 * - `workspace:register-additional` -- start tracking a path as warm in
 *   this window. Creates DocumentService / FileSystemService /
 *   WorkspaceEventBus subscriptions if they don't already exist.
 * - `workspace:unregister-additional` -- the user closed the project from
 *   the rail. Drops services only if no other window references the path.
 * - `workspace:set-active` -- update the visible project in a window
 *   without spawning a new BrowserWindow (the legacy `project-selected`
 *   path stays for the "open in new window" escape hatch).
 */

import { BrowserWindow } from 'electron';
import { basename } from 'path';
import { existsSync } from 'fs';
import { safeHandle } from '../utils/ipcRegistry';
import {
    getWindowId,
    windowStates,
    documentServices,
} from '../window/WindowManager';
import { startWorkspaceWatcher, stopWorkspaceWatcher } from '../file/WorkspaceWatcher.ts';
import { anyWindowReferencesWorkspace } from '../window/windowState';
import { ElectronDocumentService, setupDocumentServiceHandlers } from '../services/ElectronDocumentService';
import { ElectronFileSystemService } from '../services/ElectronFileSystemService';
import { addNimAssetRoot } from '../protocols/nimAssetProtocol';
import { addNimPreviewWorkspaceRoot } from '../protocols/nimPreviewProtocol';
import { getMcpConfigService } from '../index';
import { addToRecentItems, getWorkspaceNavigationHistory } from '../utils/store';
import { navigationHistoryService } from '../services/NavigationHistoryService';
import {
  setFileSystemService,
  clearFileSystemService,
  setFileSystemServiceFor,
  clearFileSystemServiceFor,
} from '@nimbalyst/runtime';
import { logger } from '../utils/logger';

// Re-uses the same Maps that WindowManager populates. WindowManager exports
// `documentServices` only; the file-system service map lives module-internal
// there. We expose it via a pair of accessor functions on WindowManager
// (added below in this PR).
import { fileSystemServices, getFileSystemService } from '../window/serviceRegistry';

function resolveDocumentServiceForEvent(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): ElectronDocumentService | null {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (!browserWindow) return null;
    const windowId = getWindowId(browserWindow);
    if (windowId === null) return null;
    const state = windowStates.get(windowId);
    const path = state?.activeWorkspacePath ?? state?.workspacePath ?? null;
    if (!path) return null;
    return documentServices.get(path) ?? null;
}

/**
 * Ensure per-workspace services exist for `workspacePath`. Idempotent — if
 * another window already created the services, this just makes sure the
 * window-side state is wired up.
 *
 * NOTE: Does NOT start the workspace file watcher and does NOT flip the
 * runtime-global `FileSystemService`. Both belong to the "active path" of
 * a window and are managed by the `workspace:set-active` handler. Calling
 * either here would tear down whatever the active path is currently using
 * (the watcher is single-active-per-window, the FS getter is a singleton).
 */
function ensureServicesForPath(window: BrowserWindow, workspacePath: string): void {
    if (!existsSync(workspacePath)) {
        logger.main.warn('[MultiProject] Refusing to register non-existent path:', workspacePath);
        return;
    }

    addNimAssetRoot(workspacePath);
    addNimPreviewWorkspaceRoot(workspacePath);

    if (!documentServices.has(workspacePath)) {
        const docService = new ElectronDocumentService(workspacePath);
        documentServices.set(workspacePath, docService);
        setupDocumentServiceHandlers(resolveDocumentServiceForEvent);
    }

    if (!fileSystemServices.has(workspacePath)) {
        const fileSystemService = new ElectronFileSystemService(workspacePath);
        fileSystemServices.set(workspacePath, fileSystemService);
        // Per-path runtime registry mirrors the electron-side map so AI
        // tool dispatch (fileTools.searchFiles / listFiles / readFile)
        // running inside a session whose workspace is currently INACTIVE
        // in the rail still resolves to the right service. Without this,
        // the runtime-global singleton (set on rail switch to the active
        // workspace) would silently route those calls to the wrong fs.
        setFileSystemServiceFor(workspacePath, fileSystemService);
    }

    // Restore navigation history (no-op if already restored for this window).
    const windowId = getWindowId(window);
    if (windowId !== null) {
        const navHistory = getWorkspaceNavigationHistory(workspacePath);
        if (navHistory) {
            navigationHistoryService.restoreNavigationState(windowId, navHistory);
        }
    }
}

export function registerMultiProjectRailHandlers(): void {
    safeHandle('workspace:register-additional', async (event, data: { workspacePath: string }) => {
        const { workspacePath } = data;
        if (!workspacePath || typeof workspacePath !== 'string') {
            return { success: false, error: 'workspacePath required' };
        }

        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return { success: false, error: 'No window for event sender' };
        const windowId = getWindowId(window);
        if (windowId === null) return { success: false, error: 'No windowId' };

        const state = windowStates.get(windowId);
        if (!state) return { success: false, error: 'No window state' };

        // Skip if this window already references the path (primary or additional).
        if (state.workspacePath === workspacePath || state.additionalWorkspacePaths?.includes(workspacePath)) {
            return { success: true, alreadyRegistered: true };
        }

        const additional = state.additionalWorkspacePaths ?? [];
        state.additionalWorkspacePaths = [...additional, workspacePath];

        ensureServicesForPath(window, workspacePath);
        addToRecentItems('workspaces', workspacePath, basename(workspacePath));

        return { success: true };
    });

    safeHandle('workspace:unregister-additional', async (event, data: { workspacePath: string }) => {
        const { workspacePath } = data;
        if (!workspacePath || typeof workspacePath !== 'string') {
            return { success: false, error: 'workspacePath required' };
        }

        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return { success: false, error: 'No window for event sender' };
        const windowId = getWindowId(window);
        if (windowId === null) return { success: false, error: 'No windowId' };

        const state = windowStates.get(windowId);
        if (!state) return { success: false, error: 'No window state' };

        if (state.additionalWorkspacePaths?.includes(workspacePath)) {
            state.additionalWorkspacePaths = state.additionalWorkspacePaths.filter((p) => p !== workspacePath);
        }

        // If this window still references the path as primary, leave services alone.
        if (state.workspacePath === workspacePath) {
            return { success: true, stillPrimary: true };
        }

        // If the path being closed was this window's active path, tear down
        // the active-only state (file watcher + global FS service). The
        // renderer is expected to call `workspace:set-active` for the
        // replacement path right after this; that call will start the
        // watcher and flip the FS global to the new active project.
        const wasActive = state.activeWorkspacePath === workspacePath;
        if (wasActive) {
            stopWorkspaceWatcher(windowId);
            state.activeWorkspacePath = null;
            clearFileSystemService();
        }

        // Free services only if no other window references the path.
        if (!anyWindowReferencesWorkspace(workspacePath)) {
            const docService = documentServices.get(workspacePath);
            if (docService) {
                docService.destroy();
                documentServices.delete(workspacePath);
            }

            const fsService = getFileSystemService(workspacePath);
            if (fsService) {
                fsService.destroy();
                fileSystemServices.delete(workspacePath);
                // Drop the runtime-side per-path registration too so a
                // future AI tool call cannot resolve a destroyed service.
                clearFileSystemServiceFor(workspacePath);
            }

            try {
                const mcpService = getMcpConfigService();
                mcpService?.stopWatchingWorkspaceConfig(workspacePath);
            } catch (error) {
                logger.main.error('[MultiProject] Error stopping MCP config watcher:', error);
            }
        }

        return { success: true };
    });

    safeHandle('workspace:set-active', async (event, data: { workspacePath: string }) => {
        const { workspacePath } = data;
        if (!workspacePath || typeof workspacePath !== 'string') {
            return { success: false, error: 'workspacePath required' };
        }

        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return { success: false, error: 'No window for event sender' };
        const windowId = getWindowId(window);
        if (windowId === null) return { success: false, error: 'No windowId' };

        const state = windowStates.get(windowId);
        if (!state) return { success: false, error: 'No window state' };

        // Path must be registered in this window before it can be active.
        if (state.workspacePath !== workspacePath && !state.additionalWorkspacePaths?.includes(workspacePath)) {
            return { success: false, error: 'workspacePath not registered in this window' };
        }

        const previousActive = state.activeWorkspacePath ?? state.workspacePath;
        if (previousActive === workspacePath) {
            // Idempotent: already active. Make sure the global FS service is
            // pointing at the right place (covers the case of an early call
            // before the watcher was started, e.g. during create-window
            // bootstrap).
            const svc = fileSystemServices.get(workspacePath);
            if (svc) setFileSystemService(svc);
            return { success: true, alreadyActive: true };
        }

        // Transition: stop the watcher tied to the previous active path,
        // start a fresh one for the new active path. The watcher API is
        // single-active-per-window, so we always tear down + restart on
        // every flip. Watcher is the only "active-only" main-process
        // resource (services in `documentServices`/`fileSystemServices`
        // remain warm for inactive rail projects).
        stopWorkspaceWatcher(windowId);
        state.activeWorkspacePath = workspacePath;
        startWorkspaceWatcher(window, workspacePath);

        // Flip the runtime-global FileSystemService so AI tools that resolve
        // via `getFileSystemService()` (no-arg) read from the visible
        // project. Sessions running in inactive rail projects must resolve
        // their FS service via the per-path map (`fileSystemServices.get`)
        // — see docs/AI_PROVIDER_TYPES.md.
        const fsService = fileSystemServices.get(workspacePath);
        if (fsService) {
            setFileSystemService(fsService);
        } else {
            logger.main.warn(
                '[MultiProject] set-active without registered FileSystemService for path:',
                workspacePath,
            );
        }

        return { success: true };
    });

    // Renderer asks the host to close this window when the rail goes empty
    // (user closed the last open project). Closing the BrowserWindow lets the
    // app fall back to its initial project-selection flow.
    safeHandle('workspace:close-rail-window', async (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return { success: false, error: 'No window for event sender' };
        window.close();
        return { success: true };
    });
}
