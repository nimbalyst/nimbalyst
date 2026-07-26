import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  contextWindowForCliModel,
  computeContextFillTokens,
  buildClaudeCliTokenUsage,
  logClaudeCliContextUsage,
  noteClaudeCliObserved1mSupport,
  clearClaudeCliObserved1mSupport,
} from '../claudeCliContextUsage';

/**
 * NIM-806 Slice E — context-window fill for the CLI proxy path. The proxy bypasses
 * ClaudeCodeProvider/AIService, so we derive the "% used / Nk" snapshot from the
 * assembler's per-turn usage and push it through the same `currentContext` +
 * `ai:tokenUsageUpdated` mechanism the SDK path uses.
 */
describe('contextWindowForCliModel', () => {
  it('returns 1M for current-gen base variants (opus/fable/sonnet run 1M natively)', () => {
    // GitHub #825: on the current CLI plain opus/fable/sonnet report a 1M window
    // at a flat price — the earlier 200k client-side windowing (CLI 2.1.175) is
    // stale. Plain and -1m are identical for these.
    expect(contextWindowForCliModel('claude-code-cli:opus')).toBe(1_000_000);
    expect(contextWindowForCliModel('claude-code-cli:sonnet')).toBe(1_000_000);
    expect(contextWindowForCliModel('claude-code-cli:fable')).toBe(1_000_000);
  });
  it('returns 1M for the -1m extended-context variants', () => {
    expect(contextWindowForCliModel('claude-code-cli:opus-1m')).toBe(1_000_000);
    expect(contextWindowForCliModel('claude-code-cli:sonnet-1M')).toBe(1_000_000);
    expect(contextWindowForCliModel('claude-code-cli:fable-1m')).toBe(1_000_000);
  });
  it('returns 1M for legacy pinned variants (single row, no -1m duplicate) and 200k for haiku', () => {
    // opus-4-6/opus-4-7/sonnet-4-6 are 1M models too — matched by EXACT variant,
    // not family, so the mapping is precise rather than an accidental collapse.
    expect(contextWindowForCliModel('claude-code-cli:opus-4-6')).toBe(1_000_000);
    expect(contextWindowForCliModel('claude-code-cli:opus-4-7')).toBe(1_000_000);
    expect(contextWindowForCliModel('claude-code-cli:sonnet-4-6')).toBe(1_000_000);
    expect(contextWindowForCliModel('claude-code-cli:haiku')).toBe(200_000);
    expect(contextWindowForCliModel(undefined)).toBe(200_000);
  });

  /**
   * NIM-2170: the per-variant table is a SEED, not the truth. 1M is plan-gated
   * (Max/Team/Enterprise auto-upgrade; Pro needs credits) and our own
   * ANTHROPIC_BASE_URL observation proxy makes the CLI treat the connection as a
   * gateway, which skips the auto-upgrade. The outbound `anthropic-beta` header
   * is the live signal, so when we've observed it the observation wins.
   */
  it('lets an observed 1M signal override the static per-variant seed', () => {
    expect(contextWindowForCliModel('claude-code-cli:opus', false)).toBe(200_000);
    expect(contextWindowForCliModel('claude-code-cli:opus-1m', false)).toBe(200_000);
    expect(contextWindowForCliModel('claude-code-cli:haiku', true)).toBe(1_000_000);
    // No observation yet -> unchanged seed behavior.
    expect(contextWindowForCliModel('claude-code-cli:opus', undefined)).toBe(1_000_000);
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
    // Plain opus now runs 1M natively on the current CLI (GitHub #825).
    expect(tokenUsage.currentContext).toEqual({ tokens: 3 + 83066 + 239, contextWindow: 1_000_000 });
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

  /**
   * NIM-2170 — the CLI path has no runtime `modelUsage`, so `AssembledUsage`
   * carries no window and this denominator is PERMANENT. The proxy's observed
   * `anthropic-beta` flag is the only correction available; without it a
   * gateway-downgraded 200k session shows a meter that can never exceed 20%.
   */
  describe('observed 1M signal from the proxy', () => {
    beforeEach(() => {
      clearClaudeCliObserved1mSupport('s1');
    });

    async function windowAfterLog(sessionModel: string): Promise<number> {
      const h = harness({ model: sessionModel });
      await logClaudeCliContextUsage({ sessionId: 's1', usage }, h.deps);
      return h.updateTokenUsage.mock.calls[0][1].currentContext.contextWindow;
    }

    it('downgrades to 200k when the observed request omitted the 1M beta flag', async () => {
      noteClaudeCliObserved1mSupport('s1', { model: 'claude-opus-5-20260514', supports1m: false });
      expect(await windowAfterLog('claude-code-cli:opus')).toBe(200_000);
    });

    it('uses 1M when the observed request carried the 1M beta flag', async () => {
      noteClaudeCliObserved1mSupport('s1', { model: 'claude-opus-5-20260514', supports1m: true });
      expect(await windowAfterLog('claude-code-cli:opus')).toBe(1_000_000);
    });

    it('does not let a Haiku sub-agent request downgrade the parent Opus session', async () => {
      // Task sub-agents run through the SAME proxy on a smaller model; their
      // requests never carry the 1M flag and must not move the parent denominator.
      noteClaudeCliObserved1mSupport('s1', { model: 'claude-opus-5-20260514', supports1m: true });
      noteClaudeCliObserved1mSupport('s1', { model: 'claude-haiku-4-5-20251001', supports1m: false });
      expect(await windowAfterLog('claude-code-cli:opus')).toBe(1_000_000);
    });

    it('is scoped per session and cleared when observation stops', async () => {
      noteClaudeCliObserved1mSupport('s2', { model: 'claude-opus-5-20260514', supports1m: false });
      // s1 never observed anything -> keeps the seed.
      expect(await windowAfterLog('claude-code-cli:opus')).toBe(1_000_000);
      clearClaudeCliObserved1mSupport('s2');
      const h = harness({ model: 'claude-code-cli:opus' });
      await logClaudeCliContextUsage({ sessionId: 's2', usage }, h.deps);
      expect(h.updateTokenUsage.mock.calls[0][1].currentContext.contextWindow).toBe(1_000_000);
    });
  });
});
