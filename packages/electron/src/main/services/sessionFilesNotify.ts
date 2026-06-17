/**
 * Single notification point for session_files writes (NIM-816).
 *
 * Every writer of session-file links (SessionFileTracker — fed by both the SDK
 * streaming loop and the CLI observation path — plus the watcher-attribution
 * service) must call `notifySessionFilesUpdated` after a successful row write
 * so that:
 *
 *   1. the `session-files:get-by-session` IPC cache is invalidated (writers
 *      that broadcast without invalidating let the renderer re-query into a
 *      stale empty result — the original NIM-816 failure), and
 *   2. every window receives `session-files:updated` (the renderer listener
 *      filters by sessionId), keeping the FilesEditedSidebar live for
 *      providers with no IPC-event-bearing streaming loop (claude-code-cli).
 *
 * The cache invalidator is registered by SessionFileHandlers at setup to
 * avoid a services → ipc import cycle.
 */

import { BrowserWindow } from 'electron';

type CacheInvalidator = (sessionId: string) => void;

let cacheInvalidator: CacheInvalidator | null = null;

export function registerSessionFilesCacheInvalidator(fn: CacheInvalidator): void {
  cacheInvalidator = fn;
}

export function notifySessionFilesUpdated(sessionId: string): void {
  try {
    cacheInvalidator?.(sessionId);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('session-files:updated', sessionId);
      }
    }
  } catch (err) {
    // Notification is best-effort — never let it break the write path.
    console.warn('[sessionFilesNotify] Failed to notify session-files update:', err);
  }
}
