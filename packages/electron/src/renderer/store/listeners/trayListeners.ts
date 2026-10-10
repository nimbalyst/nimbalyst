import { selectSessionActionAtom } from '../actions/sessionHistoryActions';
/**
 * Centralized IPC listeners for tray navigation events
 *
 * Follows the pattern from IPC_LISTENERS.md:
 * - Components NEVER subscribe to IPC events directly
 * - Central listeners update atoms
 * - Components read from atoms
 */

import { atom } from 'jotai';
import { store } from '../index';
import {
  sessionLastReadAtom,
  sessionUnreadAtom,
} from '../atoms/sessions';
import { clearSessionUnreadAtom } from '../atoms/sessionActivity';
import { setWindowModeAtom } from '../atoms/windowMode';
import { syncConfigAtom, type SyncConfig } from '../atoms/appSettings';

/**
 * Atom that signals a new session should be created.
 * Set to true by the tray listener, consumed by AgentMode.
 */
export const trayNewSessionRequestAtom = atom(false);

/**
 * Initialize tray navigation IPC listeners.
 * Should be called once at app startup (from AgentMode).
 */
export function initTrayListeners(): () => void {
  const cleanups: Array<() => void> = [];

  // Handle tray:navigate-to-session from main process
  // When user clicks a session in the tray menu, navigate to it.
  // Replicates the logic from AgentMode.handleSessionSelect.
  const handleNavigateToSession = (data: { sessionId: string; workspacePath: string }) => {
    const { sessionId, workspacePath } = data;
    if (!sessionId || !workspacePath) return;

    // Switch to agent mode (kanban exit is handled globally by
    // onWorkstreamSelectedCallbackAtom when setSelectedWorkstreamAtom fires)
    store.set(setWindowModeAtom, 'agent');

    void store.set(selectSessionActionAtom, sessionId);
  };

  cleanups.push(
    window.electronAPI.on('tray:navigate-to-session', handleNavigateToSession)
  );

  const handleClearUnread = (data: {
    sessions: Array<{ sessionId: string; workspacePath: string; lastReadAt: number }>;
  }) => {
    for (const session of data.sessions) {
      store.set(sessionUnreadAtom(session.sessionId), false);
      store.set(sessionLastReadAtom(session.sessionId), session.lastReadAt);
      store.set(clearSessionUnreadAtom, {
        sessionId: session.sessionId,
        workspacePath: session.workspacePath,
      });
    }
  };

  cleanups.push(
    window.electronAPI.on('tray:clear-unread', handleClearUnread)
  );

  // Handle tray:new-session from main process
  // Switch to agent mode and signal that a new session should be created
  const handleNewSession = () => {
    store.set(setWindowModeAtom, 'agent');
    store.set(trayNewSessionRequestAtom, true);
  };

  cleanups.push(
    window.electronAPI.on('tray:new-session', handleNewSession)
  );

  // Handle sync:config-updated from main process (e.g. tray Keep Awake toggle)
  // Updates the Jotai atom so the SyncPanel UI stays in sync
  const handleSyncConfigUpdated = (config: SyncConfig) => {
    store.set(syncConfigAtom, config);
  };

  cleanups.push(
    window.electronAPI.on('sync:config-updated', handleSyncConfigUpdated)
  );

  return () => {
    cleanups.forEach(fn => fn?.());
  };
}
