// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';

import {
  decideIdleWake,
  deferIdleWakeMessage,
  takeDeferredIdleWakeMessages,
  resetDeferredIdleWakes,
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

describe('deferred idle wakes', () => {
  beforeEach(() => {
    resetDeferredIdleWakes();
  });

  it('returns deferred messages in order and drains them exactly once', () => {
    deferIdleWakeMessage('s1', 'first');
    deferIdleWakeMessage('s1', 'second');
    deferIdleWakeMessage('s2', 'other session');

    expect(takeDeferredIdleWakeMessages('s1')).toEqual(['first', 'second']);
    expect(takeDeferredIdleWakeMessages('s1')).toEqual([]);
    expect(takeDeferredIdleWakeMessages('s2')).toEqual(['other session']);
  });

  it('returns nothing for a session that never deferred', () => {
    expect(takeDeferredIdleWakeMessages('unknown')).toEqual([]);
  });
});
