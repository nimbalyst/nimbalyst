/**
 * Context-window fill tracking for the `claude-code-cli` proxy path (NIM-806,
 * Phase 3 / B3, Slice E).
 *
 * The SDK Claude Code path derives the "% used / Nk" indicator from each
 * `assistant` chunk's per-step `usage` inside `ClaudeCodeProvider`, which then
 * persists `currentContext` and emits `ai:tokenUsageUpdated`
 * (see docs/CONTEXT_WINDOW_USAGE_TRACKING.md). The genuine CLI runs out-of-process
 * and never enters that loop — but the proxy assembler captures the SAME per-turn
 * `usage`, so we reproduce the snapshot here from the assembled turn.
 *
 * Context fill = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
 * (output is generated, not context). Like `lastAssistantUsage`, the latest turn
 * wins — calling this on each assembled assistant turn keeps the indicator current.
 *
 * Deps are injected so the math + persistence are unit-testable without a DB or a
 * BrowserWindow.
 */

import { BrowserWindow } from 'electron';
import { AISessionsRepository } from '@nimbalyst/runtime';
import { SessionManager } from '@nimbalyst/runtime/ai/server';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import type { AssembledUsage } from './claudeCliObservation/claudeApiMessageAssembler';

type TokenUsage = NonNullable<SessionData['tokenUsage']>;

/** 1M extended-context CLI variants are suffixed `-1m`; Fable 5 is 1M by default. */
const CLI_DEFAULT_CONTEXT_WINDOW = 200_000;
const CLI_1M_CONTEXT_WINDOW = 1_000_000;

/** Context window for a CLI model id (`claude-code-cli:opus` / `…-1m`). */
export function contextWindowForCliModel(model: string | undefined): number {
  const normalized = model?.toLowerCase() ?? '';
  return normalized.includes('-1m') || normalized === 'fable' || normalized.endsWith(':fable') || normalized.includes('claude-fable-5')
    ? CLI_1M_CONTEXT_WINDOW
    : CLI_DEFAULT_CONTEXT_WINDOW;
}

/** Tokens occupying the context window for this step (excludes generated output). */
export function computeContextFillTokens(usage: AssembledUsage): number {
  return (
    (usage.inputTokens || 0) +
    (usage.cacheReadInputTokens || 0) +
    (usage.cacheCreationInputTokens || 0)
  );
}

/**
 * Merge one assembled turn's usage into the session's token usage:
 *   - cumulative `inputTokens`/`outputTokens`/`totalTokens` accumulate the new
 *     (uncached) input + generated output each turn, matching the SDK's cumulative
 *     display semantics. Cache reads are a per-round context detail surfaced via
 *     `currentContext`, not added to cumulative input.
 *   - `currentContext` is latest-wins (input + cache_read + cache_creation).
 *   - `costUSD` is NOT computed: the Anthropic SSE stream the proxy tees carries no
 *     cost; the SDK gets it from `result.modelUsage`, which we don't have. Left as-is.
 */
export function buildClaudeCliTokenUsage(
  prev: TokenUsage | undefined,
  usage: AssembledUsage,
  contextWindow: number,
): TokenUsage {
  const base = prev ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const fillTokens = computeContextFillTokens(usage);
  const inputTokens = (base.inputTokens || 0) + (usage.inputTokens || 0);
  const outputTokens = (base.outputTokens || 0) + (usage.outputTokens || 0);
  return {
    ...base,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    // Legacy mirror (kept for backward compatibility; UI reads currentContext).
    contextWindow,
    currentContext: {
      ...(base.currentContext ?? {}),
      tokens: fillTokens,
      contextWindow,
    },
  };
}

export interface LogClaudeCliContextUsageDeps {
  loadSession: (sessionId: string) => Promise<{ model?: string; tokenUsage?: TokenUsage } | null>;
  updateTokenUsage: (sessionId: string, tokenUsage: TokenUsage) => Promise<void>;
  notifyTokenUsage: (sessionId: string, tokenUsage: TokenUsage) => void;
}

let sessionManager: SessionManager | null = null;
function getSessionManager(): SessionManager {
  if (!sessionManager) sessionManager = new SessionManager();
  return sessionManager;
}

/** Broadcast `ai:tokenUsageUpdated` so `sessionTranscriptListeners` updates the indicator. */
function broadcastTokenUsage(sessionId: string, tokenUsage: TokenUsage): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('ai:tokenUsageUpdated', { sessionId, tokenUsage });
    }
  }
}

const productionDeps: LogClaudeCliContextUsageDeps = {
  loadSession: async (sessionId) => {
    const session = await AISessionsRepository.get(sessionId);
    return session ? { model: session.model, tokenUsage: session.tokenUsage } : null;
  },
  updateTokenUsage: (sessionId, tokenUsage) =>
    getSessionManager().updateSessionTokenUsage(sessionId, tokenUsage),
  notifyTokenUsage: broadcastTokenUsage,
};

/**
 * Persist + broadcast the context-fill snapshot for one assembled assistant turn.
 * Best-effort: a zero-fill turn is a no-op and any failure is swallowed (the next
 * turn refreshes the value anyway).
 */
export async function logClaudeCliContextUsage(
  input: { sessionId: string; usage: AssembledUsage },
  deps: LogClaudeCliContextUsageDeps = productionDeps,
): Promise<void> {
  const fillTokens = computeContextFillTokens(input.usage);
  if (fillTokens <= 0) return;

  try {
    const session = await deps.loadSession(input.sessionId);
    const contextWindow = contextWindowForCliModel(session?.model);
    const tokenUsage = buildClaudeCliTokenUsage(session?.tokenUsage, input.usage, contextWindow);
    await deps.updateTokenUsage(input.sessionId, tokenUsage);
    deps.notifyTokenUsage(input.sessionId, tokenUsage);
  } catch (err) {
    console.warn('[ClaudeCliContextUsage] Failed to update context usage:', err);
  }
}
