import { afterEach, describe, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { sessionWakeupAtom, type SessionWakeupView } from '../../atoms/sessions';
import { sessionErrorAtom } from '../../atoms/sessionTranscript';
import { initWakeupListeners } from '../wakeupListener';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function wakeup(sessionId: string, status: SessionWakeupView['status'] = 'pending'): SessionWakeupView {
  return {
    id: `wake-${sessionId}`,
    sessionId,
    workspaceId: '/workspace',
    prompt: 'resume',
    reason: 'Continue work',
    fireAt: Date.now() + 60_000,
    status,
    createdAt: Date.now(),
    firedAt: null,
    error: null,
  };
}

describe('wakeup listener', () => {
  it('retries initial hydration once after the startup workspace race', async () => {
    vi.useFakeTimers();
    const row = wakeup('hydrated');
    const invoke = vi.fn()
      .mockRejectedValueOnce(new Error('workspace not ready'))
      .mockResolvedValueOnce({ workspacePath: '/workspace' })
      .mockResolvedValueOnce([row]);
    const cleanup = vi.fn();
    vi.stubGlobal('window', {
      electronAPI: {
        on: vi.fn(() => cleanup),
        invoke,
      },
    });

    const dispose = initWakeupListeners();
    await vi.runAllTimersAsync();

    expect(invoke.mock.calls).toEqual([
      ['get-initial-state'],
      ['get-initial-state'],
      ['wakeup:list-active', '/workspace'],
    ]);
    expect(store.get(sessionWakeupAtom(row.sessionId))).toEqual(row);

    dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('applies changed events and clears only the matching terminal wakeup', async () => {
    let changed: ((row: SessionWakeupView) => void) | undefined;
    vi.stubGlobal('window', {
      electronAPI: {
        on: vi.fn((_channel: string, handler: (row: SessionWakeupView) => void) => {
          changed = handler;
          return () => {};
        }),
        invoke: vi.fn()
          .mockResolvedValueOnce({ workspacePath: '/workspace' })
          .mockResolvedValueOnce([]),
      },
    });

    const dispose = initWakeupListeners();
    await Promise.resolve();
    const pending = wakeup('changed');
    changed?.(pending);
    expect(store.get(sessionWakeupAtom('changed'))).toEqual(pending);

    changed?.({ ...pending, status: 'fired' });
    expect(store.get(sessionWakeupAtom('changed'))).toBeNull();
    dispose();
  });

  it('turns a failed wakeup into an acknowledgeable safe error', async () => {
    let changed: ((row: SessionWakeupView) => void) | undefined;
    vi.stubGlobal('window', {
      electronAPI: {
        on: vi.fn((_channel: string, handler: (row: SessionWakeupView) => void) => {
          changed = handler;
          return () => {};
        }),
        invoke: vi.fn()
          .mockResolvedValueOnce({ workspacePath: '/workspace' })
          .mockResolvedValueOnce([]),
      },
    });

    const dispose = initWakeupListeners();
    await Promise.resolve();
    const failed = { ...wakeup('failed'), status: 'failed' as const, error: 'private provider detail' };
    changed?.(failed);

    expect(store.get(sessionWakeupAtom(failed.sessionId))).toBeNull();
    expect(store.get(sessionErrorAtom(failed.sessionId))).toEqual({
      message: 'private provider detail',
      isWakeupError: true,
    });

    changed?.({ ...failed, status: 'pending', error: null });
    expect(store.get(sessionErrorAtom(failed.sessionId))).toBeNull();
    expect(store.get(sessionWakeupAtom(failed.sessionId))?.status).toBe('pending');
    dispose();
  });
});
