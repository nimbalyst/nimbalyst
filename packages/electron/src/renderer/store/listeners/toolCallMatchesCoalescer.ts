/**
 * Per-session coalescer for `session-files:get-tool-call-matches`.
 *
 * `enrichEditsWithToolCallMatches` runs both on the (debounced)
 * `session-files:updated` path and, un-debounced, during the initial
 * multi-session file-state load. The underlying IPC resolves against a
 * single-threaded PGLite worker, so a burst of concurrent calls (open
 * windows × active sessions) serializes there and can block the main thread
 * for seconds. This shares one in-flight request per session and briefly
 * caches its result, so a burst collapses to a single worker round-trip.
 *
 * Dependency-free and time-injectable so it can be unit-tested without the
 * IPC/store graph.
 */
export function createToolCallMatchesCoalescer<T>(
  fetch: (sessionId: string) => Promise<T>,
  ttlMs: number,
  now: () => number = () => Date.now()
): {
  get: (sessionId: string) => Promise<T>;
  invalidate: (sessionId: string) => void;
} {
  const inFlight = new Map<string, Promise<T>>();
  const cache = new Map<string, { ts: number; value: T }>();

  return {
    get(sessionId: string): Promise<T> {
      const cached = cache.get(sessionId);
      if (cached && now() - cached.ts < ttlMs) {
        return Promise.resolve(cached.value);
      }
      const pending = inFlight.get(sessionId);
      if (pending) {
        return pending;
      }
      const p = fetch(sessionId)
        .then((value) => {
          cache.set(sessionId, { ts: now(), value });
          return value;
        })
        .finally(() => {
          // Only clear if we are still the current in-flight request for the key.
          if (inFlight.get(sessionId) === p) {
            inFlight.delete(sessionId);
          }
        });
      inFlight.set(sessionId, p);
      return p;
    },

    invalidate(sessionId: string): void {
      cache.delete(sessionId);
      inFlight.delete(sessionId);
    },
  };
}
