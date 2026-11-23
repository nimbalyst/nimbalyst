import Store from 'electron-store';
import type { SyncConfig } from '@nimbalyst/runtime/sync/types';

type PendingSessionDeleteStorage = NonNullable<SyncConfig['pendingSessionDeletes']>;

/** The sync account a list of deletes belongs to. */
export interface PendingSessionDeletesScope {
  serverUrl: string;
  orgId: string;
  personalMemberId: string;
}

/**
 * Saves the session deletes the sync server has not heard about yet, so a
 * delete made while sync was down is still sent after the next app start
 * (GitHub #1901). The file is `pending-session-deletes.json` in the app data
 * folder. It holds session ids and times only.
 *
 * Each sync server and account gets its own list. A delete queued under one
 * account must never be sent, or cleared, by another account signed in later.
 */
interface PendingSessionDeletesSchema {
  /** Account key -> (session id -> time of the delete in ms). */
  byAccount: Record<string, Record<string, number>>;
}

function accountKey(scope: PendingSessionDeletesScope): string {
  if (!scope.serverUrl || !scope.orgId || !scope.personalMemberId) {
    throw new Error('Pending session deletes need a server URL, org id, and member id');
  }
  return JSON.stringify([scope.serverUrl, scope.orgId, scope.personalMemberId]);
}

export function createPendingSessionDeletesStorage(scope: PendingSessionDeletesScope): PendingSessionDeleteStorage {
  const key = accountKey(scope);
  const store = new Store<PendingSessionDeletesSchema>({
    name: 'pending-session-deletes',
    clearInvalidConfig: true,
    defaults: { byAccount: {} },
  });
  const readAll = (): Record<string, Record<string, number>> => {
    const all = store.get('byAccount');
    return all && typeof all === 'object' ? all : {};
  };
  return {
    load: () => {
      const saved = readAll()[key];
      return saved && typeof saved === 'object' ? saved : {};
    },
    save: (next) => {
      const all = { ...readAll() };
      if (Object.keys(next).length) all[key] = next;
      else delete all[key];
      store.set('byAccount', all);
    },
  };
}
