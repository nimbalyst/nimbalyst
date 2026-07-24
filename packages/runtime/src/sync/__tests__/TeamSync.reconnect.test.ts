import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamSyncProvider } from '../TeamSync';

describe('TeamSyncProvider reconnect failures', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('schedules another reconnect when JWT acquisition fails', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const getJwt = vi.fn().mockRejectedValue(new Error('HTTP 401'));
    const provider = new TeamSyncProvider({
      serverUrl: 'wss://sync.example',
      orgId: 'org-team',
      userId: 'member-team',
      keyCustody: 'server-managed',
      orgKeyFingerprint: null,
      getJwt,
    });

    (provider as any).handleDisconnect();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(getJwt).toHaveBeenCalledTimes(1);
    expect((provider as any).reconnectTimer).not.toBeNull();
    provider.destroy();
  });
});
