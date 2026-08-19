/**
 * Pure view-model logic for the shared-area feedback list.
 *
 * Everything the list decides — which filter admits a request, what a row is
 * allowed to say about it, and what the filter counts are — lives here so it is
 * testable without mounting the surface or opening a request room.
 *
 * The index entry is deliberately thin: it carries no asks and no responses, so
 * a few things this surface would like to know are not in it. Where that bites
 * is `needsViewerResponse`, and the approximation it is forced into is spelled
 * out on that function rather than hidden behind a confident name.
 */

import type {
  FeedbackArtifact,
  FeedbackRequestIndexEntry,
} from '@nimbalyst/collab-protocol';

/**
 * Relative age, in the shared area's own voice ("2h ago"), and taking `now`
 * rather than reading the clock: every label on this surface is derived in one
 * pass from a frozen `now`, so a list cannot show two different ages for the
 * same instant, and the model stays testable.
 */
export function formatFeedbackAge(timestamp: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (days < 365) return `${weeks}w ago`;
  return new Date(timestamp).toLocaleDateString();
}

export type FeedbackListFilterId =
  | 'needsMyResponse'
  | 'sentByMe'
  | 'open'
  | 'answered'
  | 'closed'
  | 'all';

export interface FeedbackListFilter {
  id: FeedbackListFilterId;
  label: string;
  /** Filters after this one are a lifecycle group; the bar draws a divider. */
  startsGroup?: boolean;
}

/** Participation first, then lifecycle, matching the approved surface. */
export const FEEDBACK_LIST_FILTERS: readonly FeedbackListFilter[] = [
  { id: 'needsMyResponse', label: 'Needs my response' },
  { id: 'sentByMe', label: 'Sent by me' },
  { id: 'open', label: 'Open', startsGroup: true },
  { id: 'answered', label: 'Answered' },
  { id: 'closed', label: 'Closed' },
  { id: 'all', label: 'All' },
];

export type FeedbackListStatus =
  | 'open'
  | 'answered'
  | 'closed'
  | 'expired'
  | 'cancelled';

export interface FeedbackListSubjectView {
  key: string;
  label: string;
  icon: string;
}

export interface FeedbackListRowView {
  id: string;
  title: string;
  authorLabel: string;
  status: FeedbackListStatus;
  statusLabel: string;
  progressLabel: string;
  /** True while nobody has answered yet; the row shows a waiting glyph. */
  awaitingFirstResponse: boolean;
  timeLabel: string;
  needsViewerResponse: boolean;
  /** Terminal requests are still readable, just quieter in the list. */
  dimmed: boolean;
  /** Empty for an isolated question, which is a first-class shape here. */
  subjects: FeedbackListSubjectView[];
}

const STATUS_LABELS: Record<FeedbackListStatus, string> = {
  open: 'Open',
  answered: 'Answered',
  closed: 'Closed',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/**
 * Whether the viewer is one of the people being asked.
 *
 * The author is not implicitly a recipient — but an author who put themselves
 * on the recipient list is one, and owes an answer like anybody else.
 */
export function isViewerRecipient(
  entry: FeedbackRequestIndexEntry,
  viewerUserId: string,
): boolean {
  if (!viewerUserId) return false;
  return entry.recipients.some((recipient) => recipient.userId === viewerUserId);
}

/**
 * Whether the viewer sent it. An agent request carries the session as `userId`
 * and the human it acted for as `onBehalfOfUserId`, so a request an agent sent
 * for you is yours.
 */
export function isViewerAuthor(
  entry: FeedbackRequestIndexEntry,
  viewerUserId: string,
): boolean {
  if (!viewerUserId) return false;
  return entry.author.onBehalfOfUserId === viewerUserId
    || entry.author.userId === viewerUserId;
}

/**
 * Whether this request may still be waiting on the viewer.
 *
 * **This is a best-effort filter, and it is the one place on this surface that
 * cannot be exact.** The index carries no asks and no responses, so it cannot
 * say whether *this* viewer answered — only how many recipients did. What it
 * supports precisely is the negative: once every recipient has answered, a
 * recipient viewer is provably done. Below that, a recipient of an open request
 * is admitted, which can include someone who already answered while a peer has
 * not. Opening the row resolves it exactly — the request room projects the
 * viewer's own answers, and the respond/results choice is made from those.
 *
 * Widening the index to make this exact would put per-viewer response state in
 * an enumeration projection, which the design deliberately kept out of it.
 */
export function needsViewerResponse(
  entry: FeedbackRequestIndexEntry,
  viewerUserId: string,
): boolean {
  if (entry.lifecycle.status !== 'open') return false;
  if (!isViewerRecipient(entry, viewerUserId)) return false;
  const { answeredRecipientCount, totalRecipientCount } = entry.progress;
  if (totalRecipientCount > 0 && answeredRecipientCount >= totalRecipientCount) {
    return false;
  }
  return true;
}

/**
 * The lifecycle a row shows.
 *
 * `answered` is a presentation state on top of an open request — the asking is
 * done but nobody has closed it — and it is reached either by everyone
 * answering or by the request's own quorum being met. Quorum is the protocol's
 * definition of "enough", so a request that reached it reads as answered even
 * with recipients still outstanding.
 */
export function feedbackListStatus(
  entry: FeedbackRequestIndexEntry,
): FeedbackListStatus {
  if (entry.lifecycle.status === 'expired') return 'expired';
  if (entry.lifecycle.status === 'cancelled') return 'cancelled';
  if (entry.lifecycle.status === 'closed') return 'closed';
  const { answeredRecipientCount, totalRecipientCount, quorumReached } = entry.progress;
  if (quorumReached) return 'answered';
  if (totalRecipientCount > 0 && answeredRecipientCount >= totalRecipientCount) {
    return 'answered';
  }
  return 'open';
}

/** Terminal lifecycles all live under the `closed` filter. */
export function isTerminalStatus(status: FeedbackListStatus): boolean {
  return status === 'closed' || status === 'expired' || status === 'cancelled';
}

export function matchesFeedbackFilter(
  entry: FeedbackRequestIndexEntry,
  filter: FeedbackListFilterId,
  viewerUserId: string,
): boolean {
  const status = feedbackListStatus(entry);
  switch (filter) {
    case 'all':
      return true;
    case 'needsMyResponse':
      return needsViewerResponse(entry, viewerUserId);
    case 'sentByMe':
      return isViewerAuthor(entry, viewerUserId);
    case 'open':
      return status === 'open';
    case 'answered':
      return status === 'answered';
    case 'closed':
      return isTerminalStatus(status);
    default:
      return true;
  }
}

function searchHaystack(entry: FeedbackRequestIndexEntry): string {
  return [
    entry.title,
    ...entry.recipients.map((recipient) => recipient.name),
    ...entry.subjects.map((subject) => subject.label),
  ].join(' ').toLowerCase();
}

export function matchesFeedbackQuery(
  entry: FeedbackRequestIndexEntry,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return searchHaystack(entry).includes(needle);
}

export interface SelectFeedbackRowsInput {
  entries: readonly FeedbackRequestIndexEntry[];
  filter: FeedbackListFilterId;
  query: string;
  viewerUserId: string;
}

export interface SelectedFeedbackRows {
  entries: FeedbackRequestIndexEntry[];
  counts: Record<FeedbackListFilterId, number>;
}

/**
 * The rows one filter admits, plus every filter's count.
 *
 * Counts ignore the search box on purpose: the chips describe the inbox of
 * requests, not the search result, so typing does not make the badges collapse
 * around what is on screen.
 */
export function selectFeedbackRows(
  input: SelectFeedbackRowsInput,
): SelectedFeedbackRows {
  const counts: Record<FeedbackListFilterId, number> = {
    needsMyResponse: 0,
    sentByMe: 0,
    open: 0,
    answered: 0,
    closed: 0,
    all: 0,
  };
  const entries: FeedbackRequestIndexEntry[] = [];
  for (const entry of input.entries) {
    for (const { id } of FEEDBACK_LIST_FILTERS) {
      if (matchesFeedbackFilter(entry, id, input.viewerUserId)) counts[id] += 1;
    }
    if (
      matchesFeedbackFilter(entry, input.filter, input.viewerUserId)
      && matchesFeedbackQuery(entry, input.query)
    ) {
      entries.push(entry);
    }
  }
  return { entries, counts };
}

const SUBJECT_ICONS: Record<string, string> = {
  document: 'description',
  tracker: 'assignment',
  file: 'draft',
  conversation: 'forum',
};

function subjectIcon(subject: FeedbackArtifact): string {
  return SUBJECT_ICONS[subject.ref.kind] ?? 'link';
}

export function feedbackSubjectViews(
  entry: FeedbackRequestIndexEntry,
): FeedbackListSubjectView[] {
  return entry.subjects.map((subject, index) => ({
    key: `${subject.ref.kind}:${subject.ref.sourceId}:${index}`,
    // Labels are frozen at send time by design, so this shows what the author
    // asked about even after the artifact was renamed.
    label: subject.label,
    icon: subjectIcon(subject),
  }));
}

export function feedbackAuthorLabel(
  entry: FeedbackRequestIndexEntry,
  viewerUserId: string,
  memberNames: Record<string, string>,
): string {
  if (isViewerAuthor(entry, viewerUserId)) return 'You';
  const name = memberNames[entry.author.onBehalfOfUserId]
    ?? (entry.author.userId ? memberNames[entry.author.userId] : undefined);
  if (entry.author.kind === 'agent') {
    return name ? `${name}'s agent` : entry.author.sessionName ?? 'An agent';
  }
  return name ?? 'A teammate';
}

export interface FeedbackRowViewInput {
  entry: FeedbackRequestIndexEntry;
  viewerUserId: string;
  memberNames: Record<string, string>;
  now: number;
}

export function toFeedbackRowView(
  input: FeedbackRowViewInput,
): FeedbackListRowView {
  const { entry, viewerUserId, memberNames, now } = input;
  const status = feedbackListStatus(entry);
  const { answeredRecipientCount, totalRecipientCount } = entry.progress;
  return {
    id: entry.requestId,
    title: entry.title,
    authorLabel: feedbackAuthorLabel(entry, viewerUserId, memberNames),
    status,
    statusLabel: STATUS_LABELS[status],
    progressLabel: `${answeredRecipientCount}/${totalRecipientCount} responded`,
    awaitingFirstResponse: answeredRecipientCount === 0,
    timeLabel: formatFeedbackAge(entry.updatedAt, now),
    needsViewerResponse: needsViewerResponse(entry, viewerUserId),
    dimmed: isTerminalStatus(status),
    subjects: feedbackSubjectViews(entry),
  };
}
