// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { pickPendingQuestionAnswer, tryAnswerPendingQuestion } from '../pendingQuestionRouting';

// Upstream #366: a reply typed in the chat box while the session waits on an
// AskUserQuestion must answer that question instead of going to the queue.
// This helper decides when the typed text can be used as the answer.
function question(text: string, multiSelect = false) {
  return {
    question: text,
    header: 'Pick one',
    options: [
      { label: 'Red', description: 'The red one' },
      { label: 'Blue', description: 'The blue one' },
    ],
    multiSelect,
  };
}

function questionPrompt(questions: unknown, promptId = 'q-1') {
  return {
    promptType: 'ask_user_question_request',
    promptId,
    data: { type: 'ask_user_question_request', questionId: promptId, questions },
  };
}

describe('pickPendingQuestionAnswer', () => {
  it('answers a single pending question with the trimmed text', () => {
    const result = pickPendingQuestionAnswer(
      [questionPrompt([question('Which colour?')])],
      '  use the blue one  ',
    );
    expect(result).toEqual({
      questionId: 'q-1',
      answers: { 'Which colour?': 'use the blue one' },
    });
  });

  it('uses the typed text alone even when the question allows several choices', () => {
    const result = pickPendingQuestionAnswer(
      [questionPrompt([question('Which colours?', true)])],
      'use the blue one',
    );
    expect(result).toEqual({
      questionId: 'q-1',
      answers: { 'Which colours?': 'use the blue one' },
    });
  });

  it('returns null for empty or whitespace-only text', () => {
    const prompts = [questionPrompt([question('Which colour?')])];
    expect(pickPendingQuestionAnswer(prompts, '')).toBeNull();
    expect(pickPendingQuestionAnswer(prompts, '   \n\t ')).toBeNull();
  });

  it('returns null when nothing is pending', () => {
    expect(pickPendingQuestionAnswer([], 'use the blue one')).toBeNull();
  });

  it('returns null when one prompt holds several questions', () => {
    const prompts = [questionPrompt([question('Which colour?'), question('Which size?')])];
    expect(pickPendingQuestionAnswer(prompts, 'use the blue one')).toBeNull();
  });

  it('returns null when the only pending prompt is not a question', () => {
    const permission = { promptType: 'permission_request', promptId: 'p-1', data: {} };
    const plan = { promptType: 'exit_plan_mode_request', promptId: 'e-1', data: {} };
    expect(pickPendingQuestionAnswer([permission], 'use the blue one')).toBeNull();
    expect(pickPendingQuestionAnswer([plan], 'use the blue one')).toBeNull();
  });

  it('returns null when another prompt is also pending', () => {
    const question1 = questionPrompt([question('Which colour?')]);
    const permission = { promptType: 'permission_request', promptId: 'p-1', data: {} };
    const secondQuestion = questionPrompt([question('Which size?')], 'q-2');
    expect(pickPendingQuestionAnswer([question1, permission], 'use the blue one')).toBeNull();
    expect(pickPendingQuestionAnswer([question1, secondQuestion], 'use the blue one')).toBeNull();
  });

  it('returns null when the question record has no questions', () => {
    expect(pickPendingQuestionAnswer([questionPrompt([])], 'use the blue one')).toBeNull();
    expect(pickPendingQuestionAnswer([questionPrompt(undefined)], 'use the blue one')).toBeNull();
    expect(
      pickPendingQuestionAnswer(
        [{ promptType: 'ask_user_question_request', promptId: 'q-1', data: undefined }],
        'use the blue one',
      ),
    ).toBeNull();
  });
});

// The chat box only clears the draft when the answer really went through.
// Otherwise the caller queues the text, so the user's reply is never lost.
describe('tryAnswerPendingQuestion', () => {
  const pending = [questionPrompt([question('Which colour?')])];

  it('sends the answer and reports true when the question accepts it', async () => {
    const submit = vi.fn().mockResolvedValue(true);
    await expect(tryAnswerPendingQuestion(pending, ' blue ', false, submit)).resolves.toBe(true);
    expect(submit).toHaveBeenCalledWith('q-1', { 'Which colour?': 'blue' });
  });

  it('reports false when the question refuses the answer or the send throws', async () => {
    await expect(tryAnswerPendingQuestion(pending, 'blue', false, vi.fn().mockResolvedValue(false))).resolves.toBe(false);
    await expect(
      tryAnswerPendingQuestion(pending, 'blue', false, vi.fn().mockRejectedValue(new Error('ipc down'))),
    ).resolves.toBe(false);
  });

  it('does not send a draft with attachments, because the answer carries text only', async () => {
    const submit = vi.fn().mockResolvedValue(true);
    await expect(tryAnswerPendingQuestion(pending, 'blue', true, submit)).resolves.toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });
});
