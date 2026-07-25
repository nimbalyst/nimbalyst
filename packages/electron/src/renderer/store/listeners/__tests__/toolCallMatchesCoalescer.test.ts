import { describe, it, expect, vi } from 'vitest';
import { createToolCallMatchesCoalescer } from '../toolCallMatchesCoalescer';

describe('createToolCallMatchesCoalescer', () => {
  it('shares one in-flight request per session (single-flight)', async () => {
    let resolve!: (v: number) => void;
    const fetch = vi.fn(
      (_sessionId: string) => new Promise<number>((r) => { resolve = r; })
    );
    const c = createToolCallMatchesCoalescer<number>(fetch, 500, () => 0);

    const p1 = c.get('s1');
    const p2 = c.get('s1');
    const p3 = c.get('s1');
    expect(fetch).toHaveBeenCalledTimes(1); // three callers, one fetch

    resolve(42);
    expect(await Promise.all([p1, p2, p3])).toEqual([42, 42, 42]);
  });

  it('serves from cache within TTL and refetches after it expires', async () => {
    let t = 1000;
    const fetch = vi.fn(async (sessionId: string) => `${sessionId}:${fetch.mock.calls.length}`);
    const c = createToolCallMatchesCoalescer<string>(fetch, 500, () => t);

    const a = await c.get('s1'); // fetch #1
    const b = await c.get('s1'); // cache hit
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(1);

    t += 600; // move past the TTL
    await c.get('s1'); // fetch #2
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keys sessions independently', async () => {
    const fetch = vi.fn(async (sessionId: string) => sessionId.toUpperCase());
    const c = createToolCallMatchesCoalescer<string>(fetch, 500, () => 0);

    expect(await c.get('a')).toBe('A');
    expect(await c.get('b')).toBe('B');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('invalidate() drops both cache and in-flight for a session', async () => {
    const fetch = vi.fn(async (sessionId: string) => `${sessionId}:${fetch.mock.calls.length}`);
    const c = createToolCallMatchesCoalescer<string>(fetch, 10_000, () => 0);

    await c.get('s1'); // fetch #1, cached
    c.invalidate('s1');
    await c.get('s1'); // cache dropped -> fetch #2
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache a rejected fetch', async () => {
    let shouldFail = true;
    const fetch = vi.fn((_sessionId: string) =>
      shouldFail ? Promise.reject(new Error('boom')) : Promise.resolve('ok')
    );
    const c = createToolCallMatchesCoalescer<string>(fetch, 500, () => 0);

    await expect(c.get('s1')).rejects.toThrow('boom');
    shouldFail = false;
    expect(await c.get('s1')).toBe('ok'); // retried, not a cached rejection
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
