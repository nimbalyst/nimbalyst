import type { BrowserWindow } from 'electron';
import type { WindowState } from '../types';

// Shared window maps used across main-process modules.
// Keeping these in a lightweight module avoids importing WindowManager
// (and its transitive startup dependencies) where only map access is needed.
export const windows = new Map<number, BrowserWindow>();
export const windowStates = new Map<number, WindowState>();

/**
 * The visible workspace path for a window. Falls back to the create-time
 * `workspacePath` when the rail is off.
 */
export function resolveActiveWorkspacePath(state: WindowState | undefined): string | null {
    if (!state) return null;
    return state.activeWorkspacePath ?? state.workspacePath;
}

/**
 * Resolve the visible workspace path for a window id, honoring the project
 * rail's active selection. Returns the active rail project when set, falling
 * back to the window's primary/startup path, or `undefined` when the window
 * id is unknown.
 *
 * Use this (not a raw `windowStates.get(id)?.workspacePath` read) anywhere a
 * main-process handler must act on "the project the user is currently looking
 * at" — e.g. creating an AI session for an extension prompt. Reading the raw
 * primary path silently routes the action to the startup project in
 * Multi-Project mode (issue #544).
 */
export function resolveActiveWorkspacePathForWindowId(windowId: number | null | undefined): string | undefined {
    if (windowId === null || windowId === undefined) return undefined;
    return resolveActiveWorkspacePath(windowStates.get(windowId)) ?? undefined;
}

/**
 * Resolve the workspace path whose DocumentService should serve an IPC
 * request for this window. Honors the project rail's active selection so a
 * tracker / document query reads the project the user is currently looking
 * at, not the window's startup primary.
 *
 * Returns null for windows that should not have document-service access
 * (wrong mode, or no workspace at all). Single-sources the path logic for
 * both the WindowManager and MultiProjectRailHandlers resolvers so they
 * can't diverge again (issue #591: WindowManager's resolver read the raw
 * `workspacePath`, leaking another project's tracker items in the rail).
 */
export function resolveDocumentServicePath(state: WindowState | undefined): string | null {
    if (!state) return null;
    if (state.mode !== 'workspace' && state.mode !== 'agentic-coding') return null;
    return resolveActiveWorkspacePath(state);
}

/**
 * Whether a window has any interest in a workspace path — either as its
 * primary path or as a warm "additional" path in the project rail. Used
 * by service-cleanup logic so destroying a window only frees a workspace's
 * services when no other window references it.
 */
export function windowReferencesWorkspace(state: WindowState | undefined, path: string): boolean {
    if (!state) return false;
    if (state.workspacePath === path) return true;
    return state.additionalWorkspacePaths?.includes(path) === true;
}

/**
 * Whether any window in the current process references a workspace path.
 */
export function anyWindowReferencesWorkspace(path: string, excludeWindowId?: number): boolean {
    for (const [id, state] of windowStates) {
        if (excludeWindowId !== undefined && id === excludeWindowId) continue;
        if (windowReferencesWorkspace(state, path)) return true;
    }
    return false;
}
