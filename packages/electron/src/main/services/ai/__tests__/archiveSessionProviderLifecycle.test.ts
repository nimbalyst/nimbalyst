import { describe, expect, it, vi } from 'vitest';
import {
  archiveSessionsAndDestroyProviders,
  destroyProviderForArchivedSession,
  releaseSessionRuntime,
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

describe('releaseSessionRuntime', () => {
  it('releases the terminal as well as the provider (#903)', async () => {
    const destroyProvider = vi.fn();
    const destroyTerminal = vi.fn(async () => {});

    const result = await releaseSessionRuntime('cli-session', {
      destroyProvider,
      destroyTerminal,
    });

    expect(destroyProvider).toHaveBeenCalledWith('cli-session');
    expect(destroyTerminal).toHaveBeenCalledWith('cli-session');
    expect(result).toEqual({ providerReleased: true, terminalReleased: true });
  });

  it('still releases the terminal when destroying the provider throws', async () => {
    const destroyTerminal = vi.fn(async () => {});
    const onProviderCleanupError = vi.fn();

    const result = await releaseSessionRuntime('cli-session', {
      destroyProvider: vi.fn(() => {
        throw new Error('provider cleanup failed');
      }),
      destroyTerminal,
      onProviderCleanupError,
    });

    // The whole point: a provider failure must not strand the CLI process.
    expect(destroyTerminal).toHaveBeenCalledWith('cli-session');
    expect(onProviderCleanupError).toHaveBeenCalledWith('cli-session', expect.any(Error));
    expect(result).toEqual({ providerReleased: false, terminalReleased: true });
  });

  it('still releases the provider when destroying the terminal throws', async () => {
    const destroyProvider = vi.fn();
    const onTerminalCleanupError = vi.fn();

    const result = await releaseSessionRuntime('cli-session', {
      destroyProvider,
      destroyTerminal: vi.fn(async () => {
        throw new Error('pty already gone');
      }),
      onTerminalCleanupError,
    });

    expect(destroyProvider).toHaveBeenCalledWith('cli-session');
    expect(onTerminalCleanupError).toHaveBeenCalledWith('cli-session', expect.any(Error));
    expect(result).toEqual({ providerReleased: true, terminalReleased: false });
  });

  it('never rejects, so a delete/archive flow always converges', async () => {
    await expect(
      releaseSessionRuntime('cli-session', {
        destroyProvider: vi.fn(() => {
          throw new Error('boom');
        }),
        destroyTerminal: vi.fn(async () => {
          throw new Error('bang');
        }),
      }),
    ).resolves.toEqual({ providerReleased: false, terminalReleased: false });
  });

  it('is a no-op-safe call for an SDK session that never had a terminal', async () => {
    // destroyTerminal is a lookup-then-return for a sessionId with no PTY, so
    // the common SDK case must not be treated as a failure.
    const result = await releaseSessionRuntime('sdk-session', {
      destroyProvider: vi.fn(),
      destroyTerminal: vi.fn(async () => {}),
    });

    expect(result).toEqual({ providerReleased: true, terminalReleased: true });
  });
});
