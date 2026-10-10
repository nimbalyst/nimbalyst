import type { BrowserWindow } from 'electron';
import type { WindowState } from '../types';
import { getAttachedFolders } from '../utils/store';

// Shared window maps used across main-process modules.
// Keeping these in a lightweight module avoids importing WindowManager
// (and its transitive startup dependencies) where only map access is needed.
export const windows = new Map<number, BrowserWindow>();
export const windowStates = new Map<number, WindowState>();

/** Workspace/document windows registered by WindowManager, including hidden ones. */
export function getProjectWindows(): BrowserWindow[] {
    return [...windows.values()].filter(window => !window.isDestroyed());
}

/**
 * The visible workspace path for a window. Falls back to the create-time
 * `workspacePath` when the rail is off.
 */
export function resolveActiveWorkspacePath(state: WindowState | undefined): string | null {
    if (!state) return null;
    return state.activeWorkspacePath ?? state.workspacePath;
}

/**
 * Reverse-lookup a window's id from the shared map. Single-sources the scan so
 * callers that only need "which window is this?" don't each reimplement it
 * (and don't have to import WindowManager to get it).
 */
export function getWindowIdForWindow(browserWindow: BrowserWindow | null | undefined): number | null {
    if (!browserWindow) return null;
    for (const [windowId, candidate] of windows) {
        if (candidate === browserWindow) {
            return windowId;
        }
    }
    return null;
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
 * Whether a window has any interest in a workspace path — as its primary path,
 * as a warm "additional" path in the project rail, or as a folder attached to
 * one of those. Used by service-cleanup logic so destroying a window only frees
 * a workspace's services when no other window references it.
 *
 * Attached folders count: detaching a folder from one workspace must not
 * destroy services another window still holds it open through.
 */
export function windowReferencesWorkspace(state: WindowState | undefined, path: string): boolean {
    if (!state) return false;
    if (state.workspacePath === path) return true;
    if (state.additionalWorkspacePaths?.includes(path) === true) return true;
    return listWindowRootPaths(state).includes(path);
}

/**
 * Every root a window shows: its rail projects plus the folders attached to
 * each of them. The rail paths themselves are excluded -- callers that need
 * those already check them directly.
 */
function listWindowRootPaths(state: WindowState): string[] {
    const roots: string[] = [];
    const railPaths = [state.workspacePath, ...(state.additionalWorkspacePaths ?? [])];
    for (const railPath of railPaths) {
        if (!railPath) continue;
        roots.push(...getAttachedFolders(railPath));
    }
    return roots;
}

/**
 * Every workspace path an open window references, primary and rail alike.
 *
 * Used by the post-sign-in project walk to ask "is the user already working in
 * one of their organization's projects?" before interrupting them. Attached
 * folders are deliberately NOT included: they have no workspace identity of
 * their own, so they can never be "one of the user's org projects".
 */
export function listOpenWorkspacePaths(): string[] {
    const paths = new Set<string>();
    for (const state of windowStates.values()) {
        if (state.workspacePath) paths.add(state.workspacePath);
        for (const extra of state.additionalWorkspacePaths ?? []) {
            if (extra) paths.add(extra);
        }
    }
    return [...paths];
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

/**
 * #1375: Keep the window's represented file in lockstep with the document on
 * screen.
 *
 * Our windows use `titleBarStyle: 'hiddenInset'`, so the proxy icon this
 * normally draws is never rendered. What it still feeds is AXDocument, which
 * macOS hands to every accessibility client -- screen readers, automation,
 * time trackers -- as "the document this window is showing". That is the whole
 * payload here; there is nothing visual to check.
 *
 * Pass null when no document is visible. `setRepresentedFilename` has no
 * implicit clear, so without this the window keeps advertising the last file it
 * ever represented -- possibly one the user has since deleted, since clearing
 * window state on delete does not touch the OS-level value.
 *
 * No-ops off darwin, where represented filenames do not exist.
 */
export function syncRepresentedFilename(
    window: BrowserWindow | null | undefined,
    filePath: string | null,
): void {
    if (process.platform !== 'darwin') return;
    if (!window || window.isDestroyed()) return;

    window.setRepresentedFilename(filePath ?? '');
    if (!filePath) window.setDocumentEdited(false);
}
