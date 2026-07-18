import { describe, expect, it, vi } from 'vitest';
import {
  capturePendingPromptActionOwnership,
  promptActionOwnsCurrentGeneration,
} from '../pendingPromptPersistence';

describe('prompt-specific delayed action ownership', () => {
  it('captures the exact persisted prompt generation', async () => {
    const ownership = await capturePendingPromptActionOwnership(
      'session-1',
      'prompt-a',
      {
        getSession: vi.fn(async () => ({
          metadata: {
            hasPendingPrompt: true,
            pendingPromptId: 'prompt-a',
            pendingPromptGeneration: 'turn-a',
          },
        })),
      },
    );

    expect(ownership).toEqual({
      sessionId: 'session-1',
      promptId: 'prompt-a',
      matchedPendingPrompt: true,
      attentionGeneration: 'turn-a',
      readSucceeded: true,
    });
  });

  it('fails closed when a delayed turn-A action observes active turn B', async () => {
    const ownership = await capturePendingPromptActionOwnership(
      'session-1',
      'prompt-a',
      {
        getSession: vi.fn(async () => ({
          metadata: {
            hasPendingPrompt: true,
            pendingPromptId: 'prompt-a',
            pendingPromptGeneration: 'turn-a',
          },
        })),
      },
    );

    expect(promptActionOwnsCurrentGeneration(ownership, {
      getCurrentGeneration: () => 'turn-b',
    })).toBe(false);
  });

  it.each([
    { hasPendingPrompt: true, pendingPromptId: 'prompt-b', pendingPromptGeneration: 'turn-b' },
    { hasPendingPrompt: true, pendingPromptId: 'prompt-a' },
    null,
  ])('fails closed when prompt identity or generation is not provable', async (metadata) => {
    const ownership = await capturePendingPromptActionOwnership(
      'session-1',
      'prompt-a',
      { getSession: vi.fn(async () => ({ metadata })) },
    );

    expect(promptActionOwnsCurrentGeneration(ownership, {
      getCurrentGeneration: () => 'turn-a',
    })).toBe(false);
  });
});
