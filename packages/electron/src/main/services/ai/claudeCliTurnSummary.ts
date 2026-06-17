/**
 * Per-session turn summary registry for the Claude CLI path (NIM-806).
 *
 * Turn-completion side effects (the "Response Ready" notification, completion
 * sound, mobile push, `ai_response_received` analytics) must fire ONCE per
 * user-visible turn, when the turn is *fully* done. The authoritative signal for
 * that is the CLI PID file going `idle` (the parent `claude` process stays busy
 * until all in-process `Task` sub-agents finish) — NOT a proxy `end_turn`, which
 * also fires for each sub-agent mid-turn and would spuriously notify.
 *
 * The proxy observation backend (which sees the assistant text + tool names) and
 * the launcher's PID watcher (which sees the idle transition) live in different
 * modules. This dep-free registry bridges them: the observation records each
 * turn's running summary; the launcher reads + clears it on idle. Dep-free so it
 * can be imported by both without an import cycle (mirrors `claudeCliToolResultSeen`).
 */

export interface ClaudeCliTurnSummary {
  /** Latest non-empty assistant text seen this turn (notification body). */
  lastAssistantText: string;
  /** Tool names used across the whole turn, including sub-agent tools (deduped on read). */
  toolNames: string[];
}

const summaries = new Map<string, ClaudeCliTurnSummary>();

function ensure(sessionId: string): ClaudeCliTurnSummary {
  let s = summaries.get(sessionId);
  if (!s) {
    s = { lastAssistantText: '', toolNames: [] };
    summaries.set(sessionId, s);
  }
  return s;
}

/** Record one assembled assistant message's contribution to the in-flight turn. */
export function recordClaudeCliTurnMessage(
  sessionId: string,
  opts: { text?: string; toolNames?: string[] },
): void {
  const s = ensure(sessionId);
  if (opts.text && opts.text.trim().length > 0) s.lastAssistantText = opts.text;
  if (opts.toolNames && opts.toolNames.length > 0) s.toolNames.push(...opts.toolNames);
}

/** Read and clear the accumulated summary for a completed turn (PID idle). */
export function takeClaudeCliTurnSummary(sessionId: string): ClaudeCliTurnSummary | null {
  const s = summaries.get(sessionId);
  if (!s) return null;
  summaries.delete(sessionId);
  return s;
}

/** Drop any in-flight summary (session ended / observation stopped). */
export function clearClaudeCliTurnSummary(sessionId: string): void {
  summaries.delete(sessionId);
}
