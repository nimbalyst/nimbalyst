/**
 * #1647: a PromptForUserInput answer or cancel that reaches no live MCP waiter.
 *
 * The form outlives its waiter whenever the call ends first: the app restarted
 * (update install) and took the SDK subprocess with it, or the MCP client
 * abandoned the call, which deliberately leaves the form standing because the
 * user has decided nothing. The form still renders as pending and accepts
 * input. Before this, a submit only persisted a `request_user_input_response`
 * row that nothing reads any more, so the agent never got the answers and the
 * widget's draft was cleared.
 *
 * This is the PromptForUserInput counterpart of the AskUserQuestion fallback in
 * `registerAskUserQuestionAnswerHandler` (#773, #1116): write the terminal
 * tool_result so the form completes durably and a repeat submit is refused,
 * then resume the session with the answers in the message.
 */

import { persistInteractivePromptTerminalResult } from './askUserQuestionFallbackResolution';

export type ResumeSessionWithAnswer = (args: {
  event: Electron.IpcMainInvokeEvent;
  sessionId: string;
  workspacePath: string | undefined;
  message: string;
}) => Promise<unknown>;

let resumeSession: ResumeSessionWithAnswer | null = null;

/** Wired by AIService, which owns the send-message path. */
export function configureRequestUserInputResume(value: ResumeSessionWithAnswer): void {
  resumeSession = value;
}

/**
 * Same payload the live tool result carries, so the agent reads the answers
 * against the field ids of the PromptForUserInput call already in its history.
 */
export function buildRequestUserInputResumeMessage(answers: Record<string, unknown>): string {
  return `[Resuming after the user submitted a PromptForUserInput form]\n\n${JSON.stringify({ answers }, null, 2)}`;
}

export async function settleOrphanedRequestUserInput(args: {
  event: Electron.IpcMainInvokeEvent;
  sessionId: string;
  promptId: string;
  answers: Record<string, unknown>;
  cancelled: boolean;
  respondedBy: 'desktop' | 'mobile';
  session: { provider: string; workspacePath?: string } | null;
}): Promise<void> {
  const { event, sessionId, promptId, answers, cancelled, respondedBy, session } = args;

  // Terminalize before resuming so the resumed turn cannot see an open form.
  await persistInteractivePromptTerminalResult({ sessionId, questionId: promptId, answers, cancelled, respondedBy });

  if (cancelled) return;
  if (!session) {
    console.warn(`[SessionHandlers] Session not found for orphaned PromptForUserInput answer: ${sessionId}`);
    return;
  }
  // As in the AskUserQuestion fallback: the CLI path's send-message handler
  // types into the live CLI composer as if the user wrote it, and nothing there
  // resumes from a stored provider session.
  if (session.provider === 'claude-code-cli') {
    console.warn(`[SessionHandlers] No live waiter for PromptForUserInput on claude-code-cli; not auto-resuming: ${sessionId}`);
    return;
  }
  if (!resumeSession) {
    console.error(`[SessionHandlers] PromptForUserInput resume is not configured; answer for ${promptId} was not delivered`);
    return;
  }

  console.log(`[SessionHandlers] No live waiter for PromptForUserInput, auto-resuming session: ${sessionId}`);
  const resume = resumeSession;
  setImmediate(() => {
    resume({
      event,
      sessionId,
      workspacePath: session.workspacePath,
      message: buildRequestUserInputResumeMessage(answers),
    }).catch((err) => {
      console.error(`[SessionHandlers] Failed to auto-resume session after PromptForUserInput: ${err}`);
    });
  });
}
