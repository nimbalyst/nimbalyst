// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  accumulateClaudeCodeTurnUsage,
  accumulateProviderTurnUsage,
  type ProviderTurnUsageInput,
} from '../tokenUsageAccumulation';

const claudeTurn = (input: number, output: number, cacheRead: number, cacheCreation: number) => ({
  usage: {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  },
  modelUsage: { 'claude-opus': { costUSD: 0.25 } },
  contextFillTokens: input + cacheRead + cacheCreation,
  contextCompacted: false,
  contextWindow: 200_000,
});

describe('accumulateClaudeCodeTurnUsage', () => {
  it('accumulates cache reads/writes across turns and leaves totalTokens as input + output', () => {
    const first = accumulateClaudeCodeTurnUsage(undefined, claudeTurn(14, 6_742, 118_000, 7_000));
    const second = accumulateClaudeCodeTurnUsage(first, claudeTurn(6, 300, 125_000, 1_200));

    expect(second).toMatchObject({
      inputTokens: 20,
      outputTokens: 7_042,
      totalTokens: 7_062,
      cacheReadInputTokens: 243_000,
      cacheCreationInputTokens: 8_200,
      costUSD: 0.5,
      currentContext: { tokens: 126_206, contextWindow: 200_000 },
    });
  });

  it('reads a row stored before the cache fields existed as 0', () => {
    const next = accumulateClaudeCodeTurnUsage(
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      claudeTurn(1, 1, 10, 5)
    );
    expect(next).toMatchObject({ totalTokens: 152, cacheReadInputTokens: 10, cacheCreationInputTokens: 5 });
  });
});

const codexTurn = (uncachedInput: number, cached: number, output: number): ProviderTurnUsageInput => ({
  // Thread-cumulative, as CodexAppServerProtocol emits it: cached split out of input.
  usage: {
    input_tokens: uncachedInput,
    output_tokens: output,
    total_tokens: uncachedInput + cached + output,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  },
  threadCumulative: true,
  isResumedThread: false,
  reportsCurrentContext: true,
  reportedContextWindow: 258_400,
  contextFillTokens: 4_000,
  contextCompacted: false,
});

const allTokens = (u: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }) =>
  u.inputTokens + u.outputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0);

describe('accumulateProviderTurnUsage (openai-codex, thread-cumulative)', () => {
  it('diffs cumulative snapshots without double counting cached input', () => {
    // Turn 1: 19146 input of which 9984 cached, 5 output.
    const first = accumulateProviderTurnUsage(undefined, codexTurn(9_162, 9_984, 5));
    // Turn 2 (cumulative): 30000 input of which 18000 cached, 105 output.
    const second = accumulateProviderTurnUsage(first, codexTurn(12_000, 18_000, 105));

    expect(second).toMatchObject({
      inputTokens: 12_000,
      cacheReadInputTokens: 18_000,
      cacheCreationInputTokens: 0,
      outputTokens: 105,
      // Historical meaning: full (cache-inclusive) input + output.
      totalTokens: 30_105,
      providerCumulativeInputTokens: 30_000,
      providerCumulativeCachedInputTokens: 18_000,
    });
    expect(allTokens(second)).toBe(30_105);
  });

  it('keeps the sum exact for a row whose baseline predates the cached baseline', () => {
    const legacy = {
      inputTokens: 19_146,
      outputTokens: 5,
      totalTokens: 19_151,
      providerCumulativeInputTokens: 19_146,
      providerCumulativeOutputTokens: 5,
    };
    const next = accumulateProviderTurnUsage(legacy, codexTurn(5_000, 25_000, 105));
    // No cached baseline yet: this turn's 10854 new input counts as uncached once.
    expect(next).toMatchObject({ inputTokens: 30_000, cacheReadInputTokens: 0, totalTokens: 30_105 });
    expect(allTokens(next)).toBe(30_105);
    const after = accumulateProviderTurnUsage(next, codexTurn(5_500, 26_000, 205));
    expect(after).toMatchObject({ inputTokens: 30_500, cacheReadInputTokens: 1_000, totalTokens: 31_705 });
  });
});

describe('accumulateProviderTurnUsage (per-turn providers)', () => {
  it('adds the chunk cache split as-is and stores 0 when a provider reports none', () => {
    const turn = (usage: ProviderTurnUsageInput['usage']): ProviderTurnUsageInput => ({
      usage,
      threadCumulative: false,
      isResumedThread: false,
      reportsCurrentContext: false,
      reportedContextWindow: undefined,
      contextFillTokens: undefined,
      contextCompacted: false,
    });
    const opencode = accumulateProviderTurnUsage(
      undefined,
      turn({ input_tokens: 320, output_tokens: 55, total_tokens: 375, cache_read_input_tokens: 3_100, cache_creation_input_tokens: 130 })
    );
    expect(opencode).toMatchObject({ inputTokens: 320, totalTokens: 375, cacheReadInputTokens: 3_100, cacheCreationInputTokens: 130 });

    const noSplit = accumulateProviderTurnUsage(undefined, turn({ input_tokens: 14_697, output_tokens: 10, total_tokens: 14_707 }));
    expect(noSplit).toMatchObject({ inputTokens: 14_697, totalTokens: 14_707, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  });
});
