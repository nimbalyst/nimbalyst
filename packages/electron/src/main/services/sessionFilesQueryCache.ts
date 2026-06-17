/**
 * Short-lived query cache for `session-files:get-by-session` (NIM-816).
 *
 * Exists to absorb the burst of identical queries fired when several
 * components mount at once, WITHOUT serving stale data after a write. The
 * original inline cache in SessionFileHandlers was only invalidated from the
 * `session-files:add-link` IPC handler — direct-DB writers
 * (SessionFileTracker, WorkspaceFileEditAttributionService) never cleared it,
 * so a query racing a row insert could pin an empty result for the TTL and,
 * combined with the renderer's one-shot initial load, leave the
 * FilesEditedSidebar empty until something else broadcast.
 *
 * Invalidation here is epoch-based so it also defeats in-flight queries: a
 * query that STARTED before an invalidation may resolve with pre-write data;
 * its result is returned to its original callers but never cached, and new
 * callers start a fresh query instead of joining it.
 */

export interface SessionFilesQueryCache<T> {
  /** Serve from cache / join a fresh in-flight query / run `query`. */
  get(sessionId: string, linkType: string | undefined, query: () => Promise<T>): Promise<T>;
  /** Drop all cached and in-flight state for a session (all linkTypes). */
  invalidate(sessionId: string): void;
}

export function createSessionFilesQueryCache<T>(
  ttlMs: number,
  now: () => number = () => Date.now()
): SessionFilesQueryCache<T> {
  const cache = new Map<string, { value: T; timestamp: number }>();
  const inFlight = new Map<string, Promise<T>>();
  const epochs = new Map<string, number>();

  const keyFor = (sessionId: string, linkType?: string) =>
    linkType ? `${sessionId}:${linkType}` : sessionId;
  const epochOf = (sessionId: string) => epochs.get(sessionId) ?? 0;

  return {
    async get(sessionId, linkType, query) {
      const key = keyFor(sessionId, linkType);

      const cached = cache.get(key);
      if (cached && now() - cached.timestamp < ttlMs) {
        return cached.value;
      }

      const pending = inFlight.get(key);
      if (pending) {
        return pending;
      }

      const startEpoch = epochOf(sessionId);
      const promise = query();
      inFlight.set(key, promise);
      try {
        const value = await promise;
        // Only cache if no invalidation happened while the query was in
        // flight — a stale (pre-write) result must not outlive the write.
        if (epochOf(sessionId) === startEpoch) {
          cache.set(key, { value, timestamp: now() });
        }
        return value;
      } finally {
        // Only clear our own entry — an invalidation may have already
        // replaced it with a newer in-flight query.
        if (inFlight.get(key) === promise) {
          inFlight.delete(key);
        }
      }
    },

    invalidate(sessionId) {
      for (const key of cache.keys()) {
        if (key === sessionId || key.startsWith(`${sessionId}:`)) {
          cache.delete(key);
        }
      }
      for (const key of inFlight.keys()) {
        if (key === sessionId || key.startsWith(`${sessionId}:`)) {
          inFlight.delete(key);
        }
      }
      epochs.set(sessionId, epochOf(sessionId) + 1);
    },
  };
}
