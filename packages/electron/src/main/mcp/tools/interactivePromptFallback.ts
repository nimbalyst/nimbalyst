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

export function getRequestUserInputResponseChannel(
  sessionId: string,
  promptId: string,
): string {
  return `request-user-input-response:${sessionId || "unknown"}:${promptId}`;
}

export function getRequestUserInputFallbackResponseChannel(
  sessionId: string,
): string {
  return `request-user-input-response:${sessionId || "unknown"}:__fallback__`;
}

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
 * Claude Code passes every MCP call its transcript tool_use id in
 * `_meta['claudecode/toolUseId']`, so a waiter holding a `toolu_` id listens on
 * exactly the channel of the card it belongs to. The NIM-1981 relaxation exists
 * for waiters whose id does not line up with their card: Codex (a resolved but
 * wrong `exec-` id), clients without `_meta` (the JSON-RPC request id, while
 * OpenCode cards carry `toolu_` ids) and synthetic `rui-` / `ask-` ids. A
 * Claude Code waiter never needs it.
 */
export function isClaudeCodeToolUseId(id: string): boolean {
  return id.startsWith("toolu_");
}

/**
 * True when a session-fallback answer names a card other than this waiter's.
 * An answer with no ids cannot name another card and is left to the caller.
 */
export function fallbackAnswerNamesAnotherCard(params: {
  waiterPromptId: string;
  promptIdAliasSet: ReadonlySet<string>;
  responsePromptIds: readonly string[];
}): boolean {
  const { waiterPromptId, promptIdAliasSet, responsePromptIds } = params;
  return isClaudeCodeToolUseId(waiterPromptId)
    && responsePromptIds.length > 0
    && !responsePromptIds.some((id) => promptIdAliasSet.has(id));
}

/**
 * Whether an answer whose card has no waiter on its own channel may go down the
 * session fallback. A Claude Code card's waiter is always on its own channel,
 * so with none there the card has no live waiter, and any fallback listener is
 * a different question (session 723ddabd). The caller then closes the card
 * itself. Other providers keep the fallback (see `isClaudeCodeToolUseId`).
 */
export function sessionFallbackMayCarryAnswer(
  provider: string | null | undefined,
  cardId: string,
): boolean {
  if (provider !== "claude-code" && provider !== "claude-code-cli") return true;
  return !isClaudeCodeToolUseId(cardId);
}

/**
 * Decide whether a session-scoped fallback response should settle the waiter.
 *
 * - A synthetic (`rui-`) waiter never had a correlatable id, so accept as before.
 * - Accept when the response carries an id in the waiter's alias set.
 * - Reject an answer naming another card when the waiter holds a Claude Code
 *   tool_use id (see `fallbackAnswerNamesAnotherCard`).
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

  if (fallbackAnswerNamesAnotherCard({ waiterPromptId, promptIdAliasSet, responsePromptIds })) {
    return false;
  }

  return pendingWaiterCountForSession <= 1;
}
