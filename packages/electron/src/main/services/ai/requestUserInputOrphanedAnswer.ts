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
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { persistInteractivePromptTerminalResult } from './askUserQuestionFallbackResolution';
import { isLeadTurnPending } from './drainFollowUp';
import { hasLiveInteractivePrompt } from '../../mcp/tools/interactivePromptLiveness';
import { getQueuedPromptsStore } from '../RepositoryManager';
import type { QueuedPrompt } from '../PGLiteQueuedPromptsStore';

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
  drive?: (sessionId: string, workspacePath: string) => Promise<unknown>,
): void {
  resumeSession = value;
  publishQueue = publish;
  driveQueue = drive;
}

/**
 * True when resuming the session now would replace a turn, because sendMessage
 * aborts the running request: another prompt is blocking the turn, the turn
 * is running or streaming, or the provider has emitted a wake for a
 * turn it is about to start. A replaced Claude Code turn is left unanswered in
 * the CLI transcript, and the resumed CLI fills it with a synthetic
 * "No response requested." reply that the agent then reads as its own.
 */
export function shouldQueueAnswerUntilTurnEnds(sessionId: string): boolean {
  if (hasLiveInteractivePrompt(sessionId)) return true;
  const live = getSessionStateManager().getSessionState(sessionId);
  if (live && (live.status === 'running' || live.isStreaming)) return true;
  return isLeadTurnPending(sessionId);
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
  /**
   * Asks the queue driver to look at the row. The turn's own end dispatches
   * the queue, but it may have ended before the row existed; a drive while the
   * turn still runs just waits for it to go idle.
   */
  drive?: () => Promise<unknown>;
}): Promise<void> {
  const { sessionId, promptId, message, publish, drive } = args;
  const id = `${ANSWER_ID_PREFIX}${createHash('sha256').update(JSON.stringify([sessionId, promptId])).digest('hex')}`;
  const queue = getQueuedPromptsStore();
  if (!(await queue.get(id))) {
    // Not a human turn: it must not supersede other open questions.
    await queue.create({ id, sessionId, prompt: message, documentContext: { promptOrigin: 'interactive-question' } });
  }
  await publish?.(sessionId);
  await drive?.();
}

let publishQueue: ((sessionId: string) => Promise<void>) | undefined;
let driveQueue: ((sessionId: string, workspacePath: string) => Promise<unknown>) | undefined;

/** Queue rows created by queueAnswerUntilTurnEnds, and only those. */
const ANSWER_ID_PREFIX = 'answer-';
const RESUME_HEADER = /^\[Resuming after [^\]\n]*\]\n+/;
export const LATE_ANSWER_PREAMBLE =
  "[The user answered one of your earlier questions while you were working. The call that asked it had already ended, so the answer arrives as this message rather than as that call's result.]";

/**
 * Claims the answers queued for a running Claude Code turn so the runtime's
 * late-answer hook can hand them to the turn at its next tool boundary. The
 * claim keeps the turn-end dispatch from sending them a second time, and an
 * answer the dispatch already took is skipped. `settle(true)` completes them;
 * `settle(false)` puts them back in the queue for the turn end.
 */
export async function takeLateAnswersForRunningTurn(
  sessionId: string,
  notifyClaimed?: (promptId: string) => void,
): Promise<{ text: string; settle(delivered: boolean): Promise<void> } | null> {
  const queue = getQueuedPromptsStore();
  const claimed: QueuedPrompt[] = [];
  for (const row of await queue.listPending(sessionId)) {
    if (!row.id.startsWith(ANSWER_ID_PREFIX)) continue;
    const taken = await queue.claim(row.id);
    if (taken) claimed.push(taken);
  }
  if (claimed.length === 0) return null;

  return {
    text: [LATE_ANSWER_PREAMBLE, ...claimed.map((row) => row.prompt.replace(RESUME_HEADER, ''))].join('\n\n'),
    settle: async (delivered) => {
      for (const row of claimed) {
        try {
          if (delivered) {
            await queue.complete(row.id);
            notifyClaimed?.(row.id);
          } else {
            // Same id, so a repeat answer still cannot queue it twice.
            await queue.delete(row.id);
            await queue.create({ id: row.id, sessionId, prompt: row.prompt, documentContext: row.documentContext });
          }
        } catch (err) {
          console.error(`[SessionHandlers] Failed to settle queued answer ${row.id} (delivered=${delivered}): ${err}`);
        }
      }
      console.log(`[SessionHandlers] ${claimed.length} queued answer(s) ${delivered ? 'handed to the running turn' : 'returned to the queue'}: ${sessionId}`);
      await publishQueue?.(sessionId).catch((err) => console.error(`[SessionHandlers] Failed to publish the queue after a late answer: ${err}`));
    },
  };
}

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
  // A turn is running or blocked on another prompt (the answer was for an
  // older card). Resuming would abort that turn, since sendMessage replaces
  // the running request; the answer is queued for when it ends (NIM-7649).
  if (shouldQueueAnswerUntilTurnEnds(sessionId)) {
    console.warn(`[SessionHandlers] PromptForUserInput ${promptId} has no live waiter but the turn is still running; queuing the answer: ${sessionId}`);
    const { workspacePath } = session;
    const drive = driveQueue;
    await queueAnswerUntilTurnEnds({
      sessionId,
      promptId,
      message: buildRequestUserInputResumeMessage(answers),
      publish: publishQueue,
      drive: drive && workspacePath ? () => drive(sessionId, workspacePath) : undefined,
    }).catch((err) => console.error(`[SessionHandlers] Failed to queue the PromptForUserInput answer for ${promptId}: ${err}`));
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
