import { describe, it, expect, vi } from 'vitest';
import {
  isTerminalSessionEvent,
  clearStalePendingPromptOnTerminal,
  findCompletedSessionsWithPendingPrompt,
} from '../pendingPromptTerminalClear';

describe('isTerminalSessionEvent', () => {
  it('treats completed/error/interrupted as terminal', () => {
    expect(isTerminalSessionEvent('session:completed')).toBe(true);
    expect(isTerminalSessionEvent('session:error')).toBe(true);
    expect(isTerminalSessionEvent('session:interrupted')).toBe(true);
  });

  it('does not treat in-flight events as terminal', () => {
    expect(isTerminalSessionEvent('session:started')).toBe(false);
    expect(isTerminalSessionEvent('session:streaming')).toBe(false);
    expect(isTerminalSessionEvent('session:waiting')).toBe(false);
  });
});

describe('findCompletedSessionsWithPendingPrompt', () => {
  it('selects only completed sessions whose prompt bit is still true', () => {
    expect(findCompletedSessionsWithPendingPrompt([
      { id: 'stale', metadata: { phase: 'complete', hasPendingPrompt: true } },
      { id: 'valid-pending', metadata: { phase: 'validating', hasPendingPrompt: true } },
      { id: 'complete-clean', metadata: { phase: 'complete', hasPendingPrompt: false } },
    ])).toEqual(['stale']);
  });
});

describe('clearStalePendingPromptOnTerminal (NIM-871)', () => {
  const sessionId = '5a681e17-2bb9-4b27-b667-3c6ad92c3fad';

  it('clears the persisted bit when a turn ends with an abandoned prompt', async () => {
    // Repro: an AskUserQuestion opened (hasPendingPrompt=true), the user
    // submitted a new prompt instead of answering, and that new turn now
    // completes. The bit must be cleared so the session does not stay stuck
    // showing "awaiting user input".
    const clearPendingPrompt = vi.fn().mockResolvedValue(undefined);
    const result = await clearStalePendingPromptOnTerminal(
      { type: 'session:completed', sessionId, attentionGeneration: 'turn-a' },
      {
        readHasPendingPrompt: async () => ({
          hasPendingPrompt: true,
          promptId: 'prompt-a',
          generation: 'turn-a',
        }),
        clearPendingPrompt,
      },
    );
    expect(result).toBe(true);
    expect(clearPendingPrompt).toHaveBeenCalledWith(sessionId, {
      expectedGeneration: 'turn-a',
    });
  });

  it('clears on interruption (stop / crash) too', async () => {
    const clearPendingPrompt = vi.fn().mockResolvedValue(undefined);
    await clearStalePendingPromptOnTerminal(
      { type: 'session:interrupted', sessionId, attentionGeneration: 'turn-a' },
      {
        readHasPendingPrompt: async () => ({
          hasPendingPrompt: true,
          generation: 'turn-a',
        }),
        clearPendingPrompt,
      },
    );
    expect(clearPendingPrompt).toHaveBeenCalledWith(sessionId, {
      expectedGeneration: 'turn-a',
    });
  });

  it('does NOT write on a normal turn end with no pending prompt', async () => {
    const clearPendingPrompt = vi.fn().mockResolvedValue(undefined);
    const result = await clearStalePendingPromptOnTerminal(
      { type: 'session:completed', sessionId, attentionGeneration: 'turn-a' },
      {
        readHasPendingPrompt: async () => ({ hasPendingPrompt: false }),
        clearPendingPrompt,
      },
    );
    expect(result).toBe(false);
    expect(clearPendingPrompt).not.toHaveBeenCalled();
  });

  it('does NOT clear on a non-terminal (in-flight) event', async () => {
    const readHasPendingPrompt = vi.fn().mockResolvedValue(true);
    const clearPendingPrompt = vi.fn().mockResolvedValue(undefined);
    const result = await clearStalePendingPromptOnTerminal(
      { type: 'session:waiting', sessionId },
      { readHasPendingPrompt, clearPendingPrompt },
    );
    expect(result).toBe(false);
    // A non-terminal event must not even probe the DB.
    expect(readHasPendingPrompt).not.toHaveBeenCalled();
    expect(clearPendingPrompt).not.toHaveBeenCalled();
  });

  it('does nothing when the bit cannot be determined (null)', async () => {
    const clearPendingPrompt = vi.fn().mockResolvedValue(undefined);
    const result = await clearStalePendingPromptOnTerminal(
      { type: 'session:completed', sessionId, attentionGeneration: 'turn-a' },
      { readHasPendingPrompt: async () => null, clearPendingPrompt },
    );
    expect(result).toBe(false);
    expect(clearPendingPrompt).not.toHaveBeenCalled();
  });

  it('reports read/clear failures without throwing', async () => {
    const onError = vi.fn();
    const result = await clearStalePendingPromptOnTerminal(
      { type: 'session:completed', sessionId, attentionGeneration: 'turn-a' },
      {
        readHasPendingPrompt: async () => {
          throw new Error('db down');
        },
        clearPendingPrompt: vi.fn(),
        onError,
      },
    );
    expect(result).toBe(false);
    expect(onError).toHaveBeenCalled();
  });

  it('does not let a delayed generation-A backstop clear generation B', async () => {
    const clearPendingPrompt = vi.fn().mockResolvedValue(undefined);
    const result = await clearStalePendingPromptOnTerminal(
      { type: 'session:completed', sessionId, attentionGeneration: 'turn-a' } as any,
      {
        readHasPendingPrompt: async () => ({
          hasPendingPrompt: true,
          promptId: 'prompt-b',
          generation: 'turn-b',
        }),
        clearPendingPrompt,
      } as any,
    );

    expect(result).toBe(false);
    expect(clearPendingPrompt).not.toHaveBeenCalled();
  });

  it('does not let a delayed generation-A error backstop clear generation B', async () => {
    const clearPendingPrompt = vi.fn().mockResolvedValue(undefined);
    const result = await clearStalePendingPromptOnTerminal(
      { type: 'session:error', sessionId, attentionGeneration: 'turn-a' },
      {
        readHasPendingPrompt: async () => ({
          hasPendingPrompt: true,
          promptId: 'prompt-b',
          generation: 'turn-b',
        }),
        clearPendingPrompt,
      },
    );

    expect(result).toBe(false);
    expect(clearPendingPrompt).not.toHaveBeenCalled();
  });
});
