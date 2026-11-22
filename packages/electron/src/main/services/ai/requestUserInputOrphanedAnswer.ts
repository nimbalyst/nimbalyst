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

import { createHash } from 'node:crypto';
import { persistInteractivePromptTerminalResult } from './askUserQuestionFallbackResolution';
import { hasLiveInteractivePrompt } from '../../mcp/tools/interactivePromptLiveness';
import { getQueuedPromptsStore } from '../RepositoryManager';

export type ResumeSessionWithAnswer = (args: {
  event: Electron.IpcMainInvokeEvent;
  sessionId: string;
  workspacePath: string | undefined;
  message: string;
}) => Promise<unknown>;

let resumeSession: ResumeSessionWithAnswer | null = null;

/** Wired by AIService, which owns the send-message path. */
export function configureRequestUserInputResume(
  value: ResumeSessionWithAnswer,
  publish?: (sessionId: string) => Promise<void>,
): void {
  resumeSession = value;
  publishQueue = publish;
}

/**
 * Same payload the live tool result carries, so the agent reads the answers
 * against the field ids of the PromptForUserInput call already in its history.
 */
/**
 * NIM-7649: an answer to an older card while another prompt blocks the turn.
 * Resuming now would replace that turn (sendMessage aborts the running
 * request), so the answer goes through the prompt queue and is sent when the
 * turn ends. The id is derived from the card, so a repeat cannot queue it twice.
 */
export async function queueAnswerUntilTurnEnds(args: {
  sessionId: string;
  promptId: string;
  message: string;
  publish?: (sessionId: string) => Promise<void>;
}): Promise<void> {
  const { sessionId, promptId, message, publish } = args;
  const id = `answer-${createHash('sha256').update(JSON.stringify([sessionId, promptId])).digest('hex')}`;
  const queue = getQueuedPromptsStore();
  if (!(await queue.get(id))) {
    // Not a human turn: it must not supersede other open questions.
    await queue.create({ id, sessionId, prompt: message, documentContext: { promptOrigin: 'interactive-question' } });
  }
  await publish?.(sessionId);
}

let publishQueue: ((sessionId: string) => Promise<void>) | undefined;

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
  // Another prompt is blocking the turn right now (the answer was for an older
  // card). Resuming would abort that turn, since sendMessage replaces the
  // running request; the answer is queued for when it ends (NIM-7649).
  if (hasLiveInteractivePrompt(sessionId)) {
    console.warn(`[SessionHandlers] PromptForUserInput ${promptId} has no live waiter but another prompt is live; queuing the answer: ${sessionId}`);
    await queueAnswerUntilTurnEnds({ sessionId, promptId, message: buildRequestUserInputResumeMessage(answers), publish: publishQueue })
      .catch((err) => console.error(`[SessionHandlers] Failed to queue the PromptForUserInput answer for ${promptId}: ${err}`));
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
