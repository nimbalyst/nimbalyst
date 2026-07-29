/**
 * NIM-871: clear a stale persisted pending-prompt bit when a turn ends.
 *
 * An interactive prompt (AskUserQuestion, GitCommitProposal, ExitPlanMode,
 * ToolPermission, PromptForUserInput) sets `ai_sessions.metadata.hasPendingPrompt`
 * to true. It is otherwise cleared ONLY by the explicit answer/cancel/commit
 * events. If the user abandons the widget — typically by submitting a NEW prompt
 * instead of answering — the turn completes with the bit still set. The
 * session-list loader rehydrates the "awaiting input" indicator straight from
 * this bit (`PGLiteSessionStore` -> `hasPendingInteractivePrompt`), so the
 * session stays stuck showing "awaiting user input" across every refresh.
 *
 * A terminal turn event means the turn is genuinely over. An interactive prompt
 * can only be legitimately open while the turn is blocked on the MCP call, never
 * after it ends, so any bit still set at terminal time is stale. Clearing it here
 * mirrors the renderer's unconditional terminal-event atom clear in
 * `sessionStateListeners` — this is the durable, mobile-reaching counterpart.
 */

const TERMINAL_SESSION_EVENT_TYPES = new Set([
  'session:completed',
  'session:error',
  'session:interrupted',
]);

export function isTerminalSessionEvent(type: string): boolean {
  return TERMINAL_SESSION_EVENT_TYPES.has(type);
}

/**
 * NIM-2208: every row whose prompt bit is set, for the startup sweep.
 *
 * This intentionally ignores `phase`. The previous repair only matched
 * `phase === 'complete'`, which missed the entire real-world population — the
 * sessions that stick are the ones abandoned mid-workflow (planning /
 * implementing / validating / no phase at all), and they accumulated for weeks.
 *
 * At startup the sweep needs no liveness check: no AI process survives an app
 * restart and `SessionStateManager.activeSessions` is empty, so a set bit cannot
 * correspond to anything still blocked. Callers must only run this BEFORE any
 * session can start a turn.
 */
export function findSessionsWithPendingPrompt(
  sessions: Array<{ id: string; metadata: Record<string, unknown> }>,
): string[] {
  return sessions
    .filter(({ metadata }) => metadata.hasPendingPrompt === true)
    .map(({ id }) => id);
}

/**
 * NIM-2208: rows whose prompt bit is set but which nothing in memory could still
 * be blocked on — the mid-session counterpart to the startup sweep, for a turn
 * that died without emitting a terminal event.
 *
 * Both guards are required, because the bit has two independent writers:
 *
 * - MCP handlers (AskUserQuestion, GitCommitProposal, RequestUserInput) block on
 *   a response channel and are covered by `hasLiveInteractivePrompt`.
 * - Provider-driven prompts (ExitPlanMode and friends, wired in
 *   `MessageStreamingHandler`) set the bit with no MCP waiter at all, so the
 *   waiter registry reads 0 for a genuinely blocked session. `isSessionTracked`
 *   (bare `SessionStateManager` map membership, NOT a running check) covers
 *   them: if a session has no in-memory entry, no live provider can be waiting
 *   on it.
 *
 * Anything still tracked is left alone and healed by the terminal-event clear or
 * the next startup sweep. Erring toward keeping the flag only reproduces today's
 * behaviour; erring the other way would hide a session that really is waiting on
 * the user.
 */
export function selectStalePendingPromptSessions(params: {
  /**
   * Sessions currently carrying the bit. Supplied from the in-memory mirror in
   * `pendingPromptPersistence` rather than a query — reading it back would mean
   * scanning every session row (5k+ on a working install) on every pass.
   */
  sessionIds: readonly string[];
  hasLiveInteractivePrompt: (sessionId: string) => boolean;
  isSessionTracked: (sessionId: string) => boolean;
}): string[] {
  const { sessionIds, hasLiveInteractivePrompt, isSessionTracked } = params;
  return sessionIds.filter((id) => !hasLiveInteractivePrompt(id) && !isSessionTracked(id));
}

export interface PendingPromptTerminalClearDeps {
  /**
   * Read the current persisted `hasPendingPrompt` bit for a session. Returns
   * `null` when the value can't be determined (e.g. the row is gone); in that
   * case we do nothing rather than churn a write.
   */
  readHasPendingPrompt: (sessionId: string) => Promise<boolean | null>;
  /** Clear the persisted bit (DB write + mobile sync push). */
  clearPendingPrompt: (sessionId: string) => Promise<void>;
  onError?: (err: unknown) => void;
}

/**
 * On a terminal session event, clear the persisted pending-prompt bit IFF it is
 * currently set. The read-guard keeps a normal turn end (no prompt was ever
 * open) from writing metadata and pushing a mobile sync change on every single
 * completion. Returns true when a clear was performed.
 */
export async function clearStalePendingPromptOnTerminal(
  event: { type: string; sessionId: string },
  deps: PendingPromptTerminalClearDeps,
): Promise<boolean> {
  if (!isTerminalSessionEvent(event.type) || !event.sessionId) return false;
  try {
    const current = await deps.readHasPendingPrompt(event.sessionId);
    if (current !== true) return false;
    await deps.clearPendingPrompt(event.sessionId);
    return true;
  } catch (err) {
    deps.onError?.(err);
    return false;
  }
}
