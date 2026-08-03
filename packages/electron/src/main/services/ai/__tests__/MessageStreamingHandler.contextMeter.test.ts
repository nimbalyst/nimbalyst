import { describe, expect, it, vi } from 'vitest';

vi.mock('jotai-family', () => ({ atomFamily: vi.fn() }));

import { buildPersistedContextTokenUsage } from '../AIService';
import {
  applyMidTurnContextUsage,
  sanitizePersistedCurrentContext,
} from '../MessageStreamingHandler';

const cumulative = {
  inputTokens: 90_000,
  outputTokens: 10_000,
  totalTokens: 100_000,
};

describe('MessageStreamingHandler context persistence boundary', () => {
  it('excludes raw /context markdown from the durable token snapshot', () => {
    const rawResponse = 'provider-markdown-sentinel'.repeat(16_384);
    const next = buildPersistedContextTokenUsage(
      {
        ...cumulative,
        costUSD: 1.25,
        currentContext: {
          tokens: 1,
          contextWindow: 200_000,
          rawResponse,
        },
      },
      {
        totalTokens: 32_000,
        contextWindow: 200_000,
        categories: [{ name: 'System prompt', tokens: 8_000, percentage: 25 }],
      },
    );

    expect(next).toMatchObject({
      ...cumulative,
      costUSD: 1.25,
      contextWindow: 200_000,
      currentContext: {
        tokens: 32_000,
        contextWindow: 200_000,
        categories: [{ name: 'System prompt', tokens: 8_000, percentage: 25 }],
      },
    });
    expect(next.currentContext).not.toHaveProperty('rawResponse');
    expect(JSON.stringify(next)).not.toContain('provider-markdown-sentinel');
  });

  it('keeps mid-turn context usage transient without durable metadata or sync writes', () => {
    const session = {
      id: 'session-1',
      tokenUsage: { ...cumulative },
    };
    const send = vi.fn();
    const next = applyMidTurnContextUsage({
      session,
      contextFillTokens: 32_000,
      contextWindow: 200_000,
      send,
    });

    expect(next).toMatchObject({
      ...cumulative,
      contextWindow: 200_000,
      currentContext: { tokens: 32_000, contextWindow: 200_000 },
    });
    expect(session.tokenUsage).toBe(next);
    expect(send).toHaveBeenCalledWith({
      sessionId: 'session-1',
      tokenUsage: next,
    });
  });

  it('removes legacy raw provider markdown from completion fallback snapshots', () => {
    const legacyContext = {
      tokens: 32_000,
      contextWindow: 200_000,
      categories: [{ name: 'System prompt', tokens: 8_000, percentage: 25 }],
      rawResponse: 'legacy-provider-markdown'.repeat(16_384),
    };

    const persisted = sanitizePersistedCurrentContext(legacyContext);

    expect(persisted).toEqual({
      tokens: 32_000,
      contextWindow: 200_000,
      categories: [{ name: 'System prompt', tokens: 8_000, percentage: 25 }],
    });
    expect(persisted).not.toHaveProperty('rawResponse');
    expect(JSON.stringify(persisted)).not.toContain('legacy-provider-markdown');
  });
});
