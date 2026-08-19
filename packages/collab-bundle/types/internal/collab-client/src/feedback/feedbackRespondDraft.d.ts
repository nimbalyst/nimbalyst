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
import type { FeedbackAnswer, FeedbackAsk, FeedbackRequestReadModel, FeedbackResponse, FeedbackResponseValidationError } from '@nimbalyst/collab-protocol';
import type { TeamMemberId } from '../../../runtime/src/auth/jwtScopes';
/** The sentinel `RequestUserInput` already puts in `selectedId` for a write-in. */
export declare const OTHER_OPTION_ID = "__other__";
export interface FeedbackRespondDraft {
    requestId: string;
    /** Keyed by ask id. An absent key is an unanswered ask. */
    answers: Record<string, FeedbackAnswer>;
}
export type FeedbackRespondBlockedReason = 'notARecipient' | 'requestNotOpen' | 'incomplete' | 'rejected';
export declare const FEEDBACK_RESPOND_BLOCKED_MESSAGES: Record<FeedbackRespondBlockedReason, string>;
export type FeedbackRespondSubmitPlan = {
    kind: 'ready';
    responses: FeedbackResponse[];
} | {
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
export declare function feedbackRespondAsks(request: FeedbackRequestReadModel, teamMemberId: TeamMemberId): FeedbackAsk[];
/** Answers the server already attributed to this viewer, keyed by ask id. */
export declare function attributedAnswersForViewer(request: FeedbackRequestReadModel, teamMemberId: TeamMemberId): Record<string, FeedbackAnswer>;
/**
 * A starting answer for one ask, from whatever the ask itself states.
 *
 * `undefined` means "the recipient has to say something": a pick-one with no
 * preselection, a yes/no with no stated default. Pre-filling those would turn
 * an unanswered question into a silent vote for whichever option happened to be
 * first.
 */
export declare function seedAnswerForAsk(ask: FeedbackAsk): FeedbackAnswer | undefined;
export declare function initialFeedbackRespondDraft(request: FeedbackRequestReadModel, teamMemberId: TeamMemberId): FeedbackRespondDraft;
export declare function setFeedbackRespondAnswer(draft: FeedbackRespondDraft, askId: string, answer: FeedbackAnswer): FeedbackRespondDraft;
/** Whether an answer says enough to send, given the ask's own bounds. */
export declare function isAnswerComplete(ask: FeedbackAsk, answer: FeedbackAnswer | undefined): boolean;
/**
 * Everything that has to hold before answers leave the client, in the order a
 * recipient would want to hear about it.
 *
 * The per-response pass is `validateFeedbackResponse` rather than a local
 * assignment check, so this surface and the server agree by construction about
 * which asks this person is allowed to answer.
 */
export declare function feedbackRespondSubmitPlan(request: FeedbackRequestReadModel, teamMemberId: TeamMemberId, draft: FeedbackRespondDraft, now: number): FeedbackRespondSubmitPlan;
/**
 * A stable stamp of what has been answered, used to tell "these are the answers
 * I already sent" from "I have changed something since".
 */
export declare function feedbackRespondSignature(asks: readonly FeedbackAsk[], draft: FeedbackRespondDraft): string;
