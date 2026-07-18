import { describe, expect, it, vi } from 'vitest';
import type {
  PendingPromptActionOwnership,
  PendingPromptPersistenceResult,
} from '../pendingPromptPersistence';
import {
  runPromptOwnedCurrentAction,
  schedulePromptOwnedCurrentAction,
} from '../promptActionExecution';

function ownership(): PendingPromptActionOwnership {
  return {
    sessionId: 'session-1',
    promptId: 'prompt-a',
    matchedPendingPrompt: true,
    attentionGeneration: 'turn-a',
    readSucceeded: true,
  };
}

function promptClear(): PendingPromptPersistenceResult {
  return {
    sessionId: 'session-1',
    hasPendingPrompt: false,
    promptId: null,
    generation: null,
    applied: true,
    superseded: false,
    local: { attempted: true, succeeded: true, skippedReason: null },
    sync: { attempted: true, succeeded: true, skippedReason: null },
    fullyPropagated: true,
  };
}

describe('prompt-owned current-generation side effects', () => {
  it.each(['cancel-question abort', 'cancel-tool-permission abort'])(
    'does not execute stale turn-A %s against active turn B',
    () => {
      const abort = vi.fn();

      expect(runPromptOwnedCurrentAction(
        { ownership: ownership(), promptClear: promptClear() },
        abort,
        { getCurrentGeneration: () => 'turn-b' },
      )).toBe(false);
      expect(abort).not.toHaveBeenCalled();
    },
  );

  it('rechecks ownership inside AskUserQuestion auto-resume scheduling', async () => {
    let currentGeneration = 'turn-a';
    let scheduled: (() => void) | undefined;
    const resume = vi.fn().mockResolvedValue(undefined);

    expect(schedulePromptOwnedCurrentAction(
      { ownership: ownership(), promptClear: promptClear() },
      resume,
      {
        getCurrentGeneration: () => currentGeneration,
        hasNoReplacementPrompt: () => true,
        scheduleImmediate: (callback) => { scheduled = callback; },
      },
    )).toBe(true);

    currentGeneration = 'turn-b';
    scheduled?.();
    await Promise.resolve();
    expect(resume).not.toHaveBeenCalled();
  });

  it('does not auto-resume over prompt B even when B shares the same turn generation', async () => {
    let scheduled: (() => void) | undefined;
    const resume = vi.fn();
    expect(schedulePromptOwnedCurrentAction(
      { ownership: ownership(), promptClear: promptClear() },
      resume,
      {
        getCurrentGeneration: () => 'turn-a',
        hasNoReplacementPrompt: () => false,
        scheduleImmediate: (callback) => { scheduled = callback; },
      },
    )).toBe(true);

    scheduled?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(resume).not.toHaveBeenCalled();
  });

  it('executes the side effect while the exact turn still owns the session', () => {
    const action = vi.fn();
    expect(runPromptOwnedCurrentAction(
      { ownership: ownership(), promptClear: promptClear() },
      action,
      { getCurrentGeneration: () => 'turn-a' },
    )).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
  });
});
