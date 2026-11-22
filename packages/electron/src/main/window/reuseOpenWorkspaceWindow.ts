import { getMultiProjectMode } from '../utils/store';
import { findWorkspaceWindowMatch, type WorkspaceWindowMatchResult } from './WindowManager';
import { reuseWorkspaceWindow } from './workspaceWindowMatch';

/**
 * Bring forward the window whose rail holds a project and make that project
 * the visible one. Returns the match (its `matchedPath` is the rail project the
 * window now shows), or null when no open window can host the project, so the
 * caller opens a new window.
 *
 * Focusing the window `findWindowByWorkspace` returns is not enough: that
 * window may be showing another rail project, and focusing it changes nothing
 * on screen (https://github.com/nimbalyst/nimbalyst/issues/1427).
 *
 * With the project rail off a window shows only its own project, and the
 * renderer refuses to switch. A window that still references the project from
 * rail mode is then not a host for it.
 */
export function reuseOpenWorkspaceWindow(workspacePath: string): WorkspaceWindowMatchResult | null {
    const match = findWorkspaceWindowMatch(workspacePath);
    if (!match) return null;
    if (!match.isActive && !getMultiProjectMode()) return null;
    return reuseWorkspaceWindow(match.window, match) === 'unavailable' ? null : match;
}
