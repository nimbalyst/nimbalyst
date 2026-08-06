import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderFactory } from '../ProviderFactory';

function providerMap(): Map<string, { destroy: () => void }> {
  return (ProviderFactory as unknown as {
    providers: Map<string, { destroy: () => void }>;
  }).providers;
}

function providerOwnerMap(): Map<string, string> {
  return (ProviderFactory as unknown as {
    providerOwners: Map<string, string>;
  }).providerOwners;
}

function cacheProvider(key: string, sessionId: string, destroy: () => void): void {
  providerMap().set(key, fakeProvider(destroy));
  providerOwnerMap().set(key, sessionId);
}

function fakeProvider(destroy: () => void) {
  return { destroy } as never;
}

function inFlightMap(): Map<string, Promise<unknown>> {
  return (ProviderFactory as unknown as {
    inFlightCreations: Map<string, Promise<unknown>>;
  }).inFlightCreations;
}

// The real return type of ProviderFactory.createProvider (AIProvider),
// derived without importing that type so mocked implementations below can
// stand in for a provider instance without pulling in the real interface.
type FactoryProvider = ReturnType<typeof ProviderFactory.createProvider>;

/**
 * A promise plus externally-callable resolve/reject, for controlling exactly
 * when a mocked async operation settles. Used to simulate a hypothetical
 * future ASYNC createProvider() for the identity-safety regression test.
 */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ProviderFactory lifecycle cleanup', () => {
  beforeEach(() => {
    providerMap().clear();
    providerOwnerMap().clear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    providerMap().clear();
    providerOwnerMap().clear();
    vi.restoreAllMocks();
  });

  it('destroys only providers owned by the exact session id', () => {
    const codexDestroy = vi.fn();
    const claudeDestroy = vi.fn();
    const otherDestroy = vi.fn();
    const suffixCollisionDestroy = vi.fn();
    cacheProvider('openai-codex-session-1', 'session-1', codexDestroy);
    cacheProvider('claude-session-1', 'session-1', claudeDestroy);
    cacheProvider('openai-codex-session-10', 'session-10', otherDestroy);
    cacheProvider('openai-codex-prefix-session-1', 'prefix-session-1', suffixCollisionDestroy);

    ProviderFactory.destroyProvider('session-1');

    expect(codexDestroy).toHaveBeenCalledTimes(1);
    expect(claudeDestroy).toHaveBeenCalledTimes(1);
    expect(otherDestroy).not.toHaveBeenCalled();
    expect(suffixCollisionDestroy).not.toHaveBeenCalled();
    expect(providerMap().has('openai-codex-session-1')).toBe(false);
    expect(providerMap().has('claude-session-1')).toBe(false);
    expect(providerMap().has('openai-codex-session-10')).toBe(true);
    expect(providerMap().has('openai-codex-prefix-session-1')).toBe(true);
  });

  it('is an idempotent no-op when a typed provider is not cached', () => {
    expect(() => {
      ProviderFactory.destroyProvider('missing-session', 'openai-codex');
      ProviderFactory.destroyProvider('missing-session', 'openai-codex');
    }).not.toThrow();
    expect(providerMap().size).toBe(0);
  });

  it('bounds provider destroy errors, removes the failed entry, and continues', () => {
    const throwingDestroy = vi.fn(() => {
      throw new Error('cleanup failed');
    });
    const nextDestroy = vi.fn();
    cacheProvider('openai-codex-session-1', 'session-1', throwingDestroy);
    cacheProvider('claude-session-1', 'session-1', nextDestroy);

    expect(() => ProviderFactory.destroyProvider('session-1')).not.toThrow();

    expect(throwingDestroy).toHaveBeenCalledTimes(1);
    expect(nextDestroy).toHaveBeenCalledTimes(1);
    expect(providerMap().has('openai-codex-session-1')).toBe(false);
    expect(providerMap().has('claude-session-1')).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Error destroying provider'),
      expect.any(Error),
    );
  });

  it('keeps app shutdown cleanup bounded and clears every cached provider', () => {
    const throwingDestroy = vi.fn(() => {
      throw new Error('shutdown cleanup failed');
    });
    const nextDestroy = vi.fn();
    cacheProvider('openai-codex-session-1', 'session-1', throwingDestroy);
    cacheProvider('claude-session-2', 'session-2', nextDestroy);

    expect(() => ProviderFactory.destroyAll()).not.toThrow();

    expect(throwingDestroy).toHaveBeenCalledTimes(1);
    expect(nextDestroy).toHaveBeenCalledTimes(1);
    expect(providerMap().size).toBe(0);
  });
});

describe('ProviderFactory.createProviderAsync race guard (NIM-590)', () => {
  beforeEach(() => {
    providerMap().clear();
    providerOwnerMap().clear();
    inFlightMap().clear();
  });

  afterEach(() => {
    providerMap().clear();
    providerOwnerMap().clear();
    inFlightMap().clear();
    vi.restoreAllMocks();
  });

  it('shares a single in-flight creation across concurrent createProviderAsync callers for the same key', async () => {
    const fake = fakeProvider(vi.fn());
    const createSpy = vi.spyOn(ProviderFactory, 'createProvider').mockReturnValue(fake);

    // No `await` between these two calls: both run to completion in the same
    // synchronous tick, exactly like two concurrent dispatch callers racing
    // on getProvider() -> createProviderAsync() for the same session.
    const promiseA = ProviderFactory.createProviderAsync('claude', 'session-race');
    const promiseB = ProviderFactory.createProviderAsync('claude', 'session-race');

    const [providerA, providerB] = await Promise.all([promiseA, promiseB]);

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(providerA).toBe(fake);
    expect(providerB).toBe(fake);
    expect(providerA).toBe(providerB);
  });

  it('drops the in-flight entry and propagates the rejection when provider construction throws synchronously', async () => {
    const error = new Error('construction failed');
    const createSpy = vi.spyOn(ProviderFactory, 'createProvider').mockImplementation(() => {
      throw error;
    });

    await expect(
      ProviderFactory.createProviderAsync('claude', 'session-throw'),
    ).rejects.toThrow('construction failed');

    // No stale entry left behind for a failed creation.
    expect(inFlightMap().size).toBe(0);
    expect(inFlightMap().has('claude-session-throw')).toBe(false);

    // Observable retry behavior: since the map is private, verify the
    // guarantee that matters through behavior rather than internal state
    // alone -- a subsequent call must attempt creation again rather than
    // awaiting/reusing a stale rejected promise from the failed attempt.
    const fake = fakeProvider(vi.fn());
    createSpy.mockReturnValueOnce(fake);

    const retried = await ProviderFactory.createProviderAsync('claude', 'session-throw');

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(retried).toBe(fake);
  });

  it('does not let a stale creation cleanup delete a newer in-flight entry for the same key (identity-checked finally)', async () => {
    const key = 'claude-session-identity';
    const deferredA = createDeferred<FactoryProvider>();
    const deferredB = createDeferred<FactoryProvider>();
    const fakeA = fakeProvider(vi.fn());
    const fakeB = fakeProvider(vi.fn());

    // Stand in for a hypothetical future ASYNC createProvider: each call
    // returns a promise we control instead of resolving synchronously.
    // (createProvider is synchronous today, which is exactly why the source
    // comments call this scenario currently unreachable -- this test exists
    // to pressure-test the identity-checked .finally() guard regardless.)
    const createSpy = vi
      .spyOn(ProviderFactory, 'createProvider')
      .mockImplementationOnce(() => deferredA.promise as unknown as FactoryProvider)
      .mockImplementationOnce(() => deferredB.promise as unknown as FactoryProvider);

    // Creation A starts and is in flight.
    const promiseA = ProviderFactory.createProviderAsync('claude', 'session-identity');
    const creationPromiseA = inFlightMap().get(key);
    expect(creationPromiseA).toBeDefined();

    // Caller destroys the session before A resolves (e.g. user cancels
    // mid-spawn). This clears A's in-flight entry.
    ProviderFactory.destroyProvider('session-identity', 'claude');
    expect(inFlightMap().has(key)).toBe(false);

    // Creation B starts fresh for the same key.
    const promiseB = ProviderFactory.createProviderAsync('claude', 'session-identity');
    const creationPromiseB = inFlightMap().get(key);
    expect(creationPromiseB).toBeDefined();
    expect(creationPromiseB).not.toBe(creationPromiseA);

    // A resolves late. Its .finally() cleanup runs, but must be a no-op
    // because the map no longer holds A's own promise under this key.
    deferredA.resolve(fakeA);
    await promiseA;

    // B's in-flight entry must survive A's stale cleanup.
    expect(inFlightMap().get(key)).toBe(creationPromiseB);

    // A concurrent caller arriving after B started must still share B's
    // creation instead of triggering a third independent construction.
    const promiseC = ProviderFactory.createProviderAsync('claude', 'session-identity');
    expect(createSpy).toHaveBeenCalledTimes(2);

    deferredB.resolve(fakeB);
    const [resultB, resultC] = await Promise.all([promiseB, promiseC]);

    expect(resultB).toBe(fakeB);
    expect(resultC).toBe(fakeB);
    expect(createSpy).toHaveBeenCalledTimes(2);
  });
});
