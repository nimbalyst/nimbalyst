/**
 * Pure routing decision for "open this project".
 *
 * Extracted out of `openOrFocusWorkspaceWindow` (WorkspaceManagerWindow.ts) so
 * the decision — focus an existing window, add the project to the focused
 * window's rail, or spawn a new window — is unit-testable without Electron
 * and reusable by call sites that cannot import WorkspaceManagerWindow
 * directly (e.g. dependency-injected services, to avoid circular imports).
 *
 * No Electron imports here, and none should be added — this module must stay
 * safe to import from anywhere in the main process.
 */

/** Main -> renderer channel used to tell the renderer to add a project to the
 *  rail. The renderer must register the workspace with main
 *  (`workspace:register-additional`) BEFORE flipping the active path via
 *  `addOpenProjectAtom` — see `store/listeners/railProjectListeners.ts`. */
export const RAIL_ADD_PROJECT_CHANNEL = 'rail:add-project';

export interface ResolveProjectOpenTargetInput<W> {
  /** Unused by the decision itself; kept on the input for callers/tests that
   *  want a single object describing "what are we opening". */
  workspacePath: string;
  multiProjectModeEnabled: boolean;
  /** A live window that already references this exact path (primary or
   *  rail-warm additional), or null if none does. */
  existingWindowForPath: W | null;
  /** The focused (or most-recently-focused) workspace window, or null if no
   *  workspace window is open. Only consulted when there is no existing
   *  window for the path. */
  focusedWorkspaceWindow: W | null;
}

export type ProjectOpenTarget<W> =
  | { kind: 'focus-existing'; window: W }
  | { kind: 'add-to-rail'; window: W }
  | { kind: 'new-window' };

/**
 * Decide how to open `workspacePath`.
 *
 * 1. A window already referencing the path wins regardless of mode — this
 *    is today's (pre-multi-project) behavior and must never regress.
 * 2. Otherwise, in multi-project mode, with a focused workspace window,
 *    add the project to that window's rail.
 * 3. Otherwise, open a new window.
 */
export function resolveProjectOpenTarget<W>(
  input: ResolveProjectOpenTargetInput<W>,
): ProjectOpenTarget<W> {
  const { existingWindowForPath, multiProjectModeEnabled, focusedWorkspaceWindow } = input;

  if (existingWindowForPath) {
    return { kind: 'focus-existing', window: existingWindowForPath };
  }

  if (multiProjectModeEnabled && focusedWorkspaceWindow) {
    return { kind: 'add-to-rail', window: focusedWorkspaceWindow };
  }

  return { kind: 'new-window' };
}
