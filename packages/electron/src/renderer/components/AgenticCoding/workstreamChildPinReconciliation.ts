import type { SessionMeta } from '../../store';

type StateUpdater<T> = (updater: (previous: T) => T) => void;

interface ReconcileSessionPinToggleOptions {
  sessionId: string;
  isPinned: boolean;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  updateSessionStore: (payload: {
    sessionId: string;
    updates: Pick<SessionMeta, 'isPinned'>;
  }) => void;
  setSessions: StateUpdater<SessionMeta[]>;
  setWorkstreamChildrenCache: StateUpdater<Map<string, SessionMeta[]>>;
}

export function patchWorkstreamChildPin(
  cache: Map<string, SessionMeta[]>,
  sessionId: string,
  isPinned: boolean,
): Map<string, SessionMeta[]> {
  // The cache remains the membership snapshot. Only reconcile the mutable
  // field the expanded row renders directly from its cached SessionMeta.
  for (const [parentId, children] of cache) {
    const childIndex = children.findIndex(child => child.id === sessionId);
    if (childIndex === -1) continue;
    if (children[childIndex].isPinned === isPinned) return cache;

    const updatedChildren = [...children];
    updatedChildren[childIndex] = { ...updatedChildren[childIndex], isPinned };
    const updatedCache = new Map(cache);
    updatedCache.set(parentId, updatedChildren);
    return updatedCache;
  }

  return cache;
}

export async function reconcileSessionPinToggle({
  sessionId,
  isPinned,
  invoke,
  updateSessionStore,
  setSessions,
  setWorkstreamChildrenCache,
}: ReconcileSessionPinToggleOptions): Promise<void> {
  await invoke('sessions:update-pinned', sessionId, isPinned);
  updateSessionStore({ sessionId, updates: { isPinned } });
  setSessions(previous =>
    previous.map(session => session.id === sessionId ? { ...session, isPinned } : session),
  );
  setWorkstreamChildrenCache(previous =>
    patchWorkstreamChildPin(previous, sessionId, isPinned),
  );
}

export function workstreamChildrenNeedRefresh(
  cachedChildren: SessionMeta[] | undefined,
  childCount: number,
  registrySnapshot: Map<string, SessionMeta>,
  registryDescendantCount = 0,
  /** childCount the cached list was fetched for; archived children make the list shorter. */
  fetchedForCount?: number,
): boolean {
  if (cachedChildren && fetchedForCount === childCount) {
    return cachedChildren.some(child => !registrySnapshot.has(child.id));
  }
  // sessions:list already returns every child, so a cold cache alone is no reason
  // to fetch. Fetching every parent on mount saturated the database worker.
  if (!cachedChildren && registryDescendantCount >= childCount) {
    return false;
  }
  // Field-only registry changes must not restart sessions:list-children.
  // Refresh only when membership changed or a cached child disappeared.
  if (!cachedChildren || cachedChildren.length !== childCount) {
    return true;
  }

  return cachedChildren.some(child => !registrySnapshot.has(child.id));
}

/** Descendants per ancestor already present in the registry, in one pass. Cycle-safe. */
export function countRegistryDescendants(registry: ReadonlyMap<string, SessionMeta>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const session of registry.values()) {
    const seen = new Set([session.id]);
    for (let parentId = session.parentSessionId; parentId && registry.has(parentId) && !seen.has(parentId); parentId = registry.get(parentId)!.parentSessionId) {
      seen.add(parentId);
      counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
    }
  }
  return counts;
}
