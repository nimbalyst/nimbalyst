/**
 * Terminal transcript state for AskUserQuestion answers/cancels that reach NO
 * live handler (issue #1116, and the repeat-resume loop in issue #773).
 *
 * The healthy paths all write a `nimbalyst_tool_result` for the question's
 * tool_use_id, which is what flips the widget out of its pending state:
 *   - in-process provider  -> ClaudeCodeProvider.resolveAskUserQuestion
 *   - MCP waiter (CLI)     -> interactiveToolHandlers handleAskUserQuestion settle
 *   - abort/cancel         -> handleAskUserQuestionTool's catch block
 *
 * The fallback path did not. When the provider instance and every MCP waiter are
 * gone (app restarted, turn died), `claude-code:answer-question` persisted only
 * an `ask_user_question_response` row -- which no transcript parser projects --
 * and auto-resumed the session. So the tool call stayed `pending` forever:
 * the widget only *looked* answered via component-local `hasResponded` state,
 * and any remount (session switch, mode switch) brought the same question back.
 * Clicking it again just triggered another auto-resume, which is the repeated
 * "[Resuming after answering a question]" in #773.
 *
 * These helpers close that gap: write the same terminal tool_result the live
 * paths would have written, and refuse a second answer for a question this
 * process has already terminalized.
 */

import { persistInteractivePromptToolResult } from '../../mcp/tools/interactivePromptTranscript';

/**
 * Question ids this process has already terminalized via the fallback path.
 *
 * In-memory is sufficient: the durable tool_result written alongside it makes
 * the widget render as completed, so a re-submit can only come from a client
 * that is still holding a stale pending widget in THIS process's lifetime.
 * A restart drops the set, but a restart also reloads the transcript -- which
 * now carries the terminal result.
 */
const terminalizedQuestionIdsBySession = new Map<string, Set<string>>();

/** True when this process already wrote a terminal result for the question. */
export function hasTerminalizedAskUserQuestion(sessionId: string, questionId: string): boolean {
  return terminalizedQuestionIdsBySession.get(sessionId)?.has(questionId) === true;
}

/**
 * Record a question whose terminal row a live waiter wrote itself, so the
 * no-live-handler answer path refuses a late click on it too.
 */
export function markInteractivePromptTerminalized(sessionId: string, questionId: string): void {
  let ids = terminalizedQuestionIdsBySession.get(sessionId);
  if (!ids) {
    ids = new Set<string>();
    terminalizedQuestionIdsBySession.set(sessionId, ids);
  }
  ids.add(questionId);
}

/** Drop a session's terminalized ids (session deleted / cleaned up). */
export function clearTerminalizedAskUserQuestions(sessionId: string): void {
  terminalizedQuestionIdsBySession.delete(sessionId);
}

/**
 * Persist the terminal `nimbalyst_tool_result` for a question prompt
 * (AskUserQuestion, PromptForUserInput) that no live handler picked up, so the
 * widget completes durably instead of resurrecting on the next remount.
 *
 * The id is recorded synchronously, before the write, so a caller that settles
 * a live waiter can tell straight after the emit whether the waiter wrote the
 * row itself.
 */
export async function persistInteractivePromptTerminalResult(args: {
  sessionId: string;
  questionId: string;
  answers: Record<string, unknown>;
  cancelled: boolean;
  respondedBy?: 'desktop' | 'mobile';
  /** Why a cancelled prompt closed; `superseded` renders as "Question Skipped". */
  reason?: 'superseded';
  /** Raw-log source; defaults to the Claude row the question paths share. */
  source?: string;
}): Promise<void> {
  const { sessionId, questionId, answers, cancelled, reason } = args;
  const respondedBy = args.respondedBy ?? 'desktop';

  markInteractivePromptTerminalized(sessionId, questionId);

  await persistInteractivePromptToolResult({
    sessionId,
    toolUseId: questionId,
    result: {
      answers: cancelled ? {} : answers,
      cancelled,
      ...(reason ? { reason } : {}),
      respondedBy,
      respondedAt: Date.now(),
    },
    isError: cancelled,
    ...(args.source ? { source: args.source } : {}),
  });
}
