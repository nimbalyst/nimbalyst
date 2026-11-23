// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  createHeldIdleWakeRelease,
  decideIdleWake,
  deferIdleWakeMessage,
  peekDeferredIdleWakeMessages,
  resetDeferredIdleWakes,
  type HeldIdleWakeReleaseDeps,
} from '../idleWakeGating';

describe('decideIdleWake', () => {
  it('defers a wake for a session that is waiting on an interactive prompt', () => {
    // The bug: a background-task drain woke a session parked on an
    // AskUserQuestion. Starting a turn tore down the MCP transport holding the
    // open question, and the agent received "Connection closed" instead of an
    // answer. A lead blocked on the user is not idle.
    expect(decideIdleWake({ sessionActive: true, hasPendingPrompt: true }))
      .toEqual({ action: 'defer', reason: 'pending-prompt' });
  });

  it('delivers a wake for an active session with nothing pending', () => {
    expect(decideIdleWake({ sessionActive: true, hasPendingPrompt: false }))
      .toEqual({ action: 'deliver' });
  });

  it('drops a wake for an ended session even while a prompt is open', () => {
    // Ended beats pending: a session that is gone cannot be resumed by
    // answering, so holding the message would leak it forever.
    expect(decideIdleWake({ sessionActive: false, hasPendingPrompt: true }))
      .toEqual({ action: 'drop', reason: 'session-ended' });
  });
});

function releaseSetup(overrides: Partial<HeldIdleWakeReleaseDeps> = {}) {
  const deps = {
    isBlockedOnUser: () => false,
    isSessionActive: () => true,
    deliver: vi.fn(async (_id: string, _message: string) => true),
    logInfo: () => {},
    logWarn: () => {},
    ...overrides,
  };
  return { deps, release: createHeldIdleWakeRelease(deps) };
}

describe('releasing held idle wakes', () => {
  beforeEach(() => {
    resetDeferredIdleWakes();
  });

  it('queues every held result for the session in order once the prompt clears', async () => {
    deferIdleWakeMessage('s1', 'first');
    deferIdleWakeMessage('s1', 'second');
    deferIdleWakeMessage('s2', 'other session');
    const { deps, release } = releaseSetup();

    await release('s1');

    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(deps.deliver).toHaveBeenCalledWith('s1', 'first\n\nsecond');
    expect(peekDeferredIdleWakeMessages('s1')).toEqual([]);
    expect(peekDeferredIdleWakeMessages('s2')).toEqual(['other session']);
  });

  it('keeps holding while another prompt on the session is still open', async () => {
    deferIdleWakeMessage('s1', 'result');
    const { deps, release } = releaseSetup({ isBlockedOnUser: () => true });

    await release('s1');

    expect(deps.deliver).not.toHaveBeenCalled();
    expect(peekDeferredIdleWakeMessages('s1')).toEqual(['result']);
  });

  it('keeps the results when the hand-off fails or is declined, and delivers them on the next clear', async () => {
    deferIdleWakeMessage('s1', 'result');
    const deliver = vi.fn(async (_id: string, _message: string) => true)
      .mockRejectedValueOnce(new Error('database busy'));
    const { release } = releaseSetup({ deliver });

    await release('s1');
    expect(peekDeferredIdleWakeMessages('s1')).toEqual(['result']);

    deliver.mockResolvedValueOnce(false);
    await release('s1');
    expect(peekDeferredIdleWakeMessages('s1')).toEqual(['result']);

    await release('s1');
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliver).toHaveBeenLastCalledWith('s1', 'result');
    expect(peekDeferredIdleWakeMessages('s1')).toEqual([]);
  });

  it('serializes overlapping releases so a result is queued once, and queues one held during the hand-off after it', async () => {
    deferIdleWakeMessage('s1', 'first');
    let finishFirst: () => void = () => {};
    const deliver = vi.fn(async (_id: string, _message: string) => true)
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishFirst = () => resolve(true); }));
    const { release } = releaseSetup({ deliver });

    const a = release('s1');
    const b = release('s1');
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    deferIdleWakeMessage('s1', 'second');
    finishFirst();
    await Promise.all([a, b]);

    expect(deliver.mock.calls.map(([, message]) => message)).toEqual(['first', 'second']);
    expect(peekDeferredIdleWakeMessages('s1')).toEqual([]);
  });

  it('drops held results for a session that ended while they were held', async () => {
    deferIdleWakeMessage('s1', 'result');
    const { deps, release } = releaseSetup({ isSessionActive: () => false });

    await release('s1');

    expect(deps.deliver).not.toHaveBeenCalled();
    expect(peekDeferredIdleWakeMessages('s1')).toEqual([]);
  });
});
