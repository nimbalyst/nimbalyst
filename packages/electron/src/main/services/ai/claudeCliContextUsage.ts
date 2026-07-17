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
import { AISessionsRepository, CLAUDE_CODE_NATIVE_1M_VARIANTS, normalizeClaudeCodeVariant } from '@nimbalyst/runtime';
import { SessionManager } from '@nimbalyst/runtime/ai/server';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import type { AssembledUsage } from './claudeCliObservation/claudeApiMessageAssembler';

type TokenUsage = NonNullable<SessionData['tokenUsage']>;

/**
 * Context window for a CLI model id (`claude-code-cli:opus` / `…-1m`).
 *
 * The proxy assembler (`AssembledUsage`) does not carry a real per-model window,
 * so unlike the SDK path we can't read the CLI-reported value — we map by
 * variant. All 1M variants (`opus`/`fable`/`sonnet` and the pinned legacy
 * `opus-4-7`/`opus-4-6`/`sonnet-4-6`) run 1M natively at a flat price on the
 * current CLI, so their single base row is 1M — the earlier "plain fable windows
 * at 200k" behavior (real on 2.1.175) is stale. Only `haiku` stays 200k.
 */
const CLI_DEFAULT_CONTEXT_WINDOW = 200_000;
const CLI_1M_CONTEXT_WINDOW = 1_000_000;

export function contextWindowForCliModel(model: string | undefined): number {
  if (!model) return CLI_DEFAULT_CONTEXT_WINDOW;
  // Explicit `-1m` selection is always 1M.
  if (model.toLowerCase().includes('-1m')) return CLI_1M_CONTEXT_WINDOW;
  // Current-gen variants run 1M at their base row too. Use the EXACT variant
  // (not the family) so legacy `opus-4-6`/`opus-4-7`/`sonnet-4-6` — which share
  // the opus/sonnet family — are not mistaken for the current-gen 1M variants.
  const modelPart = model.includes(':') ? model.slice(model.indexOf(':') + 1) : model;
  const variant = normalizeClaudeCodeVariant(modelPart.toLowerCase().replace(/-1m$/, ''));
  if (variant && (CLAUDE_CODE_NATIVE_1M_VARIANTS as readonly string[]).includes(variant)) {
    return CLI_1M_CONTEXT_WINDOW;
  }
  return CLI_DEFAULT_CONTEXT_WINDOW;
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
