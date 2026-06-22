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
