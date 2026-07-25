// NIM-1981: On the Codex (openai-codex app-server) path the live MCP waiter and
// the transcript widget can end up with unrelated tool-call ids, so an answer
// delivered on the session-scoped `__fallback__` channel carries ids that don't
// match the waiter's alias set. The waiter's strict id guard then rejected the
// correct answer and the turn hung. Interactive prompts block the turn and are
// effectively serial per session, so a session-scoped fallback answer is
// unambiguous whenever exactly one prompt is pending for that session. This
// module holds the (pure) accept decision plus a tiny per-session pending-waiter
// registry so the guard can be relaxed safely in that sole-pending case while
// staying strict when multiple prompts are concurrently pending.

/** Per-session count of interactive prompt waiters currently blocked on input. */
const pendingInteractiveWaiters = new Map<string, number>();

/** Record that a new interactive prompt waiter has started blocking for a session. */
export function notePendingInteractiveWaiter(sessionKey: string): void {
  pendingInteractiveWaiters.set(
    sessionKey,
    (pendingInteractiveWaiters.get(sessionKey) ?? 0) + 1,
  );
}

/** Record that an interactive prompt waiter has settled for a session. */
export function clearPendingInteractiveWaiter(sessionKey: string): void {
  const next = (pendingInteractiveWaiters.get(sessionKey) ?? 0) - 1;
  if (next <= 0) {
    pendingInteractiveWaiters.delete(sessionKey);
  } else {
    pendingInteractiveWaiters.set(sessionKey, next);
  }
}

/** How many interactive prompt waiters are currently pending for a session. */
export function countPendingInteractiveWaiters(sessionKey: string): number {
  return pendingInteractiveWaiters.get(sessionKey) ?? 0;
}

/**
 * Decide whether a session-scoped fallback response should settle the waiter.
 *
 * - A synthetic (`rui-`) waiter never had a correlatable id, so accept as before.
 * - Accept when the response carries an id in the waiter's alias set.
 * - Otherwise accept only when this is the sole pending prompt for the session
 *   (the session-scoped fallback is unambiguous); reject when several prompts are
 *   pending to avoid cross-prompt misrouting.
 */
export function shouldSettleFromSessionFallback(params: {
  waiterPromptId: string;
  promptIdAliasSet: ReadonlySet<string>;
  responsePromptIds: readonly string[];
  pendingWaiterCountForSession: number;
}): boolean {
  const {
    waiterPromptId,
    promptIdAliasSet,
    responsePromptIds,
    pendingWaiterCountForSession,
  } = params;

  if (waiterPromptId.startsWith('rui-')) {
    return true;
  }

  if (responsePromptIds.some((id) => promptIdAliasSet.has(id))) {
    return true;
  }

  return pendingWaiterCountForSession <= 1;
}
