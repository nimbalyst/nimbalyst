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
 *
 * It also owns attach/detach for multi-root workspaces. An attached folder is
 * NOT a rail project: it has no identity of its own (no settings entry, no
 * tabs, no sessions) and lives only as an extra root of its primary workspace.
 * The service wiring is the same though, which is why it sits here.
 *
 * - `workspace:attach-folder` -- add a root to the primary workspace.
 * - `workspace:detach-folder` -- remove it. Tabs opened from it stay open.
 * - `workspace:get-folders` -- the workspace's roots, primary first.
 */

import { BrowserWindow, dialog } from 'electron';
import { basename } from 'path';
import { existsSync, statSync } from 'fs';
import { safeHandle } from '../utils/ipcRegistry';
import { registerRailProjectDragHandlers } from './RailProjectDragHandlers';
import {
    getWindowId,
    windowStates,
    documentServices,
} from '../window/WindowManager';
import {
  startRootWatcher,
  startWorkspaceWatcher,
  stopRootWatcher,
  stopWorkspaceWatcher,
} from '../file/WorkspaceWatcher.ts';
import { anyWindowReferencesWorkspace, resolveDocumentServicePath, windows } from '../window/windowState';
import { ElectronDocumentService, setupDocumentServiceHandlers } from '../services/ElectronDocumentService';
import { ElectronFileSystemService } from '../services/ElectronFileSystemService';
import { clearWorkspaceRepoCache } from '../services/workspaceRepos';
import { addNimAssetRoot } from '../protocols/nimAssetProtocol';
import { addNimPreviewWorkspaceRoot } from '../protocols/nimPreviewProtocol';
import { getMcpConfigService } from '../index';
import {
  addToRecentItems,
  attachFolderToWorkspace,
  detachFolderFromWorkspace,
  getWorkspaceNavigationHistory,
  getWorkspaceRoots,
  MAX_ATTACHED_FOLDERS,
} from '../utils/store';
import { navigationHistoryService } from '../services/NavigationHistoryService';
import {
  setFileSystemService,
  clearFileSystemService,
  setFileSystemServiceFor,
  clearFileSystemServiceFor,
} from '@nimbalyst/runtime';
import { logger } from '../utils/logger';
import { notifyWorkspaceUsageChanged, pruneUnusedGitWatchers, releaseWhenWorkspaceUnused } from '../file/GitWatcherLifecycle';

// Re-uses the same Maps that WindowManager populates. WindowManager exports
// `documentServices` only; the file-system service map lives module-internal
// there. We expose it via a pair of accessor functions on WindowManager
// (added below in this PR).
import { fileSystemServices, getFileSystemService } from '../window/serviceRegistry';

function resolveDocumentServiceForEvent(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent, workspacePath?: string): ElectronDocumentService | null {
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    if (!browserWindow) return null;
    const windowId = getWindowId(browserWindow);
    if (windowId === null) return null;
    const state = windowStates.get(windowId);
    // A request that names its project (#1822) is answered for that project,
    // whichever one the rail has marked active by now.
    const path = resolveDocumentServicePath(state, workspacePath);
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

/**
 * Windows currently showing a workspace, as `[windowId, window]` pairs.
 * Attaching or detaching a folder has to reach every one of them -- the same
 * project can be open in more than one window, and each keeps its own watcher
 * registration.
 */
function windowsShowingWorkspace(workspacePath: string): Array<[number, BrowserWindow]> {
    const matches: Array<[number, BrowserWindow]> = [];
    for (const [windowId, state] of windowStates) {
        if (state.workspacePath !== workspacePath && !state.additionalWorkspacePaths?.includes(workspacePath)) {
            continue;
        }
        const window = windows.get(windowId);
        if (window && !window.isDestroyed()) {
            matches.push([windowId, window]);
        }
    }
    return matches;
}

export function registerMultiProjectRailHandlers(): void {
    registerRailProjectDragHandlers();

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
        notifyWorkspaceUsageChanged();

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

        // The startup project can close while other rail projects remain.
        // Move the primary reference so it no longer pins the closed project.
        if (state.workspacePath === workspacePath) {
            state.workspacePath = state.additionalWorkspacePaths?.[0] ?? null;
            state.additionalWorkspacePaths = state.additionalWorkspacePaths?.filter(path => path !== state.workspacePath);
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

        await pruneUnusedGitWatchers();

        // Free services only if no other window references the path.
        releaseWhenWorkspaceUnused(workspacePath, () => {
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
        });

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

        // null means the active project just closed; the promoted primary
        // still needs its file watcher started. Only legacy state omits this field.
        const previousActive = state.activeWorkspacePath === undefined ? state.workspacePath : state.activeWorkspacePath;
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

    safeHandle('workspace:get-folders', async (_event, data: { workspacePath: string }) => {
        const { workspacePath } = data ?? {};
        if (!workspacePath || typeof workspacePath !== 'string') {
            return { success: false, error: 'workspacePath required' };
        }
        return { success: true, folders: getWorkspaceRoots(workspacePath) };
    });

    safeHandle(
        'workspace:attach-folder',
        async (event, data: { workspacePath: string; folderPath: string }) => {
            const { workspacePath, folderPath } = data ?? {};
            if (!workspacePath || typeof workspacePath !== 'string') {
                return { success: false, error: 'workspacePath required' };
            }
            if (!folderPath || typeof folderPath !== 'string') {
                return { success: false, error: 'folderPath required' };
            }
            if (!existsSync(folderPath) || !statSync(folderPath).isDirectory()) {
                return { success: false, error: 'Folder does not exist' };
            }

            const window = BrowserWindow.fromWebContents(event.sender);
            if (!window) return { success: false, error: 'No window for event sender' };

            // Attaching hands this project's agents read/write access to another
            // folder on disk, so it is confirmed here rather than in the picker:
            // the picker's `message` option only renders on macOS, and the
            // drag-drop / command routes never open a picker at all.
            const consent = await dialog.showMessageBox(window, {
                type: 'question',
                buttons: ['Attach Folder', 'Cancel'],
                defaultId: 0,
                cancelId: 1,
                title: 'Attach Folder to Workspace',
                message: `Attach "${basename(folderPath)}" to "${basename(workspacePath)}"?`,
                detail:
                    'The attached folder becomes part of this project and inherits its agent '
                    + 'trust level. Agents in this project will be able to read and write it.',
            });
            if (consent.response !== 0) {
                return { success: false, reason: 'declined', error: undefined };
            }

            const result = attachFolderToWorkspace(workspacePath, folderPath);
            if (!result.ok) {
                return {
                    success: false,
                    reason: result.reason,
                    error:
                        result.reason === 'cap-reached'
                            ? `A workspace can hold at most ${MAX_ATTACHED_FOLDERS} attached folders`
                            : result.reason === 'already-attached'
                              ? 'Folder is already attached'
                              : 'Folder is already this workspace',
                    folders: [workspacePath, ...result.attachedFolders],
                };
            }

            // Same service wiring as a warm rail project: the attached folder
            // needs a DocumentService and FileSystemService before the explorer
            // can list it or an agent can read it.
            ensureServicesForPath(window, folderPath);

            // Only the window showing this workspace watches the new root; a
            // window on a different project has no tree to update.
            // A newly attached root has never been scanned for repos.
            clearWorkspaceRepoCache(folderPath);

            const folders = [workspacePath, ...result.attachedFolders];
            for (const [, listener] of windowsShowingWorkspace(workspacePath)) {
                startRootWatcher(listener, folderPath, workspacePath);
                listener.webContents.send('workspace:folders-changed', { workspacePath, folders });
            }

            // Deliberately no per-folder trust flag: an attached folder is part
            // of this workspace, and agent permissions resolve from the
            // session's workspace (the primary root), so it inherits that
            // project's trust level. The renderer states that in the picker
            // rather than prompting again per folder.
            return { success: true, folders };
        },
    );

    safeHandle(
        'workspace:detach-folder',
        async (_event, data: { workspacePath: string; folderPath: string }) => {
            const { workspacePath, folderPath } = data ?? {};
            if (!workspacePath || typeof workspacePath !== 'string') {
                return { success: false, error: 'workspacePath required' };
            }
            if (!folderPath || typeof folderPath !== 'string') {
                return { success: false, error: 'folderPath required' };
            }

            // Drop the attachment first: both the git-ref watcher below and the
            // service teardown ask `anyWindowReferencesWorkspace`, which reads
            // attachments out of the store. Stopping first would see this very
            // attachment and conclude the folder is still in use.
            const attachedFolders = detachFolderFromWorkspace(workspacePath, folderPath);
            clearWorkspaceRepoCache(folderPath);

            const folders = [workspacePath, ...attachedFolders];
            for (const [listenerWindowId, listener] of windowsShowingWorkspace(workspacePath)) {
                stopRootWatcher(listenerWindowId, folderPath);
                listener.webContents.send('workspace:folders-changed', { workspacePath, folders });
            }

            // Free services only if nothing else still shows this folder --
            // another window may have it attached, or open as a rail project.
            if (!anyWindowReferencesWorkspace(folderPath)) {
                const docService = documentServices.get(folderPath);
                if (docService) {
                    docService.destroy();
                    documentServices.delete(folderPath);
                }

                const fsService = getFileSystemService(folderPath);
                if (fsService) {
                    fsService.destroy();
                    fileSystemServices.delete(folderPath);
                    clearFileSystemServiceFor(folderPath);
                }

                try {
                    getMcpConfigService()?.stopWatchingWorkspaceConfig(folderPath);
                } catch (error) {
                    logger.main.error('[MultiRoot] Error stopping MCP config watcher:', error);
                }
            }

            return { success: true, folders };
        },
    );

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
