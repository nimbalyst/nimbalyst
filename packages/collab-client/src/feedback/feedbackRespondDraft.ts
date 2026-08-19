/**
 * Draft answers for the recipient's view of a feedback request.
 *
 * Two things are decided here rather than in the component, because both are
 * authorization-shaped and neither is visible to a reader of the JSX:
 *
 * - **Which asks a recipient sees** comes from the protocol's assignment model
 *   via `getFeedbackAsksForRecipient`, never from a filter written here. A
 *   surface that reimplements the filter is a surface that can drift out of
 *   agreement with the server about whose question is whose.
 * - **What may be submitted** is checked with `validateFeedbackResponse`, the
 *   same function the server runs. The client check exists to keep the UI
 *   honest, not to replace the server's -- an ask assigned to someone else is
 *   rejected on the wire whatever this file decides.
 *
 * On what this file deliberately cannot know: under `hiddenUntilAnswered` the
 * server strips `recipientUserId` from every response it returns, including the
 * viewer's own. So "have I already answered this ask" is not derivable from the
 * read model, and it is not guessed at here -- prior answers are recognized only
 * when the server attributed them (visibility `open`). A recipient returning to
 * a hidden request sees their asks fresh and re-answering replaces the stored
 * response, which is the protocol's own behaviour.
 */

import type {
  FeedbackAnswer,
  FeedbackAsk,
  FeedbackRequestReadModel,
  FeedbackResponse,
  FeedbackResponseValidationError,
} from '@nimbalyst/collab-protocol';
import type { TeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import {
  getFeedbackTextAnswerMaxLength,
  getFeedbackAsksForRecipient,
  validateFeedbackResponse,
} from '@nimbalyst/collab-protocol';

/** The sentinel `RequestUserInput` already puts in `selectedId` for a write-in. */
export const OTHER_OPTION_ID = '__other__';

export interface FeedbackRespondDraft {
  requestId: string;
  /** Keyed by ask id. An absent key is an unanswered ask. */
  answers: Record<string, FeedbackAnswer>;
}

export type FeedbackRespondBlockedReason =
  | 'notARecipient'
  | 'requestNotOpen'
  | 'incomplete'
  | 'rejected';

export const FEEDBACK_RESPOND_BLOCKED_MESSAGES: Record<
  FeedbackRespondBlockedReason,
  string
> = {
  notARecipient: 'Nothing on this request is assigned to you.',
  requestNotOpen: 'This request is closed and no longer takes answers.',
  incomplete: 'Answer every question before submitting.',
  rejected: 'These answers were rejected before sending.',
};

export type FeedbackRespondSubmitPlan =
  | { kind: 'ready'; responses: FeedbackResponse[] }
  | {
      kind: 'blocked';
      reason: FeedbackRespondBlockedReason;
      errors?: FeedbackResponseValidationError[];
    };

/**
 * The asks this viewer is being asked, in the request's own ask order.
 *
 * A viewer who is not a recipient -- the author reading the same DM, a room
 * member who was never assigned anything -- gets an empty list, which is what
 * collapses the surface to read-only rather than showing a submit button that
 * the server would refuse.
 */
export function feedbackRespondAsks(
  request: FeedbackRequestReadModel,
  teamMemberId: TeamMemberId,
): FeedbackAsk[] {
  if (!teamMemberId) return [];
  return getFeedbackAsksForRecipient(request, teamMemberId);
}

/** Answers the server already attributed to this viewer, keyed by ask id. */
export function attributedAnswersForViewer(
  request: FeedbackRequestReadModel,
  teamMemberId: TeamMemberId,
): Record<string, FeedbackAnswer> {
  const answers: Record<string, FeedbackAnswer> = {};
  if (!teamMemberId) return answers;
  for (const response of request.responses) {
    if (response.recipientUserId !== teamMemberId) continue;
    answers[response.askId] = response.answer;
  }
  return answers;
}

/**
 * A starting answer for one ask, from whatever the ask itself states.
 *
 * `undefined` means "the recipient has to say something": a pick-one with no
 * preselection, a yes/no with no stated default. Pre-filling those would turn
 * an unanswered question into a silent vote for whichever option happened to be
 * first.
 */
export function seedAnswerForAsk(ask: FeedbackAsk): FeedbackAnswer | undefined {
  switch (ask.type) {
    case 'singleSelect':
      return undefined;
    case 'multiSelect':
      return {
        type: 'multiSelect',
        selectedIds: ask.items
          .filter((item) => item.defaultChecked)
          .map((item) => item.id),
      };
    case 'reorder':
      return {
        type: 'reorder',
        orderedIds: ask.items.map((item) => item.id),
        removedIds: [],
      };
    case 'editText':
      return { type: 'editText', text: ask.initialText, edited: false };
    case 'confirm':
      return ask.defaultValue === undefined
        ? undefined
        : { type: 'confirm', value: ask.defaultValue };
    case 'rating':
      return ask.initialValue === undefined
        ? undefined
        : { type: 'rating', value: ask.initialValue };
  }
}

export function initialFeedbackRespondDraft(
  request: FeedbackRequestReadModel,
  teamMemberId: TeamMemberId,
): FeedbackRespondDraft {
  const attributed = attributedAnswersForViewer(request, teamMemberId);
  const answers: Record<string, FeedbackAnswer> = {};
  for (const ask of feedbackRespondAsks(request, teamMemberId)) {
    const seed = attributed[ask.id] ?? seedAnswerForAsk(ask);
    if (seed) answers[ask.id] = seed;
  }
  return { requestId: request.id, answers };
}

export function setFeedbackRespondAnswer(
  draft: FeedbackRespondDraft,
  askId: string,
  answer: FeedbackAnswer,
): FeedbackRespondDraft {
  return { ...draft, answers: { ...draft.answers, [askId]: answer } };
}

/** Whether an answer says enough to send, given the ask's own bounds. */
export function isAnswerComplete(
  ask: FeedbackAsk,
  answer: FeedbackAnswer | undefined,
): boolean {
  if (!answer || answer.type !== ask.type) return false;
  switch (ask.type) {
    case 'singleSelect':
      if (answer.type !== 'singleSelect') return false;
      if (answer.selectedId === OTHER_OPTION_ID) {
        return Boolean(answer.otherText && answer.otherText.trim());
      }
      return ask.options.some((option) => option.id === answer.selectedId);
    case 'multiSelect':
      if (answer.type !== 'multiSelect') return false;
      return (
        answer.selectedIds.length >= (ask.minSelected ?? 0)
        && answer.selectedIds.length <= (ask.maxSelected ?? ask.items.length)
      );
    case 'reorder':
      if (answer.type !== 'reorder') return false;
      return answer.orderedIds.length >= Math.max(ask.minItems ?? 0, 1);
    case 'editText': {
      if (answer.type !== 'editText') return false;
      const length = answer.text.trim().length;
      return length >= (ask.minLength ?? 0)
        && length <= getFeedbackTextAnswerMaxLength(ask.maxLength);
    }
    case 'confirm':
      return answer.type === 'confirm';
    case 'rating':
      return (
        answer.type === 'rating'
        && answer.value >= ask.min
        && answer.value <= ask.max
      );
  }
}

/**
 * Everything that has to hold before answers leave the client, in the order a
 * recipient would want to hear about it.
 *
 * The per-response pass is `validateFeedbackResponse` rather than a local
 * assignment check, so this surface and the server agree by construction about
 * which asks this person is allowed to answer.
 */
export function feedbackRespondSubmitPlan(
  request: FeedbackRequestReadModel,
  teamMemberId: TeamMemberId,
  draft: FeedbackRespondDraft,
  now: number,
): FeedbackRespondSubmitPlan {
  const asks = feedbackRespondAsks(request, teamMemberId);
  if (asks.length === 0) {
    return { kind: 'blocked', reason: 'notARecipient' };
  }
  if (request.lifecycle.status !== 'open') {
    return { kind: 'blocked', reason: 'requestNotOpen' };
  }
  if (!asks.every((ask) => isAnswerComplete(ask, draft.answers[ask.id]))) {
    return { kind: 'blocked', reason: 'incomplete' };
  }

  const responses: FeedbackResponse[] = asks.map((ask) => ({
    // Deterministic, and never sent: the wire carries only the ask id and the
    // answer, and the server stamps identity from the team JWT. This id exists
    // so the shared validator has a complete response to check.
    id: `${request.id}:${ask.id}:${teamMemberId}`,
    requestId: request.id,
    askId: ask.id,
    recipientUserId: teamMemberId,
    answer: draft.answers[ask.id],
    createdAt: now,
    updatedAt: now,
  })) as FeedbackResponse[];

  const errors = responses.flatMap(
    (response) => validateFeedbackResponse(request, response).errors,
  );
  if (errors.length > 0) {
    return { kind: 'blocked', reason: 'rejected', errors };
  }

  return { kind: 'ready', responses };
}

/**
 * A stable stamp of what has been answered, used to tell "these are the answers
 * I already sent" from "I have changed something since".
 */
export function feedbackRespondSignature(
  asks: readonly FeedbackAsk[],
  draft: FeedbackRespondDraft,
): string {
  return JSON.stringify(asks.map((ask) => [ask.id, draft.answers[ask.id] ?? null]));
}
