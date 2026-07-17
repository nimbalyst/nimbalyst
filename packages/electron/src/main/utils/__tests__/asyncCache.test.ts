import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSingleFlight, createTtlCache } from '../asyncCache';

describe('createSingleFlight', () => {
  it('collapses N concurrent calls for the same key into 1 upstream fetch', async () => {
    let resolveFetch: (value: string) => void;
    const fetchPromise = new Promise<string>((resolve) => { resolveFetch = resolve; });
    const fetcher = vi.fn(() => fetchPromise);
    const singleFlight = createSingleFlight<string, string>();

    const calls = Array.from({ length: 5 }, () => singleFlight('org-1', fetcher));
    resolveFetch!('result');
    const results = await Promise.all(calls);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results).toEqual(['result', 'result', 'result', 'result', 'result']);
  });

  it('does not dedupe sequential (non-overlapping) calls', async () => {
    const fetcher = vi.fn(async () => 'result');
    const singleFlight = createSingleFlight<string, string>();

    await singleFlight('org-1', fetcher);
    await singleFlight('org-1', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('dedupes independently per key', async () => {
    let resolveA: (value: string) => void;
    let resolveB: (value: string) => void;
    const fetcherA = vi.fn(() => new Promise<string>((resolve) => { resolveA = resolve; }));
    const fetcherB = vi.fn(() => new Promise<string>((resolve) => { resolveB = resolve; }));
    const singleFlight = createSingleFlight<string, string>();

    const a1 = singleFlight('org-1', fetcherA);
    const a2 = singleFlight('org-1', fetcherA);
    const b1 = singleFlight('org-2', fetcherB);

    resolveA!('a');
    resolveB!('b');
    await Promise.all([a1, a2, b1]);

    expect(fetcherA).toHaveBeenCalledTimes(1);
    expect(fetcherB).toHaveBeenCalledTimes(1);
  });

  it('shares a rejection across concurrent callers, then retries on the next call', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('recovered');
    const singleFlight = createSingleFlight<string, string>();

    const c1 = singleFlight('org-1', fetcher);
    const c2 = singleFlight('org-1', fetcher);
    await expect(c1).rejects.toThrow('boom');
    await expect(c2).rejects.toThrow('boom');
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Entry is dropped once the rejected promise settles -- next call retries.
    const c3 = await singleFlight('org-1', fetcher);
    expect(c3).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('createTtlCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses the cached result for concurrent and near-term calls within the TTL window', async () => {
    const fetcher = vi.fn(async () => 'result');
    const cache = createTtlCache<string, string>(60_000);

    const first = await cache.get('org-1', fetcher);
    vi.advanceTimersByTime(30_000);
    const second = await cache.get('org-1', fetcher);

    expect(first).toBe('result');
    expect(second).toBe('result');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refetches after the TTL expires', async () => {
    const fetcher = vi.fn(async () => 'result');
    const cache = createTtlCache<string, string>(60_000);

    await cache.get('org-1', fetcher);
    vi.advanceTimersByTime(60_001);
    await cache.get('org-1', fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('evicts a rejected lookup immediately so the next call retries without waiting for the TTL', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('recovered');
    const cache = createTtlCache<string, string>(60_000);

    await expect(cache.get('org-1', fetcher)).rejects.toThrow('boom');
    // Let the rejection's .catch() eviction microtask run.
    await Promise.resolve();
    const result = await cache.get('org-1', fetcher);

    expect(result).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('invalidate(key) clears only that key', async () => {
    const fetcherA = vi.fn(async () => 'a');
    const fetcherB = vi.fn(async () => 'b');
    const cache = createTtlCache<string, string>(60_000);

    await cache.get('org-1', fetcherA);
    await cache.get('org-2', fetcherB);
    cache.invalidate('org-1');
    await cache.get('org-1', fetcherA);
    await cache.get('org-2', fetcherB);

    expect(fetcherA).toHaveBeenCalledTimes(2);
    expect(fetcherB).toHaveBeenCalledTimes(1);
  });

  it('invalidate() with no key clears every entry', async () => {
    const fetcherA = vi.fn(async () => 'a');
    const fetcherB = vi.fn(async () => 'b');
    const cache = createTtlCache<string, string>(60_000);

    await cache.get('org-1', fetcherA);
    await cache.get('org-2', fetcherB);
    cache.invalidate();
    await cache.get('org-1', fetcherA);
    await cache.get('org-2', fetcherB);

    expect(fetcherA).toHaveBeenCalledTimes(2);
    expect(fetcherB).toHaveBeenCalledTimes(2);
  });
});
