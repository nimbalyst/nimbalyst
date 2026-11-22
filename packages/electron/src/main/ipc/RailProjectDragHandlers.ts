/**
 * Moving a project between windows by dragging it out of a multi-project rail.
 *
 * The rail uses native drag and drop, so the drag data reaches other windows,
 * but only main knows which window a drag started in. The source rail reports
 * the start and the end of its drag; a target rail reports a drop after it has
 * added the project. Main then tells the source window to let the project go.
 *
 * - `workspace:rail-drag-start` -- the source rail started dragging a project.
 * - `workspace:rail-drag-received` -- a target rail took the dropped project.
 * - `workspace:rail-drag-end` -- the source drag ended. A drop outside every
 *   Nimbalyst window tears the project off into a new window there.
 *
 * The source window hears `workspace:rail-release-project` and removes the
 * project from its rail (closing the window when it was the last one).
 */

import { BrowserWindow, screen } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { getWindowIdForWindow, windows } from '../window/windowState';
import { openWorkspaceWindow } from '../window/WorkspaceManagerWindow';
import { logger } from '../utils/logger';

interface Rect { x: number; y: number; width: number; height: number }

interface PendingRailDrag {
  workspacePath: string;
  sourceWindowId: number;
}

let pendingDrag: PendingRailDrag | null = null;

/**
 * A drag that nothing accepted tears off only when it ended outside every
 * window. A drop inside a window that did not accept it (or Escape over a
 * window) leaves the project where it was. The source's only project has
 * nowhere better to go, so it never tears off.
 */
export function shouldTearOffRailProject(input: {
  dropEffect: string;
  isOnlyProject: boolean;
  cursor: { x: number; y: number };
  windowBounds: Rect[];
}): boolean {
  if (input.dropEffect !== 'none' || input.isOnlyProject) return false;
  const { x, y } = input.cursor;
  return !input.windowBounds.some(b => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height);
}

function releaseFromSource(drag: PendingRailDrag): void {
  const source = windows.get(drag.sourceWindowId);
  if (!source || source.isDestroyed()) return;
  source.webContents.send('workspace:rail-release-project', { workspacePath: drag.workspacePath });
}

export function registerRailProjectDragHandlers(): void {
  safeHandle('workspace:rail-drag-start', async (event, data: { workspacePath: string }) => {
    const workspacePath = data?.workspacePath;
    if (!workspacePath || typeof workspacePath !== 'string') {
      return { success: false, error: 'workspacePath required' };
    }
    const sourceWindowId = getWindowIdForWindow(BrowserWindow.fromWebContents(event.sender));
    if (sourceWindowId === null) return { success: false, error: 'No windowId' };
    pendingDrag = { workspacePath, sourceWindowId };
    return { success: true };
  });

  safeHandle('workspace:rail-drag-received', async (event, data: { workspacePath: string }) => {
    const workspacePath = data?.workspacePath;
    if (!workspacePath || typeof workspacePath !== 'string') {
      return { success: false, error: 'workspacePath required' };
    }
    const targetWindowId = getWindowIdForWindow(BrowserWindow.fromWebContents(event.sender));
    const drag = pendingDrag;
    if (!drag || drag.workspacePath !== workspacePath || drag.sourceWindowId === targetWindowId) {
      return { success: false, error: 'No matching drag from another window' };
    }
    pendingDrag = null;
    releaseFromSource(drag);
    return { success: true };
  });

  safeHandle('workspace:rail-drag-end', async (event, data: { workspacePath: string; dropEffect: string; isOnlyProject: boolean }) => {
    const workspacePath = data?.workspacePath;
    if (!workspacePath || typeof workspacePath !== 'string') {
      return { success: false, error: 'workspacePath required' };
    }
    const sourceWindowId = getWindowIdForWindow(BrowserWindow.fromWebContents(event.sender));
    const drag = pendingDrag;
    // A target window already took it, or this is a stale end.
    if (!drag || drag.workspacePath !== workspacePath || drag.sourceWindowId !== sourceWindowId) {
      return { success: true, action: 'none' };
    }

    const cursor = screen.getCursorScreenPoint();
    const windowBounds = BrowserWindow.getAllWindows()
      .filter(w => !w.isDestroyed() && w.isVisible() && !w.isMinimized())
      .map(w => w.getBounds());
    if (!shouldTearOffRailProject({ dropEffect: data.dropEffect, isOnlyProject: data.isOnlyProject === true, cursor, windowBounds })) {
      // Leave the pending drag: a target's drop report can arrive after the
      // source's drag end. The next drag start replaces it.
      return { success: true, action: 'none' };
    }

    pendingDrag = null;
    try {
      await openWorkspaceWindow(workspacePath, { forceNewWindow: true, position: cursor });
    } catch (error) {
      logger.main.error('[RailDrag] Tear-off failed to open window:', error);
      return { success: false, error: String(error) };
    }
    releaseFromSource(drag);
    return { success: true, action: 'torn-off' };
  });
}
