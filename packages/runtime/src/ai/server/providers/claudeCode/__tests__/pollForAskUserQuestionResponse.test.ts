import { describe, expect, it, vi } from 'vitest';

import { pollForAskUserQuestionResponse } from '../askUserQuestion';

function makeDeps(record: Record<string, unknown>, waiterKey: string) {
  const resolve = vi.fn();
  const reject = vi.fn();
  const pending = new Map<string, { resolve: typeof resolve; reject: typeof reject }>();
  pending.set(waiterKey, { resolve, reject });

  return {
    resolve,
    reject,
    deps: {
      pendingAskUserQuestions: pending as any,
      listRecentMessages: vi.fn().mockResolvedValue([{ content: JSON.stringify(record) }]),
      logTimeout: vi.fn(),
      logResolved: vi.fn(),
      logCancelled: vi.fn(),
      logError: vi.fn(),
    },
  };
}

describe('pollForAskUserQuestionResponse', () => {
  it('recovers a response whose canonical id differs from the waiter id via waiterIds', async () => {
    const waiterKey = 'call_raw';
    const { resolve, reject, deps } = makeDeps(
      {
        type: 'ask_user_question_response',
        // The persisted record carries the synthetic id the widget submitted,
        // but the SDK waiter is keyed on the raw call id.
        questionId: 'nimtc|call_raw|1779232811883|9',
        waiterIds: ['nimtc|call_raw|1779232811883|9', 'call_raw'],
        answers: { Scope: 'Everything' },
        cancelled: false,
        respondedBy: 'mobile',
      },
      waiterKey,
    );

    await pollForAskUserQuestionResponse(deps, {
      sessionId: 'session-1',
      questionId: waiterKey,
      signal: new AbortController().signal,
    });

    expect(resolve).toHaveBeenCalledWith({ Scope: 'Everything' });
    expect(reject).not.toHaveBeenCalled();
    expect(deps.pendingAskUserQuestions.has(waiterKey)).toBe(false);
  });

  it('still matches legacy records by exact questionId', async () => {
    const waiterKey = 'call_raw';
    const { resolve, deps } = makeDeps(
      {
        type: 'ask_user_question_response',
        questionId: 'call_raw',
        answers: { Scope: 'Everything' },
        cancelled: false,
        respondedBy: 'desktop',
      },
      waiterKey,
    );

    await pollForAskUserQuestionResponse(deps, {
      sessionId: 'session-1',
      questionId: waiterKey,
      signal: new AbortController().signal,
    });

    expect(resolve).toHaveBeenCalledWith({ Scope: 'Everything' });
  });
});
