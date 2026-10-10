/**
 * What to do with a prompt whose MCP call the client walked away from.
 *
 * Two different things can end a blocking prompt, and they must not be confused:
 *
 * - The **user** answered or cancelled. The prompt is finished; write the
 *   terminal tool_result so the widget renders as answered/cancelled.
 * - The **client** abandoned the call — the harness's idle watchdog aborted it,
 *   or the CLI that asked died. The user has decided nothing. The waiter has to
 *   come down (its listeners, timers and "awaiting input" bit are all stale),
 *   but the QUESTION is still a perfectly good question.
 *
 * Terminalizing on abandonment would break a feature we already ship: answering
 * a question in an old, no-longer-running session persists the answer and
 * resumes the session with it as a new turn (AIService `claude-code:answer-question`,
 * issue #1116 / #773). That fallback only engages when no live waiter is found —
 * so tearing the waiter down is exactly what re-enables it, and writing a
 * "Cancelled" result on top would take the buttons away before the user ever
 * got the chance.
 *
 * Tool permission is the one exception. There is no "resume with the answer"
 * story for an approval — the tool call it guards is already gone — and a
 * stale Allow button that answers nobody is the whole of NIM-2607. It fails
 * closed and terminalizes.
 */

export type InteractivePromptKind =
  | 'ask_user_question'
  | 'request_user_input'
  | 'git_commit_proposal'
  | 'tool_permission';

export type InteractivePromptSettleReason =
  | 'user-responded'
  | 'client-abandoned'
  /**
   * The user started a new turn instead of answering. The question is closed
   * for good: no later answer can resume the session with it.
   */
  | 'superseded';

/**
 * Settle reason carried by a response payload. The supersede path emits
 * `reason: 'superseded'` on the same waiter channels a real answer uses.
 */
export function settleReasonFromResponse(
  response: { reason?: unknown } | null | undefined,
): InteractivePromptSettleReason {
  return response?.reason === 'superseded' ? 'superseded' : 'user-responded';
}

/**
 * Whether this settle should write the prompt's terminal tool_result — i.e.
 * close the widget out — or leave it answerable.
 */
export function shouldTerminalizePrompt(params: {
  kind: InteractivePromptKind;
  reason: InteractivePromptSettleReason;
}): boolean {
  if (params.reason === 'user-responded' || params.reason === 'superseded') return true;
  return params.kind === 'tool_permission';
}
