import { BrowserWindow } from 'electron';
import { writeFileSync } from 'fs';
import { basename } from 'path';
import { windowStates, getWindowId } from '../window/WindowManager';
import { addToRecentItems } from '../utils/store';
import { logger } from '../utils/logger';

// Function to open a file in a window - sends open-document event to renderer
// which triggers handleWorkspaceFileSelect to load content and create tab
//
// `expectedWorkspacePath`, when passed, is a warn-only sanity check: a window
// can now host N projects (Multi-Project Mode's rail), but `open-document`'s
// payload is still a bare `{ path }` with no workspace field -- the renderer
// resolves it against whichever project is currently *active* at delivery
// time (`App.tsx`'s `handleWorkspaceFileSelect`), not a project named in this
// call. Callers that know which project the file belongs to can pass it so a
// caller-side bug (delivering into a window that never actually registered
// that project) is logged instead of silently opening in the wrong tree. This
// does NOT make delivery itself workspace-targeted -- see the call sites in
// `main/index.ts` for the full caveat.
export function loadFileIntoWindow(window: BrowserWindow, filePath: string, expectedWorkspacePath?: string) {
    try {
        const windowId = getWindowId(window);
        if (windowId === null) {
            console.error('[LOAD_FILE] Failed to find custom window ID');
            return;
        }
        const state = windowStates.get(windowId);

        if (state) {
            state.filePath = filePath;
            state.documentEdited = false;

            if (expectedWorkspacePath) {
                const knownPaths = [state.workspacePath, ...(state.additionalWorkspacePaths ?? [])];
                if (!knownPaths.includes(expectedWorkspacePath)) {
                    logger.main.warn(
                        '[LOAD_FILE] Delivering into a window that has not registered the expected workspace:',
                        { expectedWorkspacePath, filePath, knownPaths },
                    );
                }
            }
        } else {
            console.error('[LOAD_FILE] No window state found for window ID:', windowId);
        }

        // Send open-document event - renderer handles content loading via switchWorkspaceFile
        window.webContents.send('open-document', { path: filePath });

        // Set represented filename for macOS
        if (process.platform === 'darwin') {
            window.setRepresentedFilename(filePath);
        }

        // Add to recent documents
        addToRecentItems('documents', filePath, basename(filePath));

    } catch (error) {
        console.error('[LOAD_FILE] Error loading file from OS:', error);
    }
}

/** Narrow shape `deliverAfterWorkspaceSeed` needs from a workspace-open
 *  outcome -- matches `ProjectOpenOutcomeAsync` from `WorkspaceManagerWindow.ts`
 *  structurally so callers don't need to import that module's type here. */
export type WorkspaceOpenOutcomeForDelivery = { kind: string };
export type BlockedWorkspaceOpenOutcome = { kind: 'blocked'; reason: string };

/**
 * Sequencing guard for delivering a payload into a window that may still be
 * mid rail-seed (`openOrFocusWorkspaceWindowAwaitingRailSeed`). Awaits
 * `outcomePromise` and only calls `deliver` if it did not resolve to
 * `{ kind: 'blocked' }`; otherwise calls `onBlocked` (if given) and returns
 * without delivering anything.
 *
 * Pure -- no Electron, no I/O -- so the ordering guarantee this whole fix
 * depends on ("never deliver before the seed resolves; never deliver at all
 * on 'at-cap'/'timeout'") is unit-testable without mocking Electron or
 * pulling in `main/index.ts`'s import graph.
 */
export async function deliverAfterWorkspaceSeed<O extends WorkspaceOpenOutcomeForDelivery>(
    // `null` means the opener was never registered (a caller reaching the
    // chokepoint through `window/workspaceOpenRef.ts` before startup wired it
    // up). Treated exactly like a blocked seed: never deliver a payload into
    // a window that may not host the project.
    outcomePromise: Promise<O | null>,
    deliver: (outcome: Exclude<O, BlockedWorkspaceOpenOutcome>) => void,
    onBlocked?: (outcome: Extract<O, BlockedWorkspaceOpenOutcome> | null) => void,
): Promise<boolean> {
    const outcome = await outcomePromise;
    if (!outcome || outcome.kind === 'blocked') {
        onBlocked?.(outcome as Extract<O, BlockedWorkspaceOpenOutcome> | null);
        return false;
    }
    deliver(outcome as Exclude<O, BlockedWorkspaceOpenOutcome>);
    return true;
}

// Save file
export function saveFile(filePath: string, content: string): void {
    writeFileSync(filePath, content, 'utf-8');
}
