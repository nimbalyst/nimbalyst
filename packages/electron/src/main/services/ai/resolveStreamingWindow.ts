import type { BrowserWindow } from 'electron';
import { findWindowByWorkspace } from '../../window/WindowManager';

/** A turn can outlive its sender. Resolve its current workspace, never an unrelated window. */
export function resolveStreamingWindow(workspacePath: string): BrowserWindow | null {
  const window = findWindowByWorkspace(workspacePath);
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return null;
  }
  return window;
}
