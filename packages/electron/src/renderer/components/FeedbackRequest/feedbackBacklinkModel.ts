/**
 * Presentation model for artifact-side feedback backlinks.
 *
 * Kept separate from the components so the ordering and labelling rules -- the
 * parts a reader cannot verify by looking at the screen -- are testable without
 * a DOM. The index entry is deliberately thin (no asks, no responses), so every
 * label here is derived from lifecycle, progress and the frozen subject labels.
 */

import type { FeedbackRequestIndexEntry } from '@nimbalyst/collab-protocol';
import type { TeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';

export type FeedbackBacklinkTone = 'open' | 'answered' | 'closed';

export interface FeedbackBacklinkStatus {
  label: string;
  tone: FeedbackBacklinkTone;
}

/**
 * An open request whose quorum is reached reads as "Answered": the author has
 * what they asked for, and nobody is being chased any more. Only the terminal
 * lifecycle states are shown as closed.
 */
export function feedbackBacklinkStatus(
  entry: Pick<FeedbackRequestIndexEntry, 'lifecycle' | 'progress'>,
): FeedbackBacklinkStatus {
  switch (entry.lifecycle.status) {
    case 'open':
      return entry.progress.quorumReached
        ? { label: 'Answered', tone: 'answered' }
        : { label: 'Open', tone: 'open' };
    case 'closed':
      return { label: 'Closed', tone: 'closed' };
    case 'expired':
      return { label: 'Expired', tone: 'closed' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'closed' };
  }
}

export function feedbackBacklinkProgressLabel(
  entry: Pick<FeedbackRequestIndexEntry, 'progress'>,
): string {
  const { answeredRecipientCount, totalRecipientCount } = entry.progress;
  return `${answeredRecipientCount}/${totalRecipientCount} responded`;
}

/**
 * Who asked, as far as the index can say. The entry carries the author as an
 * actor -- ids, plus a session name for agent authors -- and resolved names
 * only for recipients, so a request from another person shows no name rather
 * than a member id nobody recognizes.
 */
export function feedbackBacklinkAuthorLabel(
  entry: Pick<FeedbackRequestIndexEntry, 'author'>,
  teamMemberId: TeamMemberId | '',
): string | null {
  if (teamMemberId && entry.author.onBehalfOfUserId === teamMemberId) {
    return 'Asked by you';
  }
  if (entry.author.kind === 'agent' && entry.author.sessionName) {
    return `Asked by ${entry.author.sessionName}`;
  }
  return null;
}

/** Most recently active first, so a live request never sits under a stale one. */
export function sortFeedbackBacklinks<T extends Pick<FeedbackRequestIndexEntry, 'updatedAt'>>(
  entries: readonly T[],
): T[] {
  return [...entries].sort((left, right) => right.updatedAt - left.updatedAt);
}
