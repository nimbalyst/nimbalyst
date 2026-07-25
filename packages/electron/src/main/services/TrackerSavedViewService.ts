/**
 * Team-shared tracker saved views: the IPC surface over `trackerSavedViewStore`.
 *
 * Mirrors `TrackerNavigationService`. A saved view starts life local-only (it
 * lives in workspace settings, owned by the renderer); sharing it moves it into
 * `tracker_shared_saved_views`, which is what the saved-view sync lane pushes to
 * the team's TrackerRoom. Unsharing tombstones the row so peers drop it too.
 *
 * The payload is an opaque JSON string end-to-end -- the renderer serializes a
 * `SavedView`, the store and the wire lane never look inside it. Keeping it
 * opaque means a view definition can gain fields without a schema migration on
 * either side.
 */

import { BrowserWindow } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import {
  applyRemoteSharedSavedView,
  listSharedSavedViews,
  removeSharedSavedView,
  upsertSharedSavedView,
  type ApplyRemoteSavedViewResult,
  type SharedSavedViewRecord,
} from './tracker/trackerSavedViewStore';

let initialized = false;
let flushSavedViews: ((workspacePath: string) => void | Promise<void>) | null = null;

export function registerTrackerSavedViewFlushHandler(
  handler: (workspacePath: string) => void | Promise<void>,
): void {
  flushSavedViews = handler;
}

function requestSavedViewFlush(workspacePath: string): void {
  if (flushSavedViews) void flushSavedViews(workspacePath);
}

function notifySavedViewsChanged(workspacePath: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('tracker-saved-views:changed', { workspacePath });
  }
}

export async function shareWorkspaceTrackerView(
  workspacePath: string,
  view: SharedSavedViewRecord,
): Promise<SharedSavedViewRecord[]> {
  if (!workspacePath) throw new Error('workspacePath is required');
  await upsertSharedSavedView(workspacePath, view);
  notifySavedViewsChanged(workspacePath);
  requestSavedViewFlush(workspacePath);
  return listSharedSavedViews(workspacePath);
}

export async function unshareWorkspaceTrackerView(
  workspacePath: string,
  viewId: string,
): Promise<SharedSavedViewRecord[]> {
  if (!workspacePath || !viewId) throw new Error('workspacePath and viewId are required');
  await removeSharedSavedView(workspacePath, viewId);
  notifySavedViewsChanged(workspacePath);
  requestSavedViewFlush(workspacePath);
  return listSharedSavedViews(workspacePath);
}

export async function applyRemoteWorkspaceSharedSavedView(
  workspacePath: string,
  def: { viewId: string; payload: string | null; syncId: number },
): Promise<ApplyRemoteSavedViewResult> {
  const result = await applyRemoteSharedSavedView(workspacePath, def);
  if (result.applied) notifySavedViewsChanged(workspacePath);
  return result;
}

export function initTrackerSavedViewService(): void {
  if (initialized) return;
  initialized = true;
  safeHandle('tracker-saved-views:list', async (_event, workspacePath: string) => {
    return listSharedSavedViews(workspacePath);
  });
  safeHandle('tracker-saved-views:share', async (
    _event,
    workspacePath: string,
    view: SharedSavedViewRecord,
  ) => {
    return shareWorkspaceTrackerView(workspacePath, view);
  });
  safeHandle('tracker-saved-views:unshare', async (_event, workspacePath: string, viewId: string) => {
    return unshareWorkspaceTrackerView(workspacePath, viewId);
  });
}

export type { SharedSavedViewRecord };
