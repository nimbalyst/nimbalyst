/**
 * BodyDocCache tests
 *
 * Cover the four contracts phase 4a is supposed to deliver (see
 * `design/Collaboration/tracker-sync-redesign-phase-4-plan.md`):
 *
 *   1. acquire/release: refcounted sharing across multiple acquirers.
 *   2. LRU eviction at the soft cap; refcount>0 pins.
 *   3. Idle timeout destroys an unreferenced entry after the window.
 *   4. Prewarm throttle: at most N concurrent factory calls.
 *
 * `DocumentSyncProvider` is mocked so the tests don't open WebSockets.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BodyDocCache } from '../BodyDocCache';
import type { BodyDocConfigFactory } from '../BodyDocCache';

// ============================================================================
// Mock DocumentSyncProvider
// ============================================================================
//
// We mock `@nimbalyst/runtime/sync` so `new DocumentSyncProvider(config)`
// produces a tiny test double that records its `destroy()` call and
// exposes the wired-in `onStatusChange` so we can drive status events.

interface MockedSyncProvider {
  config: Record<string, unknown>;
  destroyed: boolean;
  destroy(): void;
  setRoomMetadata?(meta: unknown): void;
  acceptRemoteChanges?(): void;
  rejectRemoteChanges?(): void;
  getYDoc(): { destroy(): void };
}

const createdProviders: MockedSyncProvider[] = [];

vi.mock('@nimbalyst/runtime/sync', () => {
  class FakeYDoc {
    destroy(): void { /* no-op */ }
  }
  class DocumentSyncProvider {
    config: Record<string, unknown>;
    destroyed = false;
    private ydoc = new FakeYDoc();
    constructor(config: Record<string, unknown>) {
      this.config = config;
      createdProviders.push(this as unknown as MockedSyncProvider);
    }
    destroy(): void { this.destroyed = true; }
    setRoomMetadata(_meta: unknown): void { /* no-op */ }
    acceptRemoteChanges(): void { /* no-op */ }
    rejectRemoteChanges(): void { /* no-op */ }
    getYDoc(): { destroy(): void } { return this.ydoc; }
  }
  class CollabLexicalProvider {
    constructor(public sync: unknown, public options?: unknown) {}
  }
  return { DocumentSyncProvider, CollabLexicalProvider };
});

// ============================================================================
// Helpers
// ============================================================================

function makeFactory(): BodyDocConfigFactory {
  return async (itemId: string) => ({
    serverUrl: 'wss://test',
    getJwt: async () => 'jwt',
    orgId: 'org',
    documentKey: 'key' as unknown as CryptoKey,
    orgKeyFingerprint: 'fp',
    userId: 'user',
    documentId: `tracker-content/${itemId}`,
    createWebSocket: ((url: string) => ({ url } as unknown as WebSocket)),
  });
}

function makeFailingFactory(): BodyDocConfigFactory {
  return async () => null;
}

beforeEach(() => {
  createdProviders.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================================
// Tests
// ============================================================================

describe('BodyDocCache', () => {
  it('shares one DocumentSyncProvider across simultaneous acquirers', async () => {
    const cache = new BodyDocCache();
    const factory = makeFactory();
    const [a, b] = await Promise.all([
      cache.acquire('item-1', factory),
      cache.acquire('item-1', factory),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.syncProvider).toBe(b!.syncProvider);
    expect(createdProviders.length).toBe(1);
    a!.release();
    b!.release();
  });

  it('returns the same provider on serial acquire/release within the idle window', async () => {
    const cache = new BodyDocCache({ idleTimeoutMs: 60_000 });
    const factory = makeFactory();
    const first = await cache.acquire('item-1', factory);
    const initialProvider = first!.syncProvider;
    first!.release();
    // refCount is now 0 -- idle timer is running. Re-acquire inside the
    // window should hit the warm provider.
    vi.advanceTimersByTime(1000);
    const second = await cache.acquire('item-1', factory);
    expect(second!.syncProvider).toBe(initialProvider);
    expect(createdProviders.length).toBe(1);
    second!.release();
  });

  it('destroys the provider after the idle timeout with no acquirers', async () => {
    const cache = new BodyDocCache({ idleTimeoutMs: 60_000 });
    const acq = await cache.acquire('item-1', makeFactory());
    const provider = createdProviders[0];
    acq!.release();
    expect(provider.destroyed).toBe(false);
    vi.advanceTimersByTime(60_000 + 1);
    expect(provider.destroyed).toBe(true);
    expect(cache.has('item-1')).toBe(false);
  });

  it('clears the idle timer when reacquired before expiry', async () => {
    const cache = new BodyDocCache({ idleTimeoutMs: 60_000 });
    const acq = await cache.acquire('item-1', makeFactory());
    const provider = createdProviders[0];
    acq!.release();
    vi.advanceTimersByTime(30_000);
    const reacq = await cache.acquire('item-1', makeFactory());
    // Idle timer should have been cancelled -- advancing past the
    // original deadline does NOT destroy the provider.
    vi.advanceTimersByTime(60_000);
    expect(provider.destroyed).toBe(false);
    reacq!.release();
  });

  it('evicts the LRU entry when the cap is exceeded and refCount is 0', async () => {
    const cache = new BodyDocCache({ lruCap: 2, idleTimeoutMs: 60_000 });
    const factory = makeFactory();
    const a = await cache.acquire('a', factory); a!.release();
    const b = await cache.acquire('b', factory); b!.release();
    expect(cache.size).toBe(2);
    // c pushes over cap; a is LRU and unpinned -- should evict.
    const c = await cache.acquire('c', factory); c!.release();
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(createdProviders[0].destroyed).toBe(true);
  });

  it('does not evict a pinned (refCount>0) entry even past the cap', async () => {
    const cache = new BodyDocCache({ lruCap: 1, idleTimeoutMs: 60_000 });
    const factory = makeFactory();
    const a = await cache.acquire('a', factory); // refCount=1, pinned
    const b = await cache.acquire('b', factory); // pushes over cap; can't evict a
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(true);
    expect(cache.size).toBe(2); // soft cap exceeded
    a!.release();
    b!.release();
  });

  it('dispatches status events to all subscribers and replays last status to new ones', async () => {
    const cache = new BodyDocCache();
    const factory = makeFactory();
    const statusesA: string[] = [];
    const statusesB: string[] = [];

    const a = await cache.acquire('item-1', factory, {
      onStatusChange: (s) => statusesA.push(s),
    });
    // New subscriber gets the cached lastStatus immediately.
    expect(statusesA).toEqual(['disconnected']);

    // Drive a status event through the wired-in onStatusChange callback.
    const provider = createdProviders[0];
    const onStatusChange = provider.config.onStatusChange as (s: string) => void;
    onStatusChange('connected');
    expect(statusesA).toEqual(['disconnected', 'connected']);

    // Second subscriber should see the replayed 'connected' state.
    const b = await cache.acquire('item-1', factory, {
      onStatusChange: (s) => statusesB.push(s),
    });
    expect(statusesB).toEqual(['connected']);

    onStatusChange('syncing');
    expect(statusesA).toEqual(['disconnected', 'connected', 'syncing']);
    expect(statusesB).toEqual(['connected', 'syncing']);

    a!.release();
    b!.release();
  });

  it('returns null when the factory returns null', async () => {
    const cache = new BodyDocCache();
    // Silence the expected `entry creation failed` log so the test
    // output stays clean.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const acq = await cache.acquire('missing', makeFailingFactory());
    expect(acq).toBeNull();
    expect(createdProviders.length).toBe(0);
    expect(cache.has('missing')).toBe(false);
    errorSpy.mockRestore();
  });

  it('prewarm throttles factory calls to the configured concurrency', async () => {
    // Idle timeout set high enough that the prewarm-spawned timers don't
    // fire during the timer flush below.
    const cache = new BodyDocCache({ prewarmConcurrency: 2, idleTimeoutMs: 10 * 60_000 });
    let inFlight = 0;
    let peak = 0;
    const factory: BodyDocConfigFactory = async (id) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Pause inside the factory so the throttle is observable.
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return {
        serverUrl: 'wss://test',
        getJwt: async () => 'jwt',
        orgId: 'org',
        documentKey: 'k' as unknown as CryptoKey,
        orgKeyFingerprint: 'fp',
        userId: 'user',
        documentId: `tracker-content/${id}`,
        createWebSocket: ((url: string) => ({ url } as unknown as WebSocket)),
      };
    };
    const prewarmPromise = cache.prewarm(['a', 'b', 'c', 'd', 'e'], factory);
    // Advance just enough to flush each factory's 10ms internal await
    // (5 items / 2 concurrent => 3 waves of 10ms each = 30ms total).
    await vi.advanceTimersByTimeAsync(50);
    await prewarmPromise;
    expect(peak).toBeLessThanOrEqual(2);
    expect(cache.size).toBe(5);
  });

  it('prewarm does not pin entries: the idle timer runs immediately', async () => {
    const cache = new BodyDocCache({ idleTimeoutMs: 60_000 });
    await cache.prewarm(['a'], makeFactory());
    expect(cache.has('a')).toBe(true);
    const provider = createdProviders[0];
    expect(provider.destroyed).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(provider.destroyed).toBe(true);
    expect(cache.has('a')).toBe(false);
  });

  it('dispose destroys every entry and clears every timer', async () => {
    const cache = new BodyDocCache();
    const factory = makeFactory();
    await cache.acquire('a', factory);
    await cache.acquire('b', factory);
    cache.dispose();
    expect(cache.size).toBe(0);
    for (const p of createdProviders) {
      expect(p.destroyed).toBe(true);
    }
  });
});
