import type { CachedSessionIndex } from './sessionIndexMetadata';

type Listener = (sessionId: string, entry: CachedSessionIndex) => void;

/** Await asynchronous consumers and isolate their failures from replication. */
export async function dispatchIndexChange(listeners: Iterable<Listener>, entry: CachedSessionIndex): Promise<void> {
  await Promise.all([...listeners].map(async callback => {
    try { await callback(entry.sessionId, entry); }
    catch (error) { console.error('[CollabV3] Error in index change listener:', error); }
  }));
}

/** Bootstrap must reconcile hierarchy even when no execution queue exists. */
export async function reconcileFetchedIndex(
  entries: Iterable<Pick<CachedSessionIndex, 'sessionId' | 'parentSessionId' | 'queuedPrompts'>>,
  cache: Map<string, CachedSessionIndex>,
  listeners: Iterable<Listener>,
  hierarchyListeners: Iterable<Listener> = [],
): Promise<void> {
  for (const entry of entries) {
    if (entry.parentSessionId === undefined && !entry.queuedPrompts?.length) continue;
    const current = cache.get(entry.sessionId);
    if (current) await dispatchIndexChange(entry.queuedPrompts?.length ? listeners : hierarchyListeners, current);
  }
}

/** A server-only view: optimistic sends must never masquerade as acknowledgements. */
export function createHierarchySnapshotDispatch(isAvailable: () => boolean) {
  type Row = import('./types').HierarchyIndexRow;
  type Listener = import('./types').HierarchySnapshotListener;
  const rows = new Map<string, Row>();
  const listeners = new Set<Listener>();
  let generation = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelRetry = () => { clearTimeout(retryTimer); retryTimer = undefined; };
  const retry = () => {
    if (retryTimer || !listeners.size || !isAvailable()) return;
    retryTimer = setTimeout(() => { retryTimer = undefined; void notify(); }, 5000);
    if (typeof retryTimer === 'object') retryTimer.unref?.();
  };
  async function notify(targets: Iterable<Listener> = listeners) {
    if (!isAvailable()) return;
    const version = generation;
    const snapshot = [...rows.values()];
    const isCurrent = () => version === generation && isAvailable();
    await Promise.all([...targets].map(async listener => {
      try { await listener(snapshot, isCurrent); }
      catch (error) {
        console.error('[CollabV3] Hierarchy snapshot reconciliation failed; retrying latest snapshot:', error);
        retry();
      }
    }));
  }
  return {
    replace(entries: Iterable<Row>) {
      rows.clear();
      for (const row of entries) rows.set(row.sessionId, row);
      generation++;
    },
    update(row: Row) { rows.set(row.sessionId, row); generation++; },
    invalidate() { generation++; cancelRetry(); },
    clear() { rows.clear(); generation++; cancelRetry(); },
    notify,
    subscribe(listener: Listener) {
      listeners.add(listener);
      void notify([listener]);
      return () => { listeners.delete(listener); if (!listeners.size) cancelRetry(); };
    },
  };
}

export function createIndexChangeSubscriptions(cache: Map<string, CachedSessionIndex>, isVerified: () => boolean) {
  const listeners = new Set<Listener>();
  const hierarchyListeners = new Set<Listener>();
  return {
    listeners,
    hierarchyListeners,
    subscribe(callback: Listener, options?: { replayHierarchy?: boolean }) {
      listeners.add(callback);
      if (options?.replayHierarchy) hierarchyListeners.add(callback);
      if (isVerified()) void reconcileFetchedIndex(cache.values(), cache, [callback], options?.replayHierarchy ? [callback] : []);
      return () => { listeners.delete(callback); hierarchyListeners.delete(callback); };
    },
  };
}

/** Apply a prepared replication page; graph reconciliation waits for the full drain. */
export async function applyReplicatedSessionRows(
  applied: Iterable<{entity: string; id: string; revision: number; deleted?: boolean}>,
  entries: ReadonlyMap<string, CachedSessionIndex>,
  remove: (id: string) => void,
  accept: (entry: CachedSessionIndex) => void | Promise<void>,
) {
  for (const change of applied) {
    if (change.entity !== 'session') continue;
    if (change.deleted) { remove(change.id); continue; }
    const entry = entries.get(`${change.id}:${change.revision}`);
    if (entry) await accept(entry);
  }
}
