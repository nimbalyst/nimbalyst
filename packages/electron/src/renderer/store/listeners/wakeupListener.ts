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
import { sessionErrorAtom } from '../atoms/sessionTranscript';

const ACTIVE_STATUSES: ReadonlyArray<SessionWakeupView['status']> = [
  'pending',
  'firing',
  'waiting_for_workspace',
  'overdue',
];

export function initWakeupListeners(): () => void {
  const cleanups: Array<() => void> = [];
  let disposed = false;
  let hydrationRetry: ReturnType<typeof setTimeout> | undefined;

  const handleChanged = (row: SessionWakeupView | null | undefined) => {
    if (!row || !row.sessionId) return;
    if (row.status === 'failed') {
      store.set(sessionErrorAtom(row.sessionId), {
        message: row.error || 'Scheduled wakeup failed',
        isWakeupError: true,
      });
      const current = store.get(sessionWakeupAtom(row.sessionId));
      if (!current || current.id === row.id) {
        store.set(sessionWakeupAtom(row.sessionId), null);
      }
      return;
    }
    if (ACTIVE_STATUSES.includes(row.status)) {
      const currentError = store.get(sessionErrorAtom(row.sessionId));
      if (currentError?.isWakeupError) {
        // Re-arming/firing is an explicit retry of the failed wakeup.
        store.set(sessionErrorAtom(row.sessionId), null);
      }
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

  const hydrateInitialWakeups = async (attempt = 0): Promise<void> => {
    try {
      const initialState = await window.electronAPI.invoke('get-initial-state');
      const workspacePath: string | undefined =
        initialState?.workspacePath || initialState?.workspaceFolder;
      const rows: SessionWakeupView[] = await window.electronAPI.invoke(
        'wakeup:list-active',
        workspacePath,
      );
      if (disposed) return;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row?.sessionId && ACTIVE_STATUSES.includes(row.status)) {
            handleChanged(row);
          }
        }
      }
    } catch {
      // Renderer startup can race workspace hydration. Retry once, then rely
      // on authoritative wakeup:changed events instead of starting a poller.
      if (!disposed && attempt === 0) {
        hydrationRetry = setTimeout(() => {
          hydrationRetry = undefined;
          void hydrateInitialWakeups(1);
        }, 250);
      }
    }
  };

  // On startup, hydrate active wakeups for the current workspace.
  void hydrateInitialWakeups();

  return () => {
    disposed = true;
    if (hydrationRetry) clearTimeout(hydrationRetry);
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  };
}
