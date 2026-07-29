/**
 * Pure view-model logic for the messaging Inbox.
 *
 * Everything the Inbox decides — what a row is allowed to say, which rows a
 * filter admits, what the counts are, and whether a row becomes read — lives
 * here as pure functions so it is testable without mounting the window and
 * without a data source. The components in this folder render the output of
 * these functions and nothing else.
 */

import type {
  HydratedInboxDelivery,
  InboxActorView,
  InboxFilterId,
  InboxRowGroup,
  InboxRowView,
  InboxScope,
  InboxScopeOptions,
  InboxSourceKind,
} from './inboxTypes';

/** Previews are bounded by contract; enforce it at render time too. */
export const INBOX_PREVIEW_MAX_CHARS = 180;

export const INBOX_FILTERS: ReadonlyArray<{ id: InboxFilterId; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'mentions', label: 'Mentions' },
  { id: 'assigned', label: 'Assigned' },
  { id: 'unread', label: 'Unread' },
  { id: 'follows', label: 'Follows' },
];

const REASON_LABELS: Record<string, string> = {
  mention: 'Mentioned you',
  agentMention: 'Mentioned your agent',
  assignment: 'Assigned to you',
  reply: 'Replied to you',
  dm: 'Direct message',
  follow: 'In a conversation you follow',
};

const SOURCE_ICONS: Record<InboxSourceKind, string> = {
  roomMessage: 'forum',
  documentDiscussion: 'description',
  dmMessage: 'mail',
  trackerComment: 'checklist',
  documentInlineComment: 'chat_bubble',
};

export const SOURCE_KIND_LABELS: Record<InboxSourceKind, string> = {
  roomMessage: 'Rooms',
  documentDiscussion: 'Document discussions',
  dmMessage: 'Direct messages',
  trackerComment: 'Tracker comments',
  documentInlineComment: 'Inline comments',
};

/** Icon shown when the row may not identify its source at all. */
const REDACTED_SOURCE_ICON = 'block';

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? 'New activity';
}

function truncatePreview(snippet: string): string {
  const collapsed = snippet.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= INBOX_PREVIEW_MAX_CHARS) return collapsed;
  return `${collapsed.slice(0, INBOX_PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}

export function formatRelativeTimestamp(createdAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - createdAt) / 1000));
  if (seconds < 45) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (days < 365) return `${weeks}w`;
  return `${Math.round(days / 365)}y`;
}

/**
 * A delivery may arrive without a structured actor — the server does not stamp
 * one yet. In that case the only honest attribution is the bounded preview's
 * display label, and a delivery with neither gets no actor at all rather than
 * an invented one.
 */
function toActorView(delivery: HydratedInboxDelivery): InboxActorView | undefined {
  const { actor } = delivery;
  const pending = delivery.agentDispatch === 'pending';
  if (!actor) {
    if (!delivery.actorLabel) return undefined;
    return { kind: 'user', displayName: delivery.actorLabel, pending };
  }
  return {
    kind: actor.kind,
    displayName: actor.kind === 'agent' ? actor.sessionName ?? actor.displayName : actor.displayName,
    sessionName: actor.kind === 'agent' ? actor.sessionName : undefined,
    onBehalfOfDisplayName: actor.kind === 'agent' ? actor.onBehalfOfDisplayName : undefined,
    pending,
  };
}

/**
 * Redact and format one delivery into something the UI may render.
 *
 * Availability drives how much survives:
 *
 * - `available` — everything, with the preview bounded.
 * - `deletedSource` — the recipient *was* authorized, so the actor and source
 *   kind stay (they already saw them); the body and title do not, because the
 *   source can no longer be re-read to confirm them.
 * - `accessRemoved` — reveal nothing about the former source. Not the title,
 *   not the participants, not the body, not the project, not even which kind of
 *   source it was. Only the delivery's own metadata (reason, timestamp, org)
 *   remains, so the user can understand and dismiss the row.
 */
export function toRowView(delivery: HydratedInboxDelivery, options: { now: number; stalePreviews?: boolean }): InboxRowView {
  const { now, stalePreviews = false } = options;
  const revoked = delivery.availability === 'accessRemoved';
  const deleted = delivery.availability === 'deletedSource';
  const unavailable = revoked || deleted;

  const actor = revoked ? undefined : toActorView(delivery);
  const sourceKind = revoked ? undefined : delivery.source.sourceKind;
  const sourceTitle = unavailable ? undefined : delivery.preview?.sourceTitle;
  const preview = unavailable ? undefined : delivery.preview?.snippet ? truncatePreview(delivery.preview.snippet) : undefined;
  const projectName = revoked ? undefined : delivery.projectName;

  const searchParts = [
    reasonLabel(delivery.reason),
    delivery.orgName,
    projectName ?? '',
    sourceTitle ?? '',
    actor?.displayName ?? '',
    actor?.onBehalfOfDisplayName ?? '',
    preview ?? '',
  ];

  return {
    id: delivery.id,
    viewerUserId: delivery.recipientUserId,
    reason: delivery.reason,
    reasonLabel: reasonLabel(delivery.reason),
    availability: delivery.availability,
    unavailableLabel: revoked ? 'No longer available' : deleted ? 'Deleted or unavailable' : undefined,
    orgId: delivery.orgId,
    orgName: delivery.orgName,
    projectId: revoked ? undefined : delivery.projectId,
    projectName,
    sourceId: revoked ? undefined : delivery.source.sourceId,
    commentId: revoked ? undefined : delivery.source.commentId,
    threadId: revoked ? undefined : delivery.source.threadId,
    sourceKind,
    sourceIcon: sourceKind ? SOURCE_ICONS[sourceKind] : REDACTED_SOURCE_ICON,
    sourceTitle,
    actor,
    preview,
    previewStale: stalePreviews && !!preview,
    createdAt: delivery.createdAt,
    timestampLabel: formatRelativeTimestamp(delivery.createdAt, now),
    unread: !delivery.readAt || !!delivery.hasUnreadActivity,
    // An unavailable row is otherwise a dead end — dismissal is the only way to
    // clear it, so it must always be offered.
    dismissible: true,
    subscription: revoked ? undefined : delivery.subscription,
    canReply: !unavailable && delivery.capabilities.comment,
    readOnlyReason: unavailable ? undefined : delivery.capabilities.comment ? undefined : delivery.readOnlyReason,
    searchText: searchParts.filter(Boolean).join(' ').toLowerCase(),
  };
}

export function matchesFilter(row: InboxRowView, filter: InboxFilterId): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'mentions':
      // `agentMention` belongs here: the plan routes an agent mention to the
      // owning human's personal room, and notification precedence groups
      // "explicit mentions (human and agent-handle)" as one class.
      return row.reason === 'mention' || row.reason === 'agentMention';
    case 'assigned':
      return row.reason === 'assignment';
    case 'unread':
      return row.unread;
    case 'follows':
      return row.subscription === 'following';
    default:
      return true;
  }
}

export function matchesScope(row: InboxRowView, scope: InboxScope): boolean {
  if (scope.orgIds && !scope.orgIds.includes(row.orgId)) return false;
  if (scope.sourceKinds) {
    // A redacted row has no source kind, so a source-type scope necessarily
    // excludes it rather than guessing.
    if (!row.sourceKind || !scope.sourceKinds.includes(row.sourceKind)) return false;
  }
  if (scope.projectIds) {
    if (!row.projectId || !scope.projectIds.includes(row.projectId)) return false;
  }
  return true;
}

/**
 * Inbox search. Every whitespace-separated term must appear in the row's
 * haystack, which is built from the redacted row — so search composes with the
 * filter and scope rather than replacing them, and never reaches content the
 * reader has lost access to.
 */
export function matchesQuery(row: InboxRowView, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  return terms.every((term) => row.searchText.includes(term));
}

export interface SelectRowsInput {
  deliveries: HydratedInboxDelivery[];
  filter: InboxFilterId;
  scope: InboxScope;
  query: string;
  now: number;
  stalePreviews?: boolean;
}

export interface SelectRowsResult {
  /** Rows after filter + scope, before the search query. */
  scoped: InboxRowView[];
  /** Rows the list renders: filter + scope + query. */
  rows: InboxRowView[];
  /** Unread count per filter, within the active scope. */
  counts: Record<InboxFilterId, number>;
}

export function selectRows(input: SelectRowsInput): SelectRowsResult {
  const { deliveries, filter, scope, query, now, stalePreviews } = input;

  const all = deliveries
    .filter((delivery) => !delivery.dismissedAt)
    .map((delivery) => toRowView(delivery, { now, stalePreviews }))
    .sort((a, b) => b.createdAt - a.createdAt);

  const inScope = all.filter((row) => matchesScope(row, scope));
  const scoped = inScope.filter((row) => matchesFilter(row, filter));
  const rows = scoped.filter((row) => matchesQuery(row, query));

  // Badges show what is actionable — unread within each filter — computed from
  // the same normalized rows the list renders, inside the active scope but
  // independent of the search query (search refines a filter, it does not
  // redefine how much is waiting in it).
  const counts = INBOX_FILTERS.reduce((acc, { id }) => {
    acc[id] = inScope.filter((row) => matchesFilter(row, id) && row.unread).length;
    return acc;
  }, {} as Record<InboxFilterId, number>);

  return { scoped, rows, counts };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Chronological day buckets. `now` is passed in so grouping is deterministic. */
export function groupRows(rows: InboxRowView[], now: number): InboxRowGroup[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  const buckets: InboxRowGroup[] = [
    { id: 'today', label: 'Today', rows: [] },
    { id: 'yesterday', label: 'Yesterday', rows: [] },
    { id: 'this-week', label: 'Earlier this week', rows: [] },
    { id: 'older', label: 'Older', rows: [] },
  ];

  for (const row of rows) {
    if (row.createdAt >= todayMs) buckets[0].rows.push(row);
    else if (row.createdAt >= todayMs - DAY_MS) buckets[1].rows.push(row);
    else if (row.createdAt >= todayMs - 7 * DAY_MS) buckets[2].rows.push(row);
    else buckets[3].rows.push(row);
  }

  return buckets.filter((bucket) => bucket.rows.length > 0);
}

/** Everything the scope control can offer, derived from the loaded rows. */
export function deriveScopeOptions(deliveries: HydratedInboxDelivery[]): InboxScopeOptions {
  const orgs = new Map<string, string>();
  const projects = new Map<string, string>();
  const sourceKinds = new Set<InboxSourceKind>();

  for (const delivery of deliveries) {
    orgs.set(delivery.orgId, delivery.orgName);
    // A revoked delivery must not contribute its former project or source type
    // to the scope control, or the control itself becomes the leak.
    if (delivery.availability === 'accessRemoved') continue;
    if (delivery.projectId && delivery.projectName) projects.set(delivery.projectId, delivery.projectName);
    sourceKinds.add(delivery.source.sourceKind);
  }

  return {
    orgs: [...orgs].map(([id, name]) => ({ id, name })),
    projects: [...projects].map(([id, name]) => ({ id, name })),
    sourceKinds: [...sourceKinds],
  };
}

export function isScopeActive(scope: InboxScope): boolean {
  return !!(scope.orgIds || scope.sourceKinds || scope.projectIds);
}

/**
 * Toggle one value on a scope axis, where `null` means "unrestricted".
 *
 * The subtlety: an unrestricted axis renders every box checked, so the first
 * click has to *uncheck* that one — which means materializing the full set
 * minus the clicked value, not selecting the clicked value alone. Selecting
 * everything (or nothing) collapses back to `null`, so the axis never ends up
 * in a state that shows an empty list the user cannot explain.
 */
export function toggleScopeValue<T extends string>(current: T[] | null, value: T, allValues: readonly T[]): T[] | null {
  const next = current === null
    ? allValues.filter((entry) => entry !== value)
    : current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];

  if (next.length === 0) return null;
  if (next.length === allValues.length) return null;
  return next;
}

export type ActivationOutcome = 'opened' | 'navigationFailed' | 'unavailable';

export interface ActivationResult {
  outcome: ActivationOutcome;
  markedRead: boolean;
}

/**
 * Activating a row marks it read *only after navigation succeeds* (plan:
 * "Activating a row marks that delivery read only after navigation succeeds").
 * A failed open must leave the row unread so the work is not silently lost.
 */
export async function activateRow(
  row: InboxRowView,
  deps: {
    navigate: (row: InboxRowView) => Promise<boolean>;
    markRead: (deliveryId: string) => Promise<void>;
  },
): Promise<ActivationResult> {
  if (row.availability !== 'available') {
    // Nothing to navigate to. The row stays as-is; dismissal is the exit.
    return { outcome: 'unavailable', markedRead: false };
  }

  let navigated = false;
  try {
    navigated = await deps.navigate(row);
  } catch {
    navigated = false;
  }
  if (!navigated) return { outcome: 'navigationFailed', markedRead: false };

  if (row.unread) await deps.markRead(row.id);
  return { outcome: 'opened', markedRead: row.unread };
}
