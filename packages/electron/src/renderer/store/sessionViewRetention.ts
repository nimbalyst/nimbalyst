/**
 * Which sessions keep their full transcript in renderer memory.
 *
 * A session's messages (base64 image results included) used to stay in
 * `sessionStoreAtom` until its workspace closed. Transcript viewers now hold a
 * reference while mounted; once released, a session stays resident only while
 * it is among the most recently viewed. Everything else is evicted, keeping
 * its metadata, and reloads when a viewer mounts again.
 */

import type { createStore } from 'jotai';
import { store as defaultStore } from '@nimbalyst/runtime/store';
import { evictSessionMessagesAtom, isSessionDataResident, sessionStoreAtom } from './atoms/sessions';

type Store = ReturnType<typeof createStore>;

export const RECENTLY_VIEWED_RETAINED = 8;

export interface SessionViewRetention {
  acquire(sessionId: string): () => void;
  /** Evict what is no longer retained; call when a busy session settles. */
  sweep(): void;
}

export function createSessionViewRetention(store: Store, retained = RECENTLY_VIEWED_RETAINED): SessionViewRetention {
  const viewers = new Map<string, number>();
  // Released sessions, least recently viewed first.
  const recent: string[] = [];

  const sweep = () => {
    const keep = new Set([...viewers.keys(), ...recent.slice(-retained)]);
    for (const sessionId of sessionStoreAtom.getParams()) {
      if (keep.has(sessionId) || !isSessionDataResident(store.get(sessionStoreAtom(sessionId)))) continue;
      // A busy session stays resident; the next sweep after it settles evicts it.
      store.set(evictSessionMessagesAtom, sessionId);
    }
    if (recent.length > retained) recent.splice(0, recent.length - retained);
  };

  return {
    acquire(sessionId) {
      viewers.set(sessionId, (viewers.get(sessionId) ?? 0) + 1);
      const index = recent.indexOf(sessionId);
      if (index >= 0) recent.splice(index, 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = (viewers.get(sessionId) ?? 1) - 1;
        if (count > 0) {
          viewers.set(sessionId, count);
          return;
        }
        viewers.delete(sessionId);
        recent.push(sessionId);
        sweep();
      };
    },
    sweep,
  };
}

export const sessionViewRetention = createSessionViewRetention(defaultStore);
