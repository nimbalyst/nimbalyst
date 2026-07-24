/**
 * Central Sync Status Listener
 *
 * Subscribes to `sync:status-changed` ONCE and writes the latest partial
 * status to syncStatusUpdateAtom. Components watch the atom to refresh.
 *
 * Call initSyncListeners() once at app startup.
 */

import { store } from '@nimbalyst/runtime/store';
import { syncStatusUpdateAtom, type SyncStatusUpdate } from '../atoms/syncStatus';

let initialized = false;

export function initSyncListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const unsubscribe = window.electronAPI?.on?.(
    'sync:status-changed',
    (update: SyncStatusUpdate) => {
      store.set(syncStatusUpdateAtom, update);
    },
  );

  return () => {
    initialized = false;
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
  };
}
