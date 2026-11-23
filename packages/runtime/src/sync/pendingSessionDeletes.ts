/**
 * Session deletes that the sync server has not heard about yet (GitHub #1901).
 *
 * A delete can be asked for while the sync connection is down, or while this
 * device may not write yet. The local delete still happens at once. The id goes
 * on this list instead, and the sync layer sends the delete when the index
 * connection is ready again. If the host gives a storage object, the list is
 * saved there, so a delete made just before the app quits is still sent after
 * the next start. Without storage, the list lives only until the app quits.
 *
 * Each entry keeps the time the delete was asked for, so a later "create"
 * of a session with the same id can cancel it. A stale delete must never
 * remove a session the user made again.
 */

/** Where the host saves the list. Keys are session ids, values are the time of the delete in ms. */
export interface PendingSessionDeleteStorage {
  load(): Record<string, number>;
  save(next: Record<string, number>): void;
}

/** Old entries drop first when the list gets this long. */
const MAX_PENDING_DELETES = 5000;

export interface PendingSessionDeletes {
  /** Record that a delete is waiting. Asking again for the same id keeps the first time. */
  add(sessionId: string): void;
  has(sessionId: string): boolean;
  /** Forget the delete: it was sent, or the session was made again. */
  remove(sessionId: string): void;
  ids(): string[];
}

export function createPendingSessionDeletes(storage?: PendingSessionDeleteStorage): PendingSessionDeletes {
  const entries = new Map<string, number>();
  try {
    for (const [id, at] of Object.entries(storage?.load() ?? {})) {
      if (typeof at === 'number') entries.set(id, at);
    }
  } catch (error) {
    // A list that cannot be read is treated as empty. Sync still works.
    console.warn('[CollabV3] Could not read the pending session deletes:', error);
  }

  const persist = (): void => {
    try {
      storage?.save(Object.fromEntries(entries));
    } catch (error) {
      console.warn('[CollabV3] Could not save the pending session deletes:', error);
    }
  };

  return {
    add(sessionId) {
      if (entries.has(sessionId)) return;
      entries.set(sessionId, Date.now());
      while (entries.size > MAX_PENDING_DELETES) entries.delete(entries.keys().next().value!);
      persist();
    },
    has: (sessionId) => entries.has(sessionId),
    remove(sessionId) {
      if (entries.delete(sessionId)) persist();
    },
    ids: () => [...entries.keys()],
  };
}
