/**
 * Upstream #366 -- answering a pending AskUserQuestion from the chat box.
 *
 * While a session waits on an AskUserQuestion, the session counts as "loading",
 * so a reply typed in the chat box used to go to the queue. The question never
 * resolved and the session spun until the user aborted.
 *
 * This helper decides whether the typed text can answer the waiting question.
 * It is a plain function so it can be unit-tested without the full
 * SessionTranscript component.
 */

/**
 * The parts of a pending prompt this helper reads. A structural type, so the
 * caller can pass the real `PendingPrompt` list without this file importing
 * any Jotai atoms.
 */
export interface PendingPromptLike {
  promptType: string;
  promptId: string;
  data?: unknown;
}

export interface PendingQuestionAnswer {
  questionId: string;
  answers: Record<string, string>;
}

/**
 * Decide whether the typed text should answer a waiting question.
 *
 * Returns the answer only when it is clear which question the text is for:
 *  - the text is not empty,
 *  - exactly one prompt is pending, and it is a question,
 *  - that question record holds exactly one question.
 * In every other case it returns null and the caller keeps its old behaviour
 * (queue the message). One chat message cannot answer several questions, and
 * a permission or plan prompt needs its own button, not free text.
 *
 * A multi-choice question also gets the typed text alone: it counts as an
 * "Other" answer, the same as typing in the widget's own text box.
 */
export function pickPendingQuestionAnswer(
  pendingPrompts: readonly PendingPromptLike[],
  text: string,
): PendingQuestionAnswer | null {
  const answer = text.trim();
  if (!answer) return null;
  if (pendingPrompts.length !== 1) return null;

  const prompt = pendingPrompts[0];
  if (prompt.promptType !== 'ask_user_question_request') return null;

  const questions = (prompt.data as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(questions) || questions.length !== 1) return null;

  const questionText = (questions[0] as { question?: unknown } | null | undefined)?.question;
  if (typeof questionText !== 'string' || !questionText) return null;

  return { questionId: prompt.promptId, answers: { [questionText]: answer } };
}

/**
 * Try to send the typed text as the answer to the waiting question.
 *
 * Returns true only when the answer went through, so the caller can clear the
 * draft. Returns false when the text cannot answer the question, when the
 * draft has attachments (an answer carries text only), when the question
 * refuses the answer (for example it was already answered), or when the send
 * throws. On false the caller queues the text as before, so the reply is never
 * lost.
 *
 * `submit` resolves to true when the main process accepted the answer.
 */
export async function tryAnswerPendingQuestion(
  pendingPrompts: readonly PendingPromptLike[],
  text: string,
  hasAttachments: boolean,
  submit: (questionId: string, answers: Record<string, string>) => Promise<boolean>,
): Promise<boolean> {
  if (hasAttachments) return false;
  const answer = pickPendingQuestionAnswer(pendingPrompts, text);
  if (!answer) return false;
  try {
    return await submit(answer.questionId, answer.answers);
  } catch (error) {
    console.error('[pendingQuestionRouting] Failed to answer pending question:', error);
    return false;
  }
}
