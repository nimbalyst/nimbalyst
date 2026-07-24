/**
 * Central Notification Listener
 *
 * Subscribes to `notifications:check-active-session` ONCE. The main process
 * uses this to ask "is the user currently viewing this session?" so it can
 * suppress OS notifications. We answer by reading activeSessionIdAtom from
 * the store and sending the response back.
 *
 * Call initNotificationListeners() once at app startup.
 */

import { store } from '@nimbalyst/runtime/store';
import { activeSessionIdAtom } from '../atoms/sessions';

let initialized = false;

export function initNotificationListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const unsubscribe = window.electronAPI?.on?.(
    'notifications:check-active-session',
    (data: { requestId: string; sessionId: string }) => {
      const activeSessionId = store.get(activeSessionIdAtom);
      const isViewing = activeSessionId === data.sessionId;
      // Main process uses ipcMain.once for the response, so use send.
      window.electronAPI?.send?.(
        `notifications:session-check-response:${data.requestId}`,
        isViewing,
      );
    },
  );

  return () => {
    initialized = false;
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
  };
}
