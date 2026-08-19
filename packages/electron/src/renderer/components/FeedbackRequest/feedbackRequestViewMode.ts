/**
 * Which face of a feedback request a viewer should meet.
 *
 * Kept pure and separate from the surface so the choice is testable without a
 * room: it is the one decision that changes what a click on a request row
 * lands on, and it has to be made from the request the server projected for
 * *this* viewer rather than from who happens to be looking.
 */

import type { FeedbackRequestServiceState } from '../../../shared/feedbackRequest';
import type { TeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import {
  attributedAnswersForViewer,
  feedbackRespondAsks,
} from './feedbackRespondDraft';

export type FeedbackRequestViewMode = 'respond' | 'results';

/**
 * `respond` only while this viewer still owes an answer: they hold at least one
 * assigned ask with no attributed answer and the request still takes answers.
 * Everyone else — the author, a bystander participant, a recipient who is done,
 * anyone once the request closes — gets the tallies.
 *
 * The request is the per-viewer projection, so an answer withheld by
 * `hiddenUntilAnswered` is someone else's and is not in `responses` here; this
 * never mistakes a peer's answer for the viewer's own.
 */
export function feedbackRequestViewMode(
  request: FeedbackRequestServiceState['request'],
  teamMemberId: TeamMemberId | '',
): FeedbackRequestViewMode {
  if (!request || !teamMemberId) return 'results';
  if (request.lifecycle.status !== 'open') return 'results';
  const asks = feedbackRespondAsks(request, teamMemberId);
  if (asks.length === 0) return 'results';
  const answered = attributedAnswersForViewer(request, teamMemberId);
  return asks.some((ask) => answered[ask.id] === undefined)
    ? 'respond'
    : 'results';
}
