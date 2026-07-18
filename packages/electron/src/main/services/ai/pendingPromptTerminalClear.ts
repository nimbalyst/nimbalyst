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
 * A terminal turn event carries the generation captured for that turn. The
 * recovery clear is allowed only when the persisted prompt has the same
 * generation, so a delayed terminal callback cannot erase a newer prompt.
 */

const TERMINAL_SESSION_EVENT_TYPES = new Set([
  'session:completed',
  'session:error',
  'session:interrupted',
]);

export function isTerminalSessionEvent(type: string): boolean {
  return TERMINAL_SESSION_EVENT_TYPES.has(type);
}

/** Find historical rows whose workflow is complete but prompt bit is stale. */
export function findCompletedSessionsWithPendingPrompt(
  sessions: Array<{ id: string; metadata: Record<string, unknown> }>,
): string[] {
  return sessions
    .filter(({ metadata }) => metadata.phase === 'complete' && metadata.hasPendingPrompt === true)
    .map(({ id }) => id);
}

export interface PendingPromptTerminalClearDeps {
  /**
   * Read the current persisted prompt bit and identity. Returns `null` when the
   * row cannot be determined; in that case recovery is a no-op.
   */
  readHasPendingPrompt: (sessionId: string) => Promise<{
    hasPendingPrompt: boolean;
    promptId?: string;
    generation?: string;
  } | null>;
  /** Clear the persisted bit (DB write + mobile sync push). */
  clearPendingPrompt: (
    sessionId: string,
    options: { expectedGeneration: string },
  ) => Promise<void>;
  onError?: (err: unknown) => void;
}

/**
 * On a terminal session event, clear the persisted bit iff it is currently set
 * for the same generation. Returns true when a clear was performed.
 */
export async function clearStalePendingPromptOnTerminal(
  event: { type: string; sessionId: string; attentionGeneration?: string },
  deps: PendingPromptTerminalClearDeps,
): Promise<boolean> {
  if (!isTerminalSessionEvent(event.type) || !event.sessionId) return false;
  if (!event.attentionGeneration) return false;
  try {
    const current = await deps.readHasPendingPrompt(event.sessionId);
    if (current?.hasPendingPrompt !== true) return false;
    if (current.generation !== event.attentionGeneration) return false;
    await deps.clearPendingPrompt(event.sessionId, {
      expectedGeneration: event.attentionGeneration,
    });
    return true;
  } catch (err) {
    deps.onError?.(err);
    return false;
  }
}
