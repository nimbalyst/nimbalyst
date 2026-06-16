import { describe, it, expect } from 'vitest';
import { createSessionFilesQueryCache } from '../sessionFilesQueryCache';

/**
 * NIM-816: the session-files IPC cache served stale empty results to the
 * renderer after direct-DB writers (SessionFileTracker / watcher attribution)
 * inserted rows, because only the `session-files:add-link` IPC handler
 * invalidated it. The extracted cache must support invalidation that also
 * defeats in-flight queries started before the write.
 */
describe('sessionFilesQueryCache', () => {
  it('caches results within the TTL and dedupes concurrent queries', async () => {
    const cache = createSessionFilesQueryCache<string[]>(2000);
    let queries = 0;
    const query = async () => {
      queries += 1;
      return ['a'];
    };

    const [r1, r2] = await Promise.all([
      cache.get('s1', 'edited', query),
      cache.get('s1', 'edited', query),
    ]);
    expect(r1).toEqual(['a']);
    expect(r2).toEqual(['a']);
    expect(queries).toBe(1);

    // Within TTL: served from cache.
    await cache.get('s1', 'edited', query);
    expect(queries).toBe(1);
  });

  it('invalidate() makes the next get re-query', async () => {
    const cache = createSessionFilesQueryCache<string[]>(2000);
    let result = ['old'];
    const query = async () => result;

    expect(await cache.get('s1', 'edited', query)).toEqual(['old']);
    result = ['new'];
    cache.invalidate('s1');
    expect(await cache.get('s1', 'edited', query)).toEqual(['new']);
  });

  it('invalidates all linkType variants for the session', async () => {
    const cache = createSessionFilesQueryCache<string[]>(2000);
    let queries = 0;
    const query = async () => {
      queries += 1;
      return [];
    };
    await cache.get('s1', 'edited', query);
    await cache.get('s1', undefined, query);
    expect(queries).toBe(2);
    cache.invalidate('s1');
    await cache.get('s1', 'edited', query);
    await cache.get('s1', undefined, query);
    expect(queries).toBe(4);
  });

  it('does NOT cache a result from a query that started before an invalidation (stale write race)', async () => {
    const cache = createSessionFilesQueryCache<string[]>(2000);

    // Query 1 starts (sees pre-insert state: empty) but resolves AFTER the
    // row insert + invalidate. Its empty result must not be cached.
    let release1: (v: string[]) => void;
    const slowQuery = () => new Promise<string[]>((resolve) => { release1 = resolve; });

    const get1 = cache.get('s1', 'edited', slowQuery);
    cache.invalidate('s1'); // row inserted while query 1 in flight
    release1!([]); // query 1 resolves with stale empty data
    expect(await get1).toEqual([]); // original caller gets what it got

    // Next get must hit the DB again, not the stale cached [].
    let queried = false;
    const fresh = await cache.get('s1', 'edited', async () => {
      queried = true;
      return ['the-row'];
    });
    expect(queried).toBe(true);
    expect(fresh).toEqual(['the-row']);
  });

  it('does not let an invalidated in-flight query absorb new callers', async () => {
    const cache = createSessionFilesQueryCache<string[]>(2000);

    let releaseOld: (v: string[]) => void;
    const oldQuery = () => new Promise<string[]>((resolve) => { releaseOld = resolve; });
    const oldGet = cache.get('s1', 'edited', oldQuery);

    cache.invalidate('s1');

    // A caller arriving after invalidation must start a FRESH query rather
    // than joining the stale in-flight one.
    const fresh = await cache.get('s1', 'edited', async () => ['fresh']);
    expect(fresh).toEqual(['fresh']);

    releaseOld!(['stale']);
    expect(await oldGet).toEqual(['stale']);
  });

  it('does not bleed invalidation across sessions', async () => {
    const cache = createSessionFilesQueryCache<string[]>(2000);
    let queries = 0;
    const query = async () => {
      queries += 1;
      return [];
    };
    await cache.get('s1', 'edited', query);
    await cache.get('s2', 'edited', query);
    expect(queries).toBe(2);
    cache.invalidate('s1');
    await cache.get('s2', 'edited', query); // still cached
    expect(queries).toBe(2);
  });
});
