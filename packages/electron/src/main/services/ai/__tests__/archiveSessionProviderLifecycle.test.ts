import { describe, expect, it, vi } from 'vitest';
import {
  archiveSessionsAndDestroyProviders,
  destroyProviderForArchivedSession,
} from '../archiveSessionProviderLifecycle';

describe('archive session provider lifecycle', () => {
  it('archives and destroys only the providers owned by the supplied sessions', async () => {
    const events: string[] = [];
    const result = await archiveSessionsAndDestroyProviders(
      ['session-a', 'session-b'],
      {
        archiveSession: vi.fn(async (sessionId) => {
          events.push(`archive:${sessionId}`);
        }),
        destroyProvider: vi.fn((sessionId) => {
          events.push(`destroy:${sessionId}`);
        }),
      },
    );

    expect(events).toEqual([
      'archive:session-a',
      'destroy:session-a',
      'archive:session-b',
      'destroy:session-b',
    ]);
    expect(result).toEqual({ archiveFailures: 0, providerCleanupFailures: 0 });
  });

  it('does not destroy a provider when that session failed to archive', async () => {
    const destroyProvider = vi.fn();
    const onArchiveError = vi.fn();
    const result = await archiveSessionsAndDestroyProviders(
      ['session-failed', 'session-ok'],
      {
        archiveSession: vi.fn(async (sessionId) => {
          if (sessionId === 'session-failed') throw new Error('database unavailable');
        }),
        destroyProvider,
        onArchiveError,
      },
    );

    expect(destroyProvider).toHaveBeenCalledTimes(1);
    expect(destroyProvider).toHaveBeenCalledWith('session-ok');
    expect(onArchiveError).toHaveBeenCalledWith('session-failed', expect.any(Error));
    expect(result).toEqual({ archiveFailures: 1, providerCleanupFailures: 0 });
  });

  it('bounds provider cleanup errors and continues archiving the remaining sessions', async () => {
    const destroyProvider = vi.fn((sessionId: string) => {
      if (sessionId === 'session-a') throw new Error('provider cleanup failed');
    });
    const onProviderCleanupError = vi.fn();
    const result = await archiveSessionsAndDestroyProviders(
      ['session-a', 'session-b'],
      {
        archiveSession: vi.fn(async () => {}),
        destroyProvider,
        onProviderCleanupError,
      },
    );

    expect(destroyProvider).toHaveBeenCalledTimes(2);
    expect(onProviderCleanupError).toHaveBeenCalledWith('session-a', expect.any(Error));
    expect(result).toEqual({ archiveFailures: 0, providerCleanupFailures: 1 });
  });

  it('provides a bounded exact-session cleanup primitive for ordinary archive paths', () => {
    const destroyProvider = vi.fn(() => {
      throw new Error('cleanup failed');
    });
    const onProviderCleanupError = vi.fn();

    expect(destroyProviderForArchivedSession(
      'ordinary-session',
      destroyProvider,
      onProviderCleanupError,
    )).toBe(false);
    expect(destroyProvider).toHaveBeenCalledOnce();
    expect(destroyProvider).toHaveBeenCalledWith('ordinary-session');
    expect(onProviderCleanupError).toHaveBeenCalledWith(
      'ordinary-session',
      expect.any(Error),
    );
  });
});
