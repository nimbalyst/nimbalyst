import Store from 'electron-store';
import type { SyncConfig } from '@nimbalyst/runtime/sync/types';

type PendingSessionDeleteStorage = NonNullable<SyncConfig['pendingSessionDeletes']>;

/**
 * Saves the session deletes the sync server has not heard about yet, so a
 * delete made while sync was down is still sent after the next app start
 * (GitHub #1901). The file is `pending-session-deletes.json` in the app data
 * folder. It holds session ids and times only. The same electron-store
 * package keeps the deleted external session ids.
 */
interface PendingSessionDeletesSchema {
  /** Session id -> time of the delete in ms. */
  deletes: Record<string, number>;
}

export function createPendingSessionDeletesStorage(): PendingSessionDeleteStorage {
  const store = new Store<PendingSessionDeletesSchema>({
    name: 'pending-session-deletes',
    clearInvalidConfig: true,
    defaults: { deletes: {} },
  });
  return {
    load: () => {
      const saved = store.get('deletes');
      return saved && typeof saved === 'object' ? saved : {};
    },
    save: (next) => store.set('deletes', next),
  };
}
