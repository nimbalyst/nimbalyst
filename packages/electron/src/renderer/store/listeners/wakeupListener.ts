/**
 * Centralized IPC listener for session wakeups.
 *
 * Subscribes once at app startup to `wakeup:changed` IPC events and updates
 * the per-session `sessionWakeupAtom` so any component (banner, list row,
 * notification) reads from atoms only.
 *
 * Components MUST NOT subscribe to `wakeup:changed` directly.
 */

import { store } from '../index';
import { sessionWakeupAtom, type SessionWakeupView } from '../atoms/sessions';

const ACTIVE_STATUSES: ReadonlyArray<SessionWakeupView['status']> = [
  'pending',
  'firing',
  'waiting_for_workspace',
  'overdue',
];

export function initWakeupListeners(): () => void {
  const cleanups: Array<() => void> = [];

  const handleChanged = (row: SessionWakeupView | null | undefined) => {
    if (!row || !row.sessionId) return;
    if (ACTIVE_STATUSES.includes(row.status)) {
      store.set(sessionWakeupAtom(row.sessionId), row);
    } else {
      // fired / cancelled / failed — clear the atom only if this row was the one shown.
      const current = store.get(sessionWakeupAtom(row.sessionId));
      if (!current || current.id === row.id) {
        store.set(sessionWakeupAtom(row.sessionId), null);
      }
    }
  };

  cleanups.push(window.electronAPI.on('wakeup:changed', handleChanged));

  // On startup, hydrate active wakeups for the current workspace.
  void hydrateInitialWakeups();

  return () => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  };
}

async function hydrateInitialWakeups(): Promise<void> {
  try {
    const initialState = await window.electronAPI.invoke('get-initial-state');
    const workspacePath: string | undefined =
      initialState?.workspacePath || initialState?.workspaceFolder;
    const rows: SessionWakeupView[] = await window.electronAPI.invoke(
      'wakeup:list-active',
      workspacePath,
    );
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row?.sessionId && ACTIVE_STATUSES.includes(row.status)) {
          store.set(sessionWakeupAtom(row.sessionId), row);
        }
      }
    }
  } catch {
    // initial-state may not be ready yet; the listener will hydrate as
    // wakeup:changed events arrive.
  }
}
