/**
 * Host-side lifecycle for a provider's AskUserQuestion, extracted from
 * MessageStreamingHandler so the state transitions can be tested without
 * standing up a provider, a window, and the whole send-message pipeline.
 *
 * Three events, three transitions:
 *   pending   -> renderer shows the widget, session advertises a pending prompt
 *   answered  -> widget completes, prompt cleared, session resumes streaming
 *   cancelled -> widget is already terminalized elsewhere; clear the prompt
 *
 * The cancelled path deliberately does NOT touch session activity. It fires on
 * abort and on explicit cancel, and an abort means the turn is ending -- writing
 * `status: 'running'` there would resurrect a session the user just stopped, or
 * one that already completed, and the turn's own terminal path is what owns the
 * final status. Its job is only to retract the pending-prompt advertisement the
 * `pending` event put up, which nothing else did: the host cleared that state on
 * `answered` alone, so a cancelled question left the session claiming to be
 * waiting on a widget that no longer existed. See GitHub #1549.
 */

import type { PromptKind } from '../../tray/fleetSnapshot';

export interface AskUserQuestionEventData {
  questionId: string;
  sessionId: string;
  questions: unknown[];
  timestamp: number;
}

export interface AskUserQuestionAnsweredData extends AskUserQuestionEventData {
  answers: Record<string, string>;
}

export interface AskUserQuestionListenerDeps {
  /** Forward to the renderer that owns this send. */
  sendToRenderer: (channel: string, payload: Record<string, unknown>) => void;
  /** Register this question in the session's open-prompt set. */
  openPrompt: (sessionId: string, promptId: string, kind?: PromptKind) => void;
  /** Settle this question; the session bit clears only if nothing else is open. */
  resolvePrompt: (sessionId: string, promptId: string) => void;
  /** True while the session still has some other prompt awaiting the user. */
  hasOpenPrompts: (sessionId: string) => boolean;
  /** SessionStateManager.updateActivity, narrowed to what these paths set. */
  updateSessionActivity: (update: {
    sessionId: string;
    status: 'waiting_for_input' | 'running';
    isStreaming?: boolean;
  }) => Promise<void>;
  getSessionTitle: (sessionId: string) => Promise<string>;
  /** Raise the "blocked on a question" OS notification. The caller owns the
   *  notification kind and workspace, which are fixed for this path. */
  showBlockedNotification: (sessionId: string, sessionTitle: string) => void;
  /** Stamped onto the renderer payloads so the right window picks them up. */
  workspacePath: string | undefined;
  logError: (message: string, error: unknown) => void;
}

export interface AskUserQuestionListeners {
  onPending: (data: AskUserQuestionEventData) => Promise<void>;
  onAnswered: (data: AskUserQuestionAnsweredData) => void;
  onCancelled: (data: AskUserQuestionEventData) => void;
}

export function createAskUserQuestionListeners(
  deps: AskUserQuestionListenerDeps,
): AskUserQuestionListeners {
  const onPending = async (data: AskUserQuestionEventData): Promise<void> => {
    deps.sendToRenderer('ai:askUserQuestion', { ...data, workspacePath: deps.workspacePath });
    deps.openPrompt(data.sessionId, data.questionId, 'decision');

    // waiting_for_input is what makes every window show the pending indicator.
    deps.updateSessionActivity({
      sessionId: data.sessionId,
      status: 'waiting_for_input',
    }).catch((err) => {
      deps.logError('Failed to update session status to waiting_for_input', err);
    });

    const sessionTitle = await deps.getSessionTitle(data.sessionId);
    deps.showBlockedNotification(data.sessionId, sessionTitle);
  };

  const onAnswered = (data: AskUserQuestionAnsweredData): void => {
    deps.sendToRenderer('ai:askUserQuestionAnswered', { ...data, workspacePath: deps.workspacePath });
    deps.resolvePrompt(data.sessionId, data.questionId);

    // A real answer means the turn is about to stream again -- but only if this
    // was the LAST thing blocking it. With a sibling question or a tool
    // permission still open the session is still waiting for input, and saying
    // "running" would take the indicator down while the user still owes an
    // answer. Refs #1549.
    if (deps.hasOpenPrompts(data.sessionId)) return;
    deps.updateSessionActivity({
      sessionId: data.sessionId,
      status: 'running',
      isStreaming: true,
    }).catch(() => {});
  };

  const onCancelled = (data: AskUserQuestionEventData): void => {
    deps.sendToRenderer('ai:askUserQuestionCancelled', { ...data, workspacePath: deps.workspacePath });
    // Settles only THIS question. The session bit stays up if another prompt is
    // still open -- hard-clearing it here is what stopped the sidebar
    // advertising Q2 when Q1 was cancelled.
    deps.resolvePrompt(data.sessionId, data.questionId);
    // No updateSessionActivity here on purpose -- see the module comment.
  };

  return { onPending, onAnswered, onCancelled };
}
