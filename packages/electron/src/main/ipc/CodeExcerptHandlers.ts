/**
 * IPC for the code excerpt block: read the quoted file at HEAD so the
 * renderer can show whether the excerpt drifted. The workspace is the calling
 * window's own; a renderer cannot name another root.
 */

import * as path from 'node:path';
import { BrowserWindow, type IpcMainInvokeEvent } from 'electron';

import { safeHandle } from '../utils/ipcRegistry';
import { getWindowId } from '../window/WindowManager';
import { resolveSenderWorkspacePath } from '../window/captureWindowWorkspace';
import { readCodeExcerptFile } from '../services/codeExcerpt/readCodeExcerptFile';

function authorizedWorkspace(event: IpcMainInvokeEvent, requested: string): string {
  const window = BrowserWindow.fromWebContents(event.sender);
  const workspace = window
    ? resolveSenderWorkspacePath({ windowId: getWindowId(window), webContentsId: event.sender.id })
    : undefined;
  if (!workspace) throw new Error('Code excerpts need a workspace window');
  if (path.resolve(workspace) !== path.resolve(requested)) throw new Error('workspacePath does not match the calling window workspace');
  return workspace;
}

export function registerCodeExcerptHandlers(): void {
  safeHandle('code-excerpt:read', async (event, payload: { workspacePath?: unknown; path?: unknown }) => {
    if (typeof payload?.workspacePath !== 'string' || !payload.workspacePath) throw new Error('workspacePath is required');
    if (typeof payload.path !== 'string' || !payload.path) throw new Error('path is required');
    return readCodeExcerptFile(authorizedWorkspace(event, payload.workspacePath), payload.path);
  });
}
