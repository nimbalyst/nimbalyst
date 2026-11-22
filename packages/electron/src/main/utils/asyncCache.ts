/**
 * Small in-memory async caching primitives for main-process hot paths that
 * get fanned out from many concurrent callers (workspace open, doc/tracker
 * room open, sync init). See nimbalyst-local/investigations/collab-open-latency.md
 * (RC2, RC4) for the motivating measurements.
 */

/**
 * Collapse concurrent calls for the same key into one in-flight promise. Once
 * the call settles (success or failure) the entry is dropped, so the next
 * call for that key always starts a fresh request -- this only removes
 * duplicate work from a BURST of near-simultaneous callers, it does not
 * memoize results across time.
 */
export function createSingleFlight<K, V>(): (key: K, fetcher: () => Promise<V>) => Promise<V> {
  const inFlight = new Map<K, Promise<V>>();

  return (key: K, fetcher: () => Promise<V>): Promise<V> => {
    const existing = inFlight.get(key);
    if (existing) return existing;

    const promise = fetcher().finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  };
}

export interface TtlCache<K, V> {
  get(key: K, fetcher: () => Promise<V>): Promise<V>;
  invalidate(key?: K): void;
}

/**
 * Memoize an async lookup per key for `ttlMs`. Concurrent callers within the
 * TTL window (including a fresh call racing an in-flight one) share the same
 * promise -- this is single-flight AND memoization combined. A rejected
 * lookup is evicted immediately so a transient failure doesn't pin a
 * rejected promise for the whole window.
 */
export function createTtlCache<K, V>(ttlMs: number): TtlCache<K, V> {
  const entries = new Map<K, { promise: Promise<V>; expiresAt: number }>();

  return {
    get(key: K, fetcher: () => Promise<V>): Promise<V> {
      const now = Date.now();
      const cached = entries.get(key);
      if (cached && cached.expiresAt > now) return cached.promise;

      const promise = fetcher();
      entries.set(key, { promise, expiresAt: now + ttlMs });
      promise.catch(() => {
        if (entries.get(key)?.promise === promise) entries.delete(key);
      });
      return promise;
    },
    invalidate(key?: K): void {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
  };
}

/**
 * Like `createSingleFlight`, but every caller gets a result that STARTED after
 * its own call. A caller arriving while a run is in flight joins one trailing
 * run that starts when the current one settles, so a burst costs at most two
 * runs and a refresh triggered by a write mid-run still sees that write.
 */
export function createTrailingSingleFlight<K, V>(): (key: K, fetcher: () => Promise<V>) => Promise<V> {
  const running = new Map<K, Promise<V>>();
  const trailing = new Map<K, Promise<V>>();

  const start = (key: K, fetcher: () => Promise<V>): Promise<V> => {
    const promise = fetcher().finally(() => {
      if (running.get(key) === promise) running.delete(key);
    });
    running.set(key, promise);
    return promise;
  };

  return (key: K, fetcher: () => Promise<V>): Promise<V> => {
    const current = running.get(key);
    if (!current) return start(key, fetcher);
    const queued = trailing.get(key);
    if (queued) return queued;
    const next = current.then(() => undefined, () => undefined).then(() => {
      trailing.delete(key);
      return start(key, fetcher);
    });
    trailing.set(key, next);
    return next;
  };
}
