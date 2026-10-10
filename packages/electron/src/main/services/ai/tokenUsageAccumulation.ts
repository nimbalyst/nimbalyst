/**
 * Turn-end accumulation of a session's stored `metadata.tokenUsage`.
 *
 * Pure: the streaming handler resolves the context window and provider facts,
 * this module turns one `complete` chunk into the next cumulative snapshot.
 *
 * Stored counters (all cumulative over the session's lifetime):
 *   - inputTokens: uncached input only.
 *   - outputTokens: generated output.
 *   - cacheReadInputTokens / cacheCreationInputTokens: prompt-cache reads and
 *     writes. Disjoint from inputTokens, so input + output + cacheRead +
 *     cacheCreation counts every token once.
 *   - totalTokens: unchanged historical meaning, which differs per provider (see
 *     below). Existing displays and analytics read it, so it is not redefined.
 *
 * The `complete` chunk's usage follows Anthropic's shape: input_tokens is
 * uncached input, and cache_read_input_tokens / cache_creation_input_tokens are
 * separate. Protocols normalize to that; per provider:
 *   - claude-code, claude (chat): per-turn; Anthropic already reports this shape.
 *     totalTokens = input + output (no cache).
 *   - openai-codex (app-server): cumulative for the provider thread. Codex counts
 *     cached input inside input_tokens; CodexAppServerProtocol splits it out, and
 *     Codex reports no cache writes. Deltas are taken against cache-INCLUSIVE
 *     baselines, and totalTokens keeps counting the full input delta + output, as
 *     it always has. The legacy Codex SDK transport reports no split (0).
 *   - opencode: per-turn; tokens.input excludes tokens.cache.read/write.
 *   - No split reported, stored as 0 with the cached tokens (if any) left inside
 *     inputTokens: openai-codex-acp (ACP cachedRead/WriteTokens are dropped and
 *     usage is never populated), grok-build (input includes cache), cursor-agent
 *     (the record mapper folds cache into input), openai and lmstudio (OpenAI
 *     prompt_tokens include cache).
 *   - No usage at all: copilot-cli, antigravity-gemini-agent. Extension agents
 *     report whatever their ProtocolEvent usage carries.
 */
import type { SessionData, StreamChunk } from '@nimbalyst/runtime/ai/server/types';

export type StoredTokenUsage = NonNullable<SessionData['tokenUsage']>;
type ChunkUsage = NonNullable<StreamChunk['usage']>;
type ModelUsage = NonNullable<StreamChunk['modelUsage']>;

const EMPTY_USAGE: StoredTokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** The two cache counters after adding one turn's reads and writes. */
function withCache(current: StoredTokenUsage, cacheRead: number, cacheCreation: number) {
  return {
    cacheReadInputTokens: count(current.cacheReadInputTokens) + cacheRead,
    cacheCreationInputTokens: count(current.cacheCreationInputTokens) + cacheCreation,
  };
}

export interface ClaudeCodeTurnUsageInput {
  usage: ChunkUsage | undefined;
  modelUsage: ModelUsage;
  contextFillTokens: number | undefined;
  contextCompacted: boolean;
  /** The parent model's window, already resolved by the caller. */
  contextWindow: number | undefined;
}

export function accumulateClaudeCodeTurnUsage(
  current: StoredTokenUsage | undefined,
  turn: ClaudeCodeTurnUsageInput
): StoredTokenUsage {
  const base = current ?? EMPTY_USAGE;
  // Cumulative input/output come from result.usage (chunk.usage), which Anthropic
  // deduplicates by message.id. Do NOT sum modelUsage tokens for these -- the SDK
  // over-counts them from duplicated assistant events (each message is emitted 2-3x,
  // one event per content block), inflating the tooltip totals. See NIM-689.
  // Cost still derives from modelUsage (the only per-model cost source; not displayed).
  const newInputTokens = count(turn.usage?.input_tokens);
  const newOutputTokens = count(turn.usage?.output_tokens);
  let newCostUSD = 0;
  for (const modelName of Object.keys(turn.modelUsage)) {
    newCostUSD += turn.modelUsage[modelName].costUSD || 0;
  }

  return {
    inputTokens: base.inputTokens + newInputTokens,
    outputTokens: base.outputTokens + newOutputTokens,
    totalTokens: base.totalTokens + newInputTokens + newOutputTokens,
    ...withCache(base, count(turn.usage?.cache_read_input_tokens), count(turn.usage?.cache_creation_input_tokens)),
    costUSD: (base.costUSD || 0) + newCostUSD,
    // Both figures go, not just the fill. The meter falls back to
    // cumulative `totalTokens` over whatever denominator survives,
    // so clearing the fill alone turns a stale 90% into a confident
    // 600%. With no denominator it reports plain token totals and
    // claims nothing about context until a turn measures it.
    contextWindow: turn.contextCompacted ? undefined : turn.contextWindow,
    // contextFillTokens = input + cacheRead + cacheCreation from last assistant message
    // This is the actual context fill, not cumulative - updates correctly after compaction
    // After compaction, clear stale currentContext (next real turn will set accurate value)
    currentContext: turn.contextCompacted
      ? undefined
      : (turn.contextFillTokens !== undefined && turn.contextWindow)
        ? { tokens: turn.contextFillTokens, contextWindow: turn.contextWindow }
        : base.currentContext,
  };
}

export interface ProviderTurnUsageInput {
  usage: ChunkUsage;
  /** True for 'openai-codex', whose usage is cumulative for the provider thread. */
  threadCumulative: boolean;
  /** A resumed Codex thread with no stored baseline: its first snapshot is not new spend. */
  isResumedThread: boolean;
  reportsCurrentContext: boolean;
  /** The measured window when the provider reports context, else undefined. */
  reportedContextWindow: number | undefined;
  contextFillTokens: number | undefined;
  contextCompacted: boolean;
}

export function accumulateProviderTurnUsage(
  current: StoredTokenUsage | undefined,
  turn: ProviderTurnUsageInput
): StoredTokenUsage {
  const base = current ?? EMPTY_USAGE;
  const storedContextWindow = turn.reportedContextWindow || base.contextWindow;
  const next = turn.threadCumulative
    ? threadCumulativeCounters(base, turn)
    : perTurnCounters(base, turn.usage);

  return {
    ...next,
    // A compaction just replaced the conversation with a summary, so
    // every fill figure in hand describes context that no longer
    // exists -- including the one this chunk reports, which is read
    // off the last assistant message from before the boundary. The
    // denominator goes with it: the meter otherwise falls back to
    // cumulative spend over the window and reports a confident,
    // wrong percentage. Report nothing until a turn measures the new
    // context. Codex and OpenCode reach this branch.
    contextWindow: turn.contextCompacted ? undefined : storedContextWindow,
    currentContext: turn.contextCompacted
      ? undefined
      : turn.reportsCurrentContext
        ? (turn.contextFillTokens !== undefined && turn.reportedContextWindow
          ? { tokens: turn.contextFillTokens, contextWindow: turn.reportedContextWindow }
          : base.currentContext)
        : base.currentContext,
  };
}

function perTurnCounters(base: StoredTokenUsage, usage: ChunkUsage) {
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  return {
    inputTokens: base.inputTokens + input,
    outputTokens: base.outputTokens + output,
    totalTokens: base.totalTokens + input + output,
    ...withCache(base, count(usage.cache_read_input_tokens), count(usage.cache_creation_input_tokens)),
  };
}

/**
 * Codex turn usage is cumulative for the provider thread. Convert it to
 * per-session deltas using the last seen cumulative snapshot. Baselines are
 * cache-inclusive (the shape stored before the cache split existed), and the
 * cached share of the input delta is moved to cacheReadInputTokens.
 */
function threadCumulativeCounters(base: StoredTokenUsage, turn: ProviderTurnUsageInput) {
  const cumulativeCached =
    count(turn.usage.cache_read_input_tokens) + count(turn.usage.cache_creation_input_tokens);
  const cumulativeInput = count(turn.usage.input_tokens) + cumulativeCached;
  const cumulativeOutput = count(turn.usage.output_tokens);

  const previousCumulativeInput =
    typeof base.providerCumulativeInputTokens === 'number'
      ? base.providerCumulativeInputTokens
      : base.inputTokens > 0
        ? base.inputTokens
        : undefined;
  const previousCumulativeOutput =
    typeof base.providerCumulativeOutputTokens === 'number'
      ? base.providerCumulativeOutputTokens
      : base.outputTokens > 0
        ? base.outputTokens
        : undefined;
  const hasPreviousCumulative =
    typeof previousCumulativeInput === 'number' &&
    typeof previousCumulativeOutput === 'number';

  const deltaInput = hasPreviousCumulative
    ? Math.max(cumulativeInput - previousCumulativeInput, 0)
    : (turn.isResumedThread ? 0 : cumulativeInput);
  const deltaOutput = hasPreviousCumulative
    ? Math.max(cumulativeOutput - previousCumulativeOutput, 0)
    : (turn.isResumedThread ? 0 : cumulativeOutput);

  // A row written before the cached baseline existed counts this turn's input
  // as uncached and records the baseline. Clamping to the input delta keeps
  // uncached + cached == deltaInput, so the split can be approximate for one
  // turn but the sum never double counts.
  const previousCumulativeCached = base.providerCumulativeCachedInputTokens;
  const rawCachedDelta = hasPreviousCumulative
    ? (typeof previousCumulativeCached === 'number' ? cumulativeCached - previousCumulativeCached : 0)
    : (turn.isResumedThread ? 0 : cumulativeCached);
  const deltaCached = Math.min(Math.max(rawCachedDelta, 0), deltaInput);

  return {
    inputTokens: base.inputTokens + deltaInput - deltaCached,
    outputTokens: base.outputTokens + deltaOutput,
    totalTokens: base.totalTokens + deltaInput + deltaOutput,
    ...withCache(base, deltaCached, 0),
    providerCumulativeInputTokens: cumulativeInput,
    providerCumulativeOutputTokens: cumulativeOutput,
    providerCumulativeCachedInputTokens: cumulativeCached,
  };
}
