import { describe, expect, it, vi } from 'vitest';

import { commitSessionPinFromAuthoritativeReceipt } from '../SessionHistory';

describe('SessionHistory authoritative pin caller', () => {
  it('retains renderer state and reloads on a resolved structured failure', async () => {
    const updateSessionStore = vi.fn();
    const updateVisibleSessions = vi.fn();
    const reload = vi.fn().mockResolvedValue(undefined);

    await expect(commitSessionPinFromAuthoritativeReceipt({
      sessionId: 'target',
      requestedPinned: true,
      invoke: vi.fn().mockResolvedValue({ success: false, ok: false, code: 'CONFLICT' }),
      updateSessionStore,
      updateVisibleSessions,
      reload,
    })).resolves.toBe(false);

    expect(updateSessionStore).not.toHaveBeenCalled();
    expect(updateVisibleSessions).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('uses the receipt after state instead of the requested optimistic value', async () => {
    const updateSessionStore = vi.fn();
    const updateVisibleSessions = vi.fn();
    const reload = vi.fn().mockResolvedValue(undefined);

    await expect(commitSessionPinFromAuthoritativeReceipt({
      sessionId: 'target',
      requestedPinned: true,
      invoke: vi.fn().mockResolvedValue({
        success: true,
        ok: true,
        after: { pinned: false },
      }),
      updateSessionStore,
      updateVisibleSessions,
      reload,
    })).resolves.toBe(true);

    expect(updateSessionStore).toHaveBeenCalledWith({
      sessionId: 'target', updates: { isPinned: false },
    });
    expect(updateVisibleSessions).toHaveBeenCalledWith('target', false);
    expect(reload).not.toHaveBeenCalled();
  });
});
