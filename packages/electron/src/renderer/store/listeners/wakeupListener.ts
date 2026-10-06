/**
 * Centralized IPC listener for session wakeups.
 *
 * Subscribes once at app startup to `wakeup:changed` IPC events and updates
 * the per-session `sessionWakeupsAtom` so any component (banner, list row,
 * notification) reads from atoms only. The merge rules live in wakeupList.ts.
 *
 * Components MUST NOT subscribe to `wakeup:changed` directly.
 */

import { store } from '../index';
import { sessionWakeupsAtom, type SessionWakeupView } from '../atoms/sessions';
import { applyWakeupChange, groupActiveWakeups } from './wakeupList';

export function initWakeupListeners(): () => void {
  const cleanups: Array<() => void> = [];

  const handleChanged = (row: SessionWakeupView | null | undefined) => {
    if (!row || !row.sessionId) return;
    const atom = sessionWakeupsAtom(row.sessionId);
    store.set(atom, applyWakeupChange(store.get(atom), row));
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
      for (const [sessionId, list] of groupActiveWakeups(rows)) {
        store.set(sessionWakeupsAtom(sessionId), list);
      }
    }
  } catch {
    // initial-state may not be ready yet; the listener will hydrate as
    // wakeup:changed events arrive.
  }
}
