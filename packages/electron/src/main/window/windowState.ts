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
