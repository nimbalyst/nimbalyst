import { AskUserQuestionPrompt } from '../shared/askUserQuestionTypes';

export interface PendingAskUserQuestionEntry {
  resolve: (answers: Record<string, string>) => void;
  reject: (error: Error) => void;
  questions: AskUserQuestionPrompt[];
}

interface HandleAskUserQuestionDeps {
  emit: (event: 'askUserQuestion:pending' | 'askUserQuestion:answered', payload: any) => void;
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
  }

  const answersPromise = new Promise<Record<string, string>>((resolve, reject) => {
    deps.pendingAskUserQuestions.set(questionId, {
      resolve,
      reject,
      questions
    });

    signal.addEventListener('abort', () => {
      deps.pendingAskUserQuestions.delete(questionId);
      reject(new Error('Request aborted'));
    }, { once: true });
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
    const answers = await answersPromise;
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
    deps.onError(error);

    // Log a cancelled tool result so the widget transitions from "pending" to "cancelled".
    // This covers all rejection paths: abort signal, explicit cancel, rejectAllPendingQuestions.
    if (deps.sessionId) {
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

    return {
      behavior: 'deny',
      message: error instanceof Error ? error.message : 'Question cancelled'
    };
  }
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
