import { describe, expect, it, vi } from 'vitest';
import { settleTerminalAttentionBeforeContinuation } from '../terminalAttentionSettlement';

function makePromptClear() {
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

describe('settleTerminalAttentionBeforeContinuation', () => {
  for (const reason of ['completed', 'error'] as const) {
    it(`publishes prompt false and settles ${reason} attention before queued dispatch`, async () => {
      const order: string[] = [];
      const clearPendingPrompt = vi.fn(async () => {
        order.push('prompt:false');
        return makePromptClear();
      });
      const settleAttention = vi.fn(async () => {
        order.push(`attention:${reason}`);
        return 1;
      });

      const result = await settleTerminalAttentionBeforeContinuation(
        {
          sessionId: 'session-1',
          attentionGeneration: 'turn-a',
          expectedPromptId: 'prompt-a',
          reason,
        },
        async () => {
          order.push('dispatch');
          return true;
        },
        { clearPendingPrompt, settleAttention },
      );

      expect(order).toEqual(['prompt:false', `attention:${reason}`, 'dispatch']);
      expect(clearPendingPrompt).toHaveBeenCalledWith('session-1', false, {
        expectedPromptId: 'prompt-a',
        expectedGeneration: 'turn-a',
      });
      expect(settleAttention).toHaveBeenCalledWith('session-1', {
        attentionGeneration: 'turn-a',
        promptIdentity: 'prompt-a',
        reason,
      });
      expect(result.continuationResult).toBe(true);
    });
  }

  it('uses an exact compare-clear already completed under the prompt action lock', async () => {
    const order: string[] = [];
    const promptClear = makePromptClear();
    const clearPendingPrompt = vi.fn(async () => {
      throw new Error('must not clear twice while the prompt lock is held');
    });
    const settleAttention = vi.fn(async () => {
      order.push('attention:completed');
      return 1;
    });

    const result = await settleTerminalAttentionBeforeContinuation(
      {
        sessionId: 'session-1',
        attentionGeneration: 'turn-a',
        expectedPromptId: 'prompt-a',
        preclearedPrompt: promptClear,
        reason: 'completed',
      },
      async () => {
        order.push('terminal');
        return 'settled';
      },
      { clearPendingPrompt, settleAttention },
    );

    expect(clearPendingPrompt).not.toHaveBeenCalled();
    expect(order).toEqual(['attention:completed', 'terminal']);
    expect(result.promptClear).toBe(promptClear);
    expect(result.continuationResult).toBe('settled');
  });
});
