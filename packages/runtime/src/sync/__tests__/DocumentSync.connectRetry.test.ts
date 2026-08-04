// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentSyncProvider } from '../DocumentSync';
import type { DocumentSyncStatus } from '../documentSyncTypes';

/**
 * A token exchange that fails is the only connect() exit that never creates a
 * socket, so nothing downstream can notice the failure and retry. Left
 * unscheduled it strands the provider at 'disconnected' with no timer -- and
 * hosts that render "never live" as "Connecting" (the web console) show a
 * spinner over an empty, editable document forever.
 */
describe('DocumentSync connect() retries a failed token exchange', () => {
  let provider: DocumentSyncProvider | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    provider?.destroy();
    provider = null;
    vi.useRealTimers();
  });

  function createProvider(getJwt: () => Promise<string>, statuses: DocumentSyncStatus[]) {
    return new DocumentSyncProvider({
      serverUrl: 'wss://sync.test',
      orgId: 'org-1',
      userId: 'member-1',
      documentId: 'doc-1',
      getJwt,
      onStatusChange: status => statuses.push(status),
      createWebSocket: () => {
        throw new Error('no socket should be created when the token exchange fails');
      },
    });
  }

  it('schedules a reconnect and recovers once the token exchange succeeds', async () => {
    const statuses: DocumentSyncStatus[] = [];
    const sockets: Array<{ url: string }> = [];
    let attempts = 0;
    const getJwt = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('session service unavailable');
      return 'jwt-token';
    });

    provider = new DocumentSyncProvider({
      serverUrl: 'wss://sync.test',
      orgId: 'org-1',
      userId: 'member-1',
      documentId: 'doc-1',
      getJwt,
      onStatusChange: status => statuses.push(status),
      createWebSocket: (url: string) => {
        sockets.push({ url });
        return {
          addEventListener: () => {},
          removeEventListener: () => {},
          close: () => {},
          send: () => {},
          readyState: 0,
        } as unknown as WebSocket;
      },
    });

    await provider.connect();

    expect(getJwt).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(0);
    expect(statuses.at(-1)).toBe('disconnected');

    // The retry is the whole point: without it nothing ever calls connect()
    // again for the life of the mount.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(getJwt).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(1);
  });

  it('keeps retrying while the token exchange stays broken', async () => {
    const statuses: DocumentSyncStatus[] = [];
    const getJwt = vi.fn(async () => {
      throw new Error('session service unavailable');
    });
    provider = createProvider(getJwt, statuses);

    await provider.connect();
    expect(getJwt).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    const afterFiveSeconds = getJwt.mock.calls.length;
    expect(afterFiveSeconds).toBeGreaterThan(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(getJwt.mock.calls.length).toBeGreaterThan(afterFiveSeconds);
    // Exponential backoff, not a hot loop: a minute of failures must not cost
    // anywhere near a retry per second.
    expect(getJwt.mock.calls.length).toBeLessThan(15);
  });
});
