import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearLiveInteractivePrompt,
  countLiveInteractivePrompts,
  hasLiveInteractivePrompt,
  noteLiveInteractivePrompt,
} from '../tools/interactivePromptLiveness';
import {
  clearPendingInteractiveWaiter,
  countPendingInteractiveWaiters,
  notePendingInteractiveWaiter,
  shouldSettleFromSessionFallback,
} from '../tools/interactivePromptFallback';

const drain = (sessionId: string) => {
  while (countLiveInteractivePrompts(sessionId) > 0) clearLiveInteractivePrompt(sessionId);
  while (countPendingInteractiveWaiters(sessionId) > 0) clearPendingInteractiveWaiter(sessionId);
};

describe('interactivePromptLiveness (NIM-2208)', () => {
  beforeEach(() => {
    drain('s1');
    drain('s2');
  });

  it('counts prompts per session and does not leak across sessions', () => {
    noteLiveInteractivePrompt('s1');
    noteLiveInteractivePrompt('s1');
    expect(countLiveInteractivePrompts('s1')).toBe(2);
    expect(hasLiveInteractivePrompt('s1')).toBe(true);
    expect(countLiveInteractivePrompts('s2')).toBe(0);
    expect(hasLiveInteractivePrompt('s2')).toBe(false);
  });

  it('settles back to zero and does not underflow on an extra clear', () => {
    noteLiveInteractivePrompt('s1');
    clearLiveInteractivePrompt('s1');
    clearLiveInteractivePrompt('s1');
    expect(countLiveInteractivePrompts('s1')).toBe(0);
    expect(hasLiveInteractivePrompt('s1')).toBe(false);
  });

  it('is a SEPARATE counter from the NIM-1981 fallback registry', () => {
    // The reconcile registry is incremented by every prompt type that sets
    // `hasPendingPrompt`. The fallback registry must keep counting only
    // RequestUserInput waiters, because `shouldSettleFromSessionFallback` treats
    // "count <= 1" as "sole pending prompt for this session, so an unmatched id
    // is unambiguous". Folding the other prompt types into that counter would
    // push it to 2 and reject a correct answer, hanging the turn.
    noteLiveInteractivePrompt('s1');
    noteLiveInteractivePrompt('s1');
    expect(countPendingInteractiveWaiters('s1')).toBe(0);

    notePendingInteractiveWaiter('s1');
    expect(shouldSettleFromSessionFallback({
      waiterPromptId: 'prompt-1',
      promptIdAliasSet: new Set(['prompt-1']),
      responsePromptIds: ['unmatched-id'],
      pendingWaiterCountForSession: countPendingInteractiveWaiters('s1'),
    })).toBe(true);
  });
});
