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
