import { afterEach, describe, expect, it } from 'vitest';

import {
  clearPendingInteractiveWaiter,
  countPendingInteractiveWaiters,
  notePendingInteractiveWaiter,
  shouldSettleFromSessionFallback,
} from '../tools/interactivePromptFallback';

const ALIASES = new Set(['exec-67e90371']);

afterEach(() => {
  // Reset the module-level registry between tests.
  for (const key of ['s1', 's2', 'unknown']) {
    while (countPendingInteractiveWaiters(key) > 0) {
      clearPendingInteractiveWaiter(key);
    }
  }
});

describe('shouldSettleFromSessionFallback', () => {
  it('accepts a mismatched session-fallback answer when it is the sole pending prompt (bug NIM-1981)', () => {
    // Waiter resolved a real-but-WRONG exec id; the response carries a different
    // exec id from the transcript widget. Old guard rejected this and hung the turn.
    const result = shouldSettleFromSessionFallback({
      waiterPromptId: 'exec-67e90371',
      promptIdAliasSet: ALIASES,
      responsePromptIds: ['nimtc|exec-8cbfbb2c|123|4', 'exec-8cbfbb2c'],
      pendingWaiterCountForSession: 1,
    });
    expect(result).toBe(true);
  });

  it('keeps strict id-matching when more than one prompt is pending in the session', () => {
    const result = shouldSettleFromSessionFallback({
      waiterPromptId: 'exec-67e90371',
      promptIdAliasSet: ALIASES,
      responsePromptIds: ['exec-8cbfbb2c'],
      pendingWaiterCountForSession: 2,
    });
    expect(result).toBe(false);
  });

  it('accepts when the response id matches an alias regardless of pending count', () => {
    const result = shouldSettleFromSessionFallback({
      waiterPromptId: 'exec-67e90371',
      promptIdAliasSet: ALIASES,
      responsePromptIds: ['exec-67e90371'],
      pendingWaiterCountForSession: 5,
    });
    expect(result).toBe(true);
  });

  it('accepts a synthetic (rui-) waiter that has no correlatable id', () => {
    const result = shouldSettleFromSessionFallback({
      waiterPromptId: 'rui-s1-123',
      promptIdAliasSet: new Set(['rui-s1-123']),
      responsePromptIds: ['exec-8cbfbb2c'],
      pendingWaiterCountForSession: 3,
    });
    expect(result).toBe(true);
  });

  it('accepts when the response carries no ids and the prompt is the sole pending one', () => {
    const result = shouldSettleFromSessionFallback({
      waiterPromptId: 'exec-67e90371',
      promptIdAliasSet: ALIASES,
      responsePromptIds: [],
      pendingWaiterCountForSession: 1,
    });
    expect(result).toBe(true);
  });
});

describe('pending interactive waiter registry', () => {
  it('counts note/clear pairs per session and never goes negative', () => {
    expect(countPendingInteractiveWaiters('s1')).toBe(0);
    notePendingInteractiveWaiter('s1');
    notePendingInteractiveWaiter('s1');
    expect(countPendingInteractiveWaiters('s1')).toBe(2);
    expect(countPendingInteractiveWaiters('s2')).toBe(0);
    clearPendingInteractiveWaiter('s1');
    expect(countPendingInteractiveWaiters('s1')).toBe(1);
    clearPendingInteractiveWaiter('s1');
    clearPendingInteractiveWaiter('s1'); // extra clear must not underflow
    expect(countPendingInteractiveWaiters('s1')).toBe(0);
  });
});
