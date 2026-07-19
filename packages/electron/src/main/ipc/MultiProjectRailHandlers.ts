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
import { randomUUID } from 'node:crypto';
import { basename } from 'path';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import {
    createWindow,
    getWindowId,
    windowStates,
    windowFocusOrder,
    documentServices,
} from '../window/WindowManager';
import { startWorkspaceWatcher, stopWorkspaceWatcher } from '../file/WorkspaceWatcher.ts';
import { anyWindowReferencesWorkspace, resolveActiveWorkspacePath } from '../window/windowState';
import { getMcpConfigService } from '../mcpConfigServiceRef';
import { addToRecentItems } from '../utils/store';
import {
  setFileSystemService,
  clearFileSystemService,
  clearFileSystemServiceFor,
} from '@nimbalyst/runtime';
import { logger } from '../utils/logger';
import {
  MAX_OPEN_PROJECT_TABS,
  PROJECT_TAB_MUTATION_CHANNEL,
  type ProjectTabDragRegistration,
  type ProjectTabMutation,
} from '../../shared/projectTabs';
import { ensureWorkspaceTabServices } from '../services/WorkspaceTabServices';
import {
  activateWorkspaceTabContext,
  initializeWorkspaceTabBackground,
  releaseWorkspaceTabBackground,
} from '../services/WorkspaceTabBackground';

// Re-uses the same Maps that WindowManager populates. WindowManager exports
// `documentServices` only; the file-system service map lives module-internal
// there. We expose it via a pair of accessor functions on WindowManager
// (added below in this PR).
import { fileSystemServices, getFileSystemService } from '../window/serviceRegistry';

const PROJECT_TAB_DRAG_TTL_MS = 30_000;
const PROJECT_TAB_DROP_GRACE_MS = 750;
const PROJECT_TAB_PREPARATION_TIMEOUT_MS = 5_000;

interface ActiveProjectTabDrag {
    sourceWindow: BrowserWindow;
    sourceWindowId: number;
    workspacePath: string;
    expiresAt: number;
    cleanupTimer: ReturnType<typeof setTimeout>;
    claimed: boolean;
    claimedDestinationWindowId: number | null;
    moved: boolean;
    ready: boolean;
    preparationError: string | null;
    resultWaiters: Set<() => void>;
    preparationWaiters: Set<() => void>;
}

const activeProjectTabDrags = new Map<string, ActiveProjectTabDrag>();

function removeActiveProjectTabDrag(dragId: string): void {
    const drag = activeProjectTabDrags.get(dragId);
    if (!drag) return;
    clearTimeout(drag.cleanupTimer);
    drag.resultWaiters.forEach((resolve) => resolve());
    drag.preparationWaiters.forEach((resolve) => resolve());
    activeProjectTabDrags.delete(dragId);
}

function pruneExpiredProjectTabDrags(): void {
    const now = Date.now();
    for (const [dragId, drag] of activeProjectTabDrags) {
        if (drag.expiresAt > now) continue;
        removeActiveProjectTabDrag(dragId);
    }
}

function referencesWorkspace(state: { workspacePath: string | null; additionalWorkspacePaths?: string[] }, workspacePath: string): boolean {
    return state.workspacePath === workspacePath
        || state.additionalWorkspacePaths?.includes(workspacePath) === true;
}

function referencedWorkspacePaths(state: { workspacePath: string | null; additionalWorkspacePaths?: string[] }): string[] {
    return [...new Set([state.workspacePath, ...(state.additionalWorkspacePaths ?? [])]
        .filter((path): path is string => typeof path === 'string' && path.length > 0))];
}

function queueProjectTabMutation(
    state: { pendingProjectTabMutations?: ProjectTabMutation[] },
    mutation: ProjectTabMutation,
): void {
    state.pendingProjectTabMutations = [
        ...(state.pendingProjectTabMutations ?? []).filter((pending) => pending.id !== mutation.id),
        mutation,
    ];
}

function sendProjectTabMutation(window: BrowserWindow, mutation: ProjectTabMutation): void {
    try {
        if (typeof window.isDestroyed === 'function' && window.isDestroyed()) return;
        if (typeof window.webContents?.isDestroyed === 'function' && window.webContents.isDestroyed()) return;
        window.webContents?.send?.(PROJECT_TAB_MUTATION_CHANNEL, mutation);
    } catch (error) {
        // Main state and pending mutations are already committed. Live IPC is
        // best-effort; a reloading renderer will consume the durable queue.
        logger.main.warn('[MultiProject] Project tab mutation delivery deferred:', error);
    }
}

function restoreGlobalFileSystemService(excludeWindowId: number): void {
    let bestPath: string | null = null;
    let bestFocusOrder = -1;
    for (const [windowId, state] of windowStates) {
        if (windowId === excludeWindowId) continue;
        const candidatePath = resolveActiveWorkspacePath(state);
        if (!candidatePath || !fileSystemServices.has(candidatePath)) continue;
        const focusOrder = windowFocusOrder.get(windowId) ?? 0;
        if (focusOrder > bestFocusOrder) {
            bestFocusOrder = focusOrder;
            bestPath = candidatePath;
        }
    }

    const service = bestPath ? fileSystemServices.get(bestPath) : null;
    if (service) setFileSystemService(service);
    else clearFileSystemService();
}

function resolveMostRecentlyFocusedWorkspacePath(): string | null {
    let bestPath: string | null = null;
    let bestFocusOrder = -1;
    for (const [windowId, state] of windowStates) {
        const candidatePath = resolveActiveWorkspacePath(state);
        if (!candidatePath) continue;
        const focusOrder = windowFocusOrder.get(windowId) ?? 0;
        if (focusOrder > bestFocusOrder) {
            bestFocusOrder = focusOrder;
            bestPath = candidatePath;
        }
    }
    return bestPath;
}

export function registerMultiProjectRailHandlers(): void {
    safeOn('workspace:begin-project-tab-drag', (event, data: ProjectTabDragRegistration) => {
        pruneExpiredProjectTabDrags();
        if (
            data?.version !== 1
            || typeof data.dragId !== 'string'
            || data.dragId.length === 0
            || typeof data.workspacePath !== 'string'
            || data.workspacePath.length === 0
        ) {
            return;
        }

        const sourceWindow = BrowserWindow.fromWebContents(event.sender);
        if (!sourceWindow) return;
        const sourceWindowId = getWindowId(sourceWindow);
        if (sourceWindowId === null) return;
        const sourceState = windowStates.get(sourceWindowId);
        if (!sourceState || !referencesWorkspace(sourceState, data.workspacePath)) return;

        removeActiveProjectTabDrag(data.dragId);
        const drag: ActiveProjectTabDrag = {
            sourceWindow,
            sourceWindowId,
            workspacePath: data.workspacePath,
            expiresAt: Date.now() + PROJECT_TAB_DRAG_TTL_MS,
            cleanupTimer: setTimeout(() => removeActiveProjectTabDrag(data.dragId), PROJECT_TAB_DRAG_TTL_MS),
            claimed: false,
            claimedDestinationWindowId: null,
            moved: false,
            ready: false,
            preparationError: null,
            resultWaiters: new Set(),
            preparationWaiters: new Set(),
        };
        activeProjectTabDrags.set(data.dragId, drag);
    });

    safeOn('workspace:project-tab-drag-ready', (event, data: {
        dragId?: string;
        error?: string;
    }) => {
        const dragId = data?.dragId;
        if (!dragId) return;
        const drag = activeProjectTabDrags.get(dragId);
        if (!drag) return;
        const sourceWindow = BrowserWindow.fromWebContents(event.sender);
        if (!sourceWindow || getWindowId(sourceWindow) !== drag.sourceWindowId) return;
        drag.preparationError = typeof data.error === 'string' && data.error.length > 0
            ? data.error
            : null;
        drag.ready = !drag.preparationError;
        drag.preparationWaiters.forEach((resolve) => resolve());
        drag.preparationWaiters.clear();
    });

    safeOn('workspace:end-project-tab-drag', (event, data: { dragId?: string }) => {
        const dragId = data?.dragId;
        if (!dragId) return;
        const drag = activeProjectTabDrags.get(dragId);
        if (!drag || drag.claimed || drag.moved) return;
        const sourceWindow = BrowserWindow.fromWebContents(event.sender);
        if (!sourceWindow || getWindowId(sourceWindow) !== drag.sourceWindowId) return;
        removeActiveProjectTabDrag(dragId);
    });

    // Chromium normally reports dropEffect=move after a destination rail
    // accepts a tab. Some Linux window-manager combinations report `none`,
    // so dragend gives the destination a short grace period to commit before
    // falling back to the existing tear-out behavior.
    safeHandle('workspace:wait-project-tab-drag-result', async (event, data: { dragId?: string }) => {
        const dragId = data?.dragId;
        if (!dragId) return { handled: false, moved: false };
        pruneExpiredProjectTabDrags();
        const drag = activeProjectTabDrags.get(dragId);
        if (!drag) return { handled: false, moved: false };

        const sourceWindow = BrowserWindow.fromWebContents(event.sender);
        if (!sourceWindow || getWindowId(sourceWindow) !== drag.sourceWindowId) {
            return { handled: false, moved: false };
        }
        if (drag.claimed || drag.moved) {
            return { handled: true, moved: drag.moved };
        }

        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                drag.resultWaiters.delete(onSettled);
                resolve();
            }, PROJECT_TAB_DROP_GRACE_MS);
            const onSettled = () => {
                clearTimeout(timer);
                resolve();
            };
            drag.resultWaiters.add(onSettled);
        });

        const handled = drag.claimed || drag.moved;
        if (!handled && activeProjectTabDrags.get(dragId) === drag) {
            // Close the token before returning. A destination that arrives
            // after this point is rejected, preventing both a move and a new
            // detached window from being created for the same drag.
            removeActiveProjectTabDrag(dragId);
        }
        return { handled, moved: drag.moved };
    });

    safeHandle('workspace:consume-pending-project-tab-mutations', async (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return [];
        const windowId = getWindowId(window);
        if (windowId === null) return [];
        return [...(windowStates.get(windowId)?.pendingProjectTabMutations ?? [])];
    });

    safeHandle('workspace:ack-project-tab-mutation', async (event, data: { mutationId?: string }) => {
        const mutationId = data?.mutationId;
        if (!mutationId) return { success: false };
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return { success: false };
        const windowId = getWindowId(window);
        if (windowId === null) return { success: false };
        const state = windowStates.get(windowId);
        if (!state) return { success: false };
        state.pendingProjectTabMutations = (state.pendingProjectTabMutations ?? []).filter(
            (mutation) => mutation.id !== mutationId,
        );
        return { success: true };
    });

    safeHandle('workspace:move-project-tab', async (event, data: { dragId?: string }) => {
        pruneExpiredProjectTabDrags();
        const dragId = data?.dragId;
        if (!dragId) {
            return { success: false, error: 'dragId required' };
        }

        const drag = activeProjectTabDrags.get(dragId);
        if (!drag || drag.moved) {
            return { success: false, error: 'Project tab drag is no longer active' };
        }
        const workspacePath = drag.workspacePath;

        const destinationWindow = BrowserWindow.fromWebContents(event.sender);
        if (!destinationWindow) return { success: false, error: 'No destination window' };
        const destinationWindowId = getWindowId(destinationWindow);
        if (destinationWindowId === null) return { success: false, error: 'No destination windowId' };
        if (destinationWindowId === drag.sourceWindowId) {
            // Dropping back onto the originating strip is a normal no-op.
            // Keep the token claimed until dragend's Linux fallback check so
            // a browser-reported dropEffect=none cannot tear it into a window.
            drag.claimed = true;
            drag.claimedDestinationWindowId = destinationWindowId;
            drag.resultWaiters.forEach((resolve) => resolve());
            drag.resultWaiters.clear();
            return { success: true, alreadyInWindow: true };
        }
        if (typeof drag.sourceWindow.isDestroyed === 'function' && drag.sourceWindow.isDestroyed()) {
            removeActiveProjectTabDrag(dragId);
            return { success: false, error: 'Source window is no longer available' };
        }

        const initialSourceState = windowStates.get(drag.sourceWindowId);
        const initialDestinationState = windowStates.get(destinationWindowId);
        if (!initialSourceState || !initialDestinationState) {
            return { success: false, error: 'Source or destination window state is unavailable' };
        }
        if (drag.claimedDestinationWindowId !== null) {
            return { success: false, error: 'Project tab drag was already claimed by a destination window' };
        }
        // A real destination rail claimed the DOM drop. From this point on,
        // even validation/preparation failure leaves the source tab in place
        // instead of racing the fallback into a surprise third window.
        drag.claimed = true;
        drag.claimedDestinationWindowId = destinationWindowId;
        drag.resultWaiters.forEach((resolve) => resolve());
        drag.resultWaiters.clear();
        if (!referencesWorkspace(initialSourceState, workspacePath)) {
            removeActiveProjectTabDrag(dragId);
            return { success: false, error: 'Project is not open in the source window' };
        }
        if (initialDestinationState.mode !== 'workspace' && initialDestinationState.mode !== 'agentic-coding') {
            return { success: false, error: 'Destination is not a workspace window' };
        }

        if (!drag.ready && !drag.preparationError) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    drag.preparationWaiters.delete(onPrepared);
                    resolve();
                }, PROJECT_TAB_PREPARATION_TIMEOUT_MS);
                const onPrepared = () => {
                    clearTimeout(timer);
                    resolve();
                };
                drag.preparationWaiters.add(onPrepared);
            });
        }
        if (drag.preparationError) {
            return { success: false, error: drag.preparationError };
        }
        if (!drag.ready) {
            return { success: false, error: 'Timed out while saving the project before moving it' };
        }

        // Preparation may take several seconds. Re-resolve every mutable
        // participant after the await so a closed/reloaded window, a removed
        // source tab, or another destination cannot commit stale state.
        if (
            activeProjectTabDrags.get(dragId) !== drag
            || drag.moved
            || drag.claimedDestinationWindowId !== destinationWindowId
        ) {
            return { success: false, error: 'Project tab drag is no longer active' };
        }
        if (
            (typeof drag.sourceWindow.isDestroyed === 'function' && drag.sourceWindow.isDestroyed())
            || (typeof destinationWindow.isDestroyed === 'function' && destinationWindow.isDestroyed())
        ) {
            return { success: false, error: 'Source or destination window is no longer available' };
        }
        const sourceState = windowStates.get(drag.sourceWindowId);
        const destinationState = windowStates.get(destinationWindowId);
        if (!sourceState || !destinationState) {
            return { success: false, error: 'Source or destination window state is unavailable' };
        }
        if (!referencesWorkspace(sourceState, workspacePath)) {
            return { success: false, error: 'Project is not open in the source window' };
        }
        if (destinationState.mode !== 'workspace' && destinationState.mode !== 'agentic-coding') {
            return { success: false, error: 'Destination is not a workspace window' };
        }

        const destinationAlreadyReferences = referencesWorkspace(destinationState, workspacePath);
        if (!destinationAlreadyReferences
            && referencedWorkspacePaths(destinationState).length >= MAX_OPEN_PROJECT_TABS) {
            return { success: false, error: `Project tab limit (${MAX_OPEN_PROJECT_TABS}) reached` };
        }

        // Service creation happens before either window state changes. It is
        // normally idempotent because the source already owns the project,
        // but retaining the check makes the transaction safe after a reload.
        const serviceResult = ensureWorkspaceTabServices(destinationWindow, workspacePath);
        if (!serviceResult.success) return serviceResult;

        const sourceSnapshot = {
            workspacePath: sourceState.workspacePath,
            additionalWorkspacePaths: [...(sourceState.additionalWorkspacePaths ?? [])],
            activeWorkspacePath: sourceState.activeWorkspacePath,
            pendingProjectTabPaths: [...(sourceState.pendingProjectTabPaths ?? [])],
            pendingProjectTabMutations: [...(sourceState.pendingProjectTabMutations ?? [])],
        };
        const destinationSnapshot = {
            workspacePath: destinationState.workspacePath,
            additionalWorkspacePaths: [...(destinationState.additionalWorkspacePaths ?? [])],
            activeWorkspacePath: destinationState.activeWorkspacePath,
            pendingProjectTabMutations: [...(destinationState.pendingProjectTabMutations ?? [])],
        };
        const sourceWasActive = (sourceState.activeWorkspacePath ?? sourceState.workspacePath) === workspacePath;
        const destinationPreviousActive = destinationState.activeWorkspacePath ?? destinationState.workspacePath;
        const previousGlobalPath = resolveMostRecentlyFocusedWorkspacePath();

        try {
            if (sourceWasActive) stopWorkspaceWatcher(drag.sourceWindowId);
            if (destinationPreviousActive && destinationPreviousActive !== workspacePath) {
                stopWorkspaceWatcher(destinationWindowId);
            }

            // Destination first: the workspace remains referenced throughout
            // the handoff, so shared sessions/services cannot be torn down.
            if (!destinationAlreadyReferences) {
                if (!destinationState.workspacePath) {
                    destinationState.workspacePath = workspacePath;
                } else {
                    destinationState.additionalWorkspacePaths = [
                        ...(destinationState.additionalWorkspacePaths ?? []),
                        workspacePath,
                    ];
                }
            }

            const sourcePaths = referencedWorkspacePaths(sourceState);
            const sourceIndex = sourcePaths.indexOf(workspacePath);
            const remainingSourcePaths = sourcePaths.filter((path) => path !== workspacePath);
            const replacementWorkspacePath = remainingSourcePaths[sourceIndex]
                ?? remainingSourcePaths[sourceIndex - 1]
                ?? remainingSourcePaths[0]
                ?? null;

            if (sourceState.workspacePath === workspacePath) {
                sourceState.workspacePath = replacementWorkspacePath;
                sourceState.additionalWorkspacePaths = remainingSourcePaths.filter(
                    (path) => path !== replacementWorkspacePath,
                );
            } else {
                sourceState.additionalWorkspacePaths = (sourceState.additionalWorkspacePaths ?? []).filter(
                    (path) => path !== workspacePath,
                );
            }
            sourceState.pendingProjectTabPaths = (sourceState.pendingProjectTabPaths ?? []).filter(
                (path) => path !== workspacePath,
            );
            if (sourceWasActive) sourceState.activeWorkspacePath = replacementWorkspacePath;

            destinationState.activeWorkspacePath = workspacePath;

            if (sourceWasActive && replacementWorkspacePath) {
                startWorkspaceWatcher(drag.sourceWindow, replacementWorkspacePath);
            }
            if (destinationPreviousActive !== workspacePath) {
                startWorkspaceWatcher(destinationWindow, workspacePath);
            }

            const destinationService = fileSystemServices.get(workspacePath);
            if (destinationService) setFileSystemService(destinationService);
            initializeWorkspaceTabBackground(workspacePath);
            activateWorkspaceTabContext(workspacePath);
            addToRecentItems('workspaces', workspacePath, basename(workspacePath));

            const sourceMutation: ProjectTabMutation = {
                id: randomUUID(),
                kind: 'remove',
                workspacePath,
                replacementWorkspacePath: sourceWasActive ? replacementWorkspacePath : null,
                closeWindowWhenEmpty: remainingSourcePaths.length === 0,
            };
            const destinationMutation: ProjectTabMutation = {
                id: randomUUID(),
                kind: 'add',
                workspacePath,
                activate: true,
            };
            queueProjectTabMutation(sourceState, sourceMutation);
            queueProjectTabMutation(destinationState, destinationMutation);

            drag.moved = true;
            drag.resultWaiters.forEach((resolve) => resolve());
            drag.resultWaiters.clear();
            sendProjectTabMutation(drag.sourceWindow, sourceMutation);
            sendProjectTabMutation(destinationWindow, destinationMutation);

            return { success: true };
        } catch (error) {
            // Restore both window states and their previous active watchers.
            // No service cleanup runs during a move, so rollback cannot lose a
            // session even if a watcher transition throws unexpectedly.
            stopWorkspaceWatcher(drag.sourceWindowId);
            stopWorkspaceWatcher(destinationWindowId);
            Object.assign(sourceState, sourceSnapshot);
            Object.assign(destinationState, destinationSnapshot);
            const previousSourceActive = sourceSnapshot.activeWorkspacePath ?? sourceSnapshot.workspacePath;
            if (previousSourceActive) startWorkspaceWatcher(drag.sourceWindow, previousSourceActive);
            if (destinationPreviousActive) startWorkspaceWatcher(destinationWindow, destinationPreviousActive);
            const previousGlobalService = previousGlobalPath
                ? fileSystemServices.get(previousGlobalPath)
                : null;
            if (previousGlobalService) setFileSystemService(previousGlobalService);
            else restoreGlobalFileSystemService(-1);
            if (previousGlobalPath) activateWorkspaceTabContext(previousGlobalPath);
            logger.main.error('[MultiProject] Failed to move project tab:', error);
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    });

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
        const registeredCount = new Set([state.workspacePath, ...additional].filter(Boolean)).size;
        if (registeredCount >= MAX_OPEN_PROJECT_TABS) {
            return { success: false, error: `Project tab limit (${MAX_OPEN_PROJECT_TABS}) reached` };
        }

        // Build services before mutating the window reference list. If a
        // constructor fails, the renderer never shows a tab and main retains
        // no ghost reference.
        const serviceResult = ensureWorkspaceTabServices(window, workspacePath);
        if (!serviceResult.success) return serviceResult;

        state.additionalWorkspacePaths = [...additional, workspacePath];
        addToRecentItems('workspaces', workspacePath, basename(workspacePath));
        initializeWorkspaceTabBackground(workspacePath);

        return { success: true };
    });

    safeHandle('workspace:consume-pending-project-tabs', async (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return [];
        const windowId = getWindowId(window);
        if (windowId === null) return [];
        const state = windowStates.get(windowId);
        if (!state) return [];
        return [...new Set(state.pendingProjectTabPaths ?? [])];
    });

    safeHandle('workspace:ack-project-tab-open', async (event, data: { workspacePath: string }) => {
        const workspacePath = data?.workspacePath;
        if (!workspacePath || typeof workspacePath !== 'string') return { success: false };
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) return { success: false };
        const windowId = getWindowId(window);
        if (windowId === null) return { success: false };
        const state = windowStates.get(windowId);
        if (!state) return { success: false };
        state.pendingProjectTabPaths = (state.pendingProjectTabPaths ?? []).filter(
            (path) => path !== workspacePath,
        );
        return { success: true };
    });

    safeHandle('workspace:unregister-additional', async (event, data: {
        workspacePath: string;
        replacementWorkspacePath?: string | null;
    }) => {
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

        const referencesProject = state.workspacePath === workspacePath
            || state.additionalWorkspacePaths?.includes(workspacePath) === true;
        if (!referencesProject) {
            return { success: false, error: 'Project is not open in this window' };
        }

        const wasPrimary = state.workspacePath === workspacePath;
        const wasActive = (state.activeWorkspacePath ?? state.workspacePath) === workspacePath;
        let remainingAdditional = (state.additionalWorkspacePaths ?? []).filter((p) => p !== workspacePath);

        // stopWorkspaceWatcher derives project-sync cleanup from the current
        // state, so stop it before removing/promoting paths.
        if (wasActive) stopWorkspaceWatcher(windowId);

        // The legacy primary path must follow the remaining visible tabs.
        // Otherwise closing/detaching the startup project leaves a hidden
        // reference in this window forever and prevents service cleanup.
        if (wasPrimary) {
            const requestedReplacement = data.replacementWorkspacePath;
            const promoted = requestedReplacement && remainingAdditional.includes(requestedReplacement)
                ? requestedReplacement
                : state.activeWorkspacePath && state.activeWorkspacePath !== workspacePath
                    && remainingAdditional.includes(state.activeWorkspacePath)
                    ? state.activeWorkspacePath
                    : remainingAdditional[0] ?? null;
            state.workspacePath = promoted;
            remainingAdditional = remainingAdditional.filter((path) => path !== promoted);
        }
        state.additionalWorkspacePaths = remainingAdditional;
        state.pendingProjectTabPaths = (state.pendingProjectTabPaths ?? []).filter(
            (path) => path !== workspacePath,
        );

        // If the path being closed was this window's active path, move the
        // active-only state (file watcher + global FS service) to the
        // replacement immediately. The renderer will also publish its new
        // active atom after this IPC resolves; that follow-up is idempotent.
        if (wasActive) {
            const referencedAfterClose = [state.workspacePath, ...remainingAdditional].filter(
                (path): path is string => typeof path === 'string' && path.length > 0,
            );
            const requestedReplacement = data.replacementWorkspacePath;
            const nextActive = requestedReplacement && referencedAfterClose.includes(requestedReplacement)
                ? requestedReplacement
                : referencedAfterClose[0] ?? null;
            state.activeWorkspacePath = nextActive;

            if (nextActive) {
                startWorkspaceWatcher(window, nextActive);
                const nextService = fileSystemServices.get(nextActive);
                if (nextService) {
                    setFileSystemService(nextService);
                } else {
                    restoreGlobalFileSystemService(windowId);
                }
            } else {
                // A detach creates its destination before this close. Select
                // the most recently focused remaining workspace's service so
                // the handoff cannot leave the process-global service empty.
                restoreGlobalFileSystemService(windowId);
            }
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
            releaseWorkspaceTabBackground(workspacePath);
        }

        return { success: true };
    });

    // Dragging a tab out creates its destination window before the renderer
    // unregisters it from the source, keeping shared services and sessions
    // alive throughout the handoff.
    safeHandle('workspace:detach-project-tab', async (event, data: {
        workspacePath: string;
        position?: { screenX: number; screenY: number };
    }) => {
        const workspacePath = data?.workspacePath;
        if (!workspacePath || typeof workspacePath !== 'string') {
            return { success: false, error: 'workspacePath required' };
        }

        const sourceWindow = BrowserWindow.fromWebContents(event.sender);
        if (!sourceWindow) return { success: false, error: 'No window for event sender' };
        const sourceWindowId = getWindowId(sourceWindow);
        if (sourceWindowId === null) return { success: false, error: 'No windowId' };
        const state = windowStates.get(sourceWindowId);
        const referencesProject = state?.workspacePath === workspacePath
            || state?.additionalWorkspacePaths?.includes(workspacePath) === true;
        if (!referencesProject) {
            return { success: false, error: 'Project is not open in this window' };
        }

        const sourceBounds = typeof sourceWindow.getBounds === 'function'
            ? sourceWindow.getBounds()
            : null;
        const position = data.position;
        const detachedBounds = sourceBounds && position
            && Number.isFinite(position.screenX) && Number.isFinite(position.screenY)
            && (position.screenX !== 0 || position.screenY !== 0)
            ? {
                x: Math.round(position.screenX - 120),
                y: Math.round(position.screenY - 20),
                width: sourceBounds.width,
                height: sourceBounds.height,
            }
            : undefined;

        const detachedWindow = createWindow(false, true, workspacePath, detachedBounds);
        const detachedWindowId = getWindowId(detachedWindow);
        if (detachedWindowId !== null) {
            const detachedState = windowStates.get(detachedWindowId);
            if (detachedState) detachedState.activeWorkspacePath = workspacePath;
        }
        addToRecentItems('workspaces', workspacePath, basename(workspacePath));
        initializeWorkspaceTabBackground(workspacePath);
        activateWorkspaceTabContext(workspacePath);
        return { success: true, windowId: detachedWindow.id };
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
            // A main-owned cross-window move updates both renderers. The
            // unfocused source can publish its replacement after the focused
            // destination publishes the moved project, so only the focused
            // window may update process-global workspace context here.
            if (window.isFocused()) {
                const svc = fileSystemServices.get(workspacePath);
                if (svc) setFileSystemService(svc);
                activateWorkspaceTabContext(workspacePath);
            }
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
        if (window.isFocused()) {
            const fsService = fileSystemServices.get(workspacePath);
            if (fsService) {
                setFileSystemService(fsService);
            } else {
                logger.main.warn(
                    '[MultiProject] set-active without registered FileSystemService for path:',
                    workspacePath,
                );
            }

            activateWorkspaceTabContext(workspacePath);
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
