import { describe, it, expect, vi } from 'vitest';
import {
  contextWindowForCliModel,
  computeContextFillTokens,
  buildClaudeCliTokenUsage,
  logClaudeCliContextUsage,
} from '../claudeCliContextUsage';

/**
 * NIM-806 Slice E — context-window fill for the CLI proxy path. The proxy bypasses
 * ClaudeCodeProvider/AIService, so we derive the "% used / Nk" snapshot from the
 * assembler's per-turn usage and push it through the same `currentContext` +
 * `ai:tokenUsageUpdated` mechanism the SDK path uses.
 */
describe('contextWindowForCliModel', () => {
  it('returns 200k for the standard variants', () => {
    expect(contextWindowForCliModel('claude-code-cli:opus')).toBe(200_000);
    expect(contextWindowForCliModel('claude-code-cli:sonnet')).toBe(200_000);
    expect(contextWindowForCliModel(undefined)).toBe(200_000);
  });
  it('returns 1M for the -1m extended-context variants', () => {
    expect(contextWindowForCliModel('claude-code-cli:opus-1m')).toBe(1_000_000);
    expect(contextWindowForCliModel('claude-code-cli:sonnet-1M')).toBe(1_000_000);
  });
  it('windows plain fable at 200k and fable-1m at 1M, matching the CLI’s [1m] gating', () => {
    // Claude Code windows plain `fable` at 200k client-side (observed: auto-
    // compact at ~177k on CLI 2.1.175) even though the API serves Fable at 1M.
    // The 1M window requires the fable[1m] model value — our fable-1m variant.
    expect(contextWindowForCliModel('claude-code-cli:fable')).toBe(200_000);
    expect(contextWindowForCliModel('claude-code-cli:fable-1m')).toBe(1_000_000);
  });
});

describe('computeContextFillTokens', () => {
  it('sums input + cache_read + cache_creation (excludes output)', () => {
    expect(
      computeContextFillTokens({
        inputTokens: 3,
        outputTokens: 42,
        cacheReadInputTokens: 83066,
        cacheCreationInputTokens: 239,
      }),
    ).toBe(3 + 83066 + 239);
  });
});

describe('buildClaudeCliTokenUsage', () => {
  it('accumulates cumulative input/output, preserves cost, sets currentContext', () => {
    const prev = { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUSD: 1.25 };
    // turn usage: 3 new input + 42 output; 8000 cache_read + 400 cache_creation
    const usage = buildClaudeCliTokenUsage(
      prev,
      { inputTokens: 3, outputTokens: 42, cacheReadInputTokens: 8000, cacheCreationInputTokens: 400 },
      200_000,
    );
    expect(usage).toMatchObject({
      inputTokens: 103, // 100 + 3 (cache reads NOT added to cumulative input)
      outputTokens: 92, // 50 + 42
      totalTokens: 195,
      costUSD: 1.25, // preserved (proxy can't compute cost)
      contextWindow: 200_000,
      currentContext: { tokens: 3 + 8000 + 400, contextWindow: 200_000 },
    });
  });
  it('tolerates a missing prior usage (fresh session)', () => {
    const usage = buildClaudeCliTokenUsage(
      undefined,
      { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 8388, cacheCreationInputTokens: 0 },
      1_000_000,
    );
    expect(usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
      currentContext: { tokens: 5 + 8388, contextWindow: 1_000_000 },
    });
  });
});

describe('logClaudeCliContextUsage', () => {
  function harness(session: { model?: string; tokenUsage?: any } | null) {
    const loadSession = vi.fn(async () => session);
    const updateTokenUsage = vi.fn(async (_sessionId: string, _tokenUsage: any) => undefined);
    const notifyTokenUsage = vi.fn((_sessionId: string, _tokenUsage: any) => {});
    return { loadSession, updateTokenUsage, notifyTokenUsage, deps: { loadSession, updateTokenUsage, notifyTokenUsage } };
  }
  const usage = { inputTokens: 3, outputTokens: 42, cacheReadInputTokens: 83066, cacheCreationInputTokens: 239 };

  it('persists currentContext from the turn usage and broadcasts the update', async () => {
    const h = harness({ model: 'claude-code-cli:opus', tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
    await logClaudeCliContextUsage({ sessionId: 's1', usage }, h.deps);
    expect(h.updateTokenUsage).toHaveBeenCalledTimes(1);
    const [sid, tokenUsage] = h.updateTokenUsage.mock.calls[0];
    expect(sid).toBe('s1');
    expect(tokenUsage.currentContext).toEqual({ tokens: 3 + 83066 + 239, contextWindow: 200_000 });
    expect(tokenUsage.inputTokens).toBe(13); // cumulative 10 + 3 new input
    expect(tokenUsage.outputTokens).toBe(47); // cumulative 5 + 42 output
    expect(h.notifyTokenUsage).toHaveBeenCalledWith('s1', tokenUsage);
  });

  it('uses the 1M window for a -1m model', async () => {
    const h = harness({ model: 'claude-code-cli:opus-1m' });
    await logClaudeCliContextUsage({ sessionId: 's1', usage }, h.deps);
    expect(h.updateTokenUsage.mock.calls[0][1].currentContext.contextWindow).toBe(1_000_000);
  });

  it('does nothing when the turn carries no context tokens', async () => {
    const h = harness({ model: 'claude-code-cli:opus' });
    await logClaudeCliContextUsage(
      { sessionId: 's1', usage: { inputTokens: 0, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
      h.deps,
    );
    expect(h.updateTokenUsage).not.toHaveBeenCalled();
    expect(h.notifyTokenUsage).not.toHaveBeenCalled();
  });

  it('swallows a load/update failure without throwing', async () => {
    const h = harness({ model: 'claude-code-cli:opus' });
    h.updateTokenUsage.mockRejectedValueOnce(new Error('db down'));
    await expect(logClaudeCliContextUsage({ sessionId: 's1', usage }, h.deps)).resolves.toBeUndefined();
    expect(h.notifyTokenUsage).not.toHaveBeenCalled();
  });
});
