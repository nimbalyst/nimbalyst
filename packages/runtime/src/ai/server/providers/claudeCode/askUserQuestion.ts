import { AskUserQuestionPrompt } from '../shared/askUserQuestionTypes';

export interface PendingAskUserQuestionEntry {
  resolve: (answers: Record<string, string>) => void;
  reject: (error: Error) => void;
  questions: AskUserQuestionPrompt[];
}

interface HandleAskUserQuestionDeps {
  emit: (
    event: 'askUserQuestion:pending' | 'askUserQuestion:answered' | 'askUserQuestion:cancelled',
    payload: any,
  ) => void;
  logAgentMessage: (sessionId: string, content: string) => Promise<void>;
  onError: (error: unknown) => void;
  pendingAskUserQuestions: Map<string, PendingAskUserQuestionEntry>;
  pollForResponse: (sessionId: string, questionId: string, signal: AbortSignal) => Promise<void>;
  sessionId: string | undefined;
}

interface HandleAskUserQuestionParams {
  input: any;
  signal: AbortSignal;
  toolUseID?: string;
}

export async function handleAskUserQuestionTool(
  deps: HandleAskUserQuestionDeps,
  params: HandleAskUserQuestionParams
): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: any; message?: string }> {
  const { input, signal, toolUseID } = params;
  const { sessionId } = deps;
  const questions = input?.questions || [];
  if (questions.length === 0) {
    return {
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: {}
      }
    };
  }

  const questionId = toolUseID || `ask-${sessionId || 'unknown'}-${Date.now()}`;

  // `addEventListener('abort', ...)` does NOT fire on a signal that is already
  // aborted, so a question raised against a torn-down turn used to register a
  // waiter nothing could ever settle: the tool call hung and the session sat on
  // "waiting for your input" with no widget anyone could answer. Check the
  // signal explicitly at every point where we are about to commit to waiting.
  // See #1549.
  if (signal.aborted) {
    return { behavior: 'deny', message: 'Request aborted' };
  }

  if (sessionId) {
    await deps.logAgentMessage(
      sessionId,
      JSON.stringify({
        type: 'nimbalyst_tool_use',
        id: questionId,
        name: 'AskUserQuestion',
        input: { questions }
      })
    );

    // The abort can land during that persistence await. The tool_use is in the
    // transcript now, so close it out rather than leaving a question widget
    // rendered forever in "pending".
    if (signal.aborted) {
      logCancelledToolResult(deps, questionId);
      return { behavior: 'deny', message: 'Request aborted' };
    }
  }

  let onAbort: (() => void) | undefined;
  const answersPromise = new Promise<Record<string, string>>((resolve, reject) => {
    deps.pendingAskUserQuestions.set(questionId, {
      resolve,
      reject,
      questions
    });

    onAbort = () => {
      deps.pendingAskUserQuestions.delete(questionId);
      reject(new Error('Request aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  if (sessionId) {
    deps.pollForResponse(sessionId, questionId, signal).catch(() => {
      // Polling errors are non-fatal because IPC path may still resolve.
    });
  }

  deps.emit('askUserQuestion:pending', {
    questionId,
    sessionId,
    questions,
    timestamp: Date.now()
  });

  try {
    // Only a correlated host response settles this waiter: the IPC answer path
    // and the transcript poller both look the questionId up in this map before
    // resolving, so there is no route by which an unmatched SDK-side completion
    // becomes an `answers` payload here.
    const answers = await answersPromise;
    // Both resolvers delete their own entry; deleting again is how a resolve
    // that raced the delete avoids leaving a settled waiter in the map.
    deps.pendingAskUserQuestions.delete(questionId);
    deps.emit('askUserQuestion:answered', {
      questionId,
      sessionId,
      questions,
      answers,
      timestamp: Date.now()
    });

    return {
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers
      }
    };
  } catch (error) {
    deps.pendingAskUserQuestions.delete(questionId);
    deps.onError(error);

    // Log a cancelled tool result so the widget transitions from "pending" to "cancelled".
    // This covers all rejection paths: abort signal, explicit cancel, rejectAllPendingQuestions.
    logCancelledToolResult(deps, questionId);

    // The host cleared its pending-prompt state only on
    // `askUserQuestion:answered`, so a cancelled or aborted question left the
    // session stuck advertising a question that no longer exists. #1549.
    deps.emit('askUserQuestion:cancelled', {
      questionId,
      sessionId,
      questions,
      timestamp: Date.now()
    });

    return {
      behavior: 'deny',
      message: error instanceof Error ? error.message : 'Question cancelled'
    };
  } finally {
    // The signal outlives this call (it belongs to the turn), so a listener
    // left behind holds the closure -- and every question asked in a turn --
    // until the turn's controller is collected.
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** Close out the transcript tool_use so its widget leaves the "pending" state. */
function logCancelledToolResult(
  deps: Pick<HandleAskUserQuestionDeps, 'sessionId' | 'logAgentMessage'>,
  questionId: string,
): void {
  if (!deps.sessionId) return;
  deps.logAgentMessage(
    deps.sessionId,
    JSON.stringify({
      type: 'nimbalyst_tool_result',
      tool_use_id: questionId,
      result: JSON.stringify({ cancelled: true, respondedAt: Date.now() }),
      is_error: true
    })
  ).catch(() => {});
}

interface PollForAskUserQuestionResponseDeps {
  pendingAskUserQuestions: Map<string, PendingAskUserQuestionEntry>;
  listRecentMessages: (sessionId: string, limit: number) => Promise<Array<{ content: string }>>;
  logTimeout: (questionId: string) => void;
  logResolved: (questionId: string, answersCount: number, respondedBy: unknown) => void;
  logCancelled: (questionId: string, respondedBy: unknown) => void;
  logError: (error: unknown) => void;
}

interface PollForAskUserQuestionResponseParams {
  sessionId: string;
  questionId: string;
  signal: AbortSignal;
}

export async function pollForAskUserQuestionResponse(
  deps: PollForAskUserQuestionResponseDeps,
  params: PollForAskUserQuestionResponseParams
): Promise<void> {
  const pollInterval = 500;
  const maxPollTime = 10 * 60 * 1000;
  const startTime = Date.now();
  const { sessionId, questionId, signal } = params;

  while (!signal.aborted && Date.now() - startTime < maxPollTime) {
    if (!deps.pendingAskUserQuestions.has(questionId)) {
      return;
    }

    try {
      const messages = await deps.listRecentMessages(sessionId, 50);

      for (const msg of messages) {
        try {
          const content = JSON.parse(msg.content);
          // Alias-aware match: the mobile/voice writer persists the full alias
          // list (Codex synthetic -> raw) as `waiterIds`, plus `rawQuestionId`.
          // Fall back to the exact `questionId` match for older records.
          const idMatches =
            content.questionId === questionId ||
            content.rawQuestionId === questionId ||
            (Array.isArray(content.waiterIds) && content.waiterIds.includes(questionId));
          if (content.type === 'ask_user_question_response' && idMatches) {
            const pending = deps.pendingAskUserQuestions.get(questionId);
            if (pending) {
              if (content.cancelled) {
                pending.reject(new Error('User cancelled the question'));
                deps.pendingAskUserQuestions.delete(questionId);
                deps.logCancelled(questionId, content.respondedBy);
              } else {
                const answers = content.answers as Record<string, string>;
                pending.resolve(answers);
                deps.pendingAskUserQuestions.delete(questionId);
                deps.logResolved(questionId, Object.keys(answers).length, content.respondedBy);
              }
            }
            return;
          }
        } catch {
          // Not valid JSON, skip.
        }
      }
    } catch (error) {
      deps.logError(error);
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  deps.logTimeout(questionId);
}
