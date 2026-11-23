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
  /**
   * Whether an upload of this session may go out. A delete wins over any
   * upload stamped at or before it: such an upload was built from the session
   * before it was deleted, and sending it would bring the session back. An
   * upload stamped after the delete is the same id made again; it cancels the
   * waiting delete.
   */
  allowsUpload(sessionId: string, updatedAt: number | undefined): boolean;
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
    allowsUpload(sessionId, updatedAt) {
      const deletedAt = entries.get(sessionId);
      if (deletedAt === undefined) return true;
      if (updatedAt === undefined || updatedAt <= deletedAt) return false;
      entries.delete(sessionId);
      persist();
      return true;
    },
    ids: () => [...entries.keys()],
  };
}

/** WebSocket.OPEN, spelled out so this runs where the global is absent. */
const SOCKET_OPEN = 1;

/**
 * Put an `indexDelete` on the index socket. True only when the socket was open
 * and took the frame: a closing socket drops it silently, and a throwing one
 * loses it, so the caller keeps the delete waiting in both cases.
 */
export function sendIndexDelete(socket: { readyState: number; send(data: string): void }, sessionId: string): boolean {
  if (socket.readyState !== SOCKET_OPEN) return false;
  try {
    socket.send(JSON.stringify({ type: 'indexDelete', sessionId }));
    return true;
  } catch (error) {
    console.warn('[CollabV3] Index delete was not sent; it stays waiting:', sessionId, error);
    return false;
  }
}
