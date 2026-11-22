/** Context-window fill for one session, as shown on the session list row. */
export interface SessionContextUsage {
  tokens: number;
  contextWindow: number;
}

export type ContextUsageLevel = 'normal' | 'warning' | 'critical';

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Pick the context fill out of a session's persisted `metadata.tokenUsage`.
 * Only `currentContext` is a real fill measurement; the cumulative counters
 * and the legacy top-level `contextWindow` are spend, not occupancy, so a
 * session without a snapshot (compacted, never reported, unsupported
 * provider) returns undefined and the row shows no bar.
 */
export function readSessionContextUsage(tokenUsage: unknown): SessionContextUsage | undefined {
  if (!tokenUsage || typeof tokenUsage !== 'object') return undefined;
  const current = (tokenUsage as { currentContext?: unknown }).currentContext;
  if (!current || typeof current !== 'object') return undefined;
  const tokens = positiveNumber((current as { tokens?: unknown }).tokens);
  const contextWindow = positiveNumber((current as { contextWindow?: unknown }).contextWindow);
  if (tokens === undefined || contextWindow === undefined) return undefined;
  return { tokens, contextWindow };
}

export function contextUsagePercent(usage: SessionContextUsage): number {
  return Math.round((usage.tokens / usage.contextWindow) * 100);
}

/** Same thresholds as the chat-input context meter. */
export function contextUsageLevel(percent: number): ContextUsageLevel {
  if (percent >= 90) return 'critical';
  if (percent >= 80) return 'warning';
  return 'normal';
}
