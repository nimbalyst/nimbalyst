import type { DocumentFeedbackInboxDelivery } from '../../../store/atoms/documentFeedbackInbox';
/**
 * Pure view-model logic for the messaging Inbox.
 *
 * Everything the Inbox decides — what a row is allowed to say, which rows a
 * filter admits, what the counts are, and whether a row becomes read — lives
 * here as pure functions so it is testable without mounting the window and
 * without a data source. The components in this folder render the output of
 * these functions and nothing else.
 */

import { getFileIconName } from '@nimbalyst/runtime/ui/icons/fileIcons';
import {
  defaultTrackerTypeColor,
  defaultTrackerTypeIcon,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerTypeIdentity';
import type {
  TeamInboxMaterializedDelivery,
  TeamInboxSnapshot,
} from '@nimbalyst/runtime/sync';

import { isUnreadDelivery } from '../../../store/conversationDirectoryViewModel';
import type {
  HydratedInboxDelivery,
  InboxActorView,
  InboxFilterId,
  InboxRowGroup,
  InboxRowView,
  InboxScope,
  InboxScopeOptions,
  InboxSourceKind,
  InboxSubscriptionState,
  InboxTypeIdentity,
} from './inboxTypes';

/** Previews are bounded by contract; enforce it at render time too. */
export const INBOX_PREVIEW_MAX_CHARS = 180;

/**
 * The reason axis, in the order the sidebar lists it. Read state and source
 * type are their own axes and stay in the list's own filter bar.
 */
export const INBOX_FILTERS: ReadonlyArray<{ id: InboxFilterId; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'mentions', label: 'Mentions' },
  { id: 'assigned', label: 'Assigned to me' },
  { id: 'awaiting', label: 'Awaiting my reply' },
  { id: 'follows', label: 'Following' },
  { id: 'archived', label: 'Archived' },
];

export function inboxFilterLabel(filter: InboxFilterId): string {
  return INBOX_FILTERS.find((entry) => entry.id === filter)?.label ?? 'All';
}

const REASON_LABELS: Record<string, string> = {
  mention: 'Mentioned you',
  agentMention: 'Mentioned your agent',
  assignment: 'Assigned to you',
  reply: 'Replied to you',
  dm: 'Direct message',
  follow: 'In a conversation you follow',
};

/**
 * Identity per source kind. The accents are deliberately five different hues:
 * a uniform gray glyph is what made every row look alike, and the type is the
 * first thing a reader needs.
 */
const SOURCE_TYPES: Record<InboxSourceKind, InboxTypeIdentity> = {
  roomMessage: { icon: 'forum', accent: 'var(--nim-primary)', label: 'Room' },
  dmMessage: { icon: 'mail', accent: 'var(--nim-purple)', label: 'Direct' },
  trackerComment: { icon: 'checklist', accent: 'var(--nim-warning)', label: 'Tracker' },
  // Both document kinds are *documents*. A speech bubble here was the exact
  // failure this redesign exists to fix: it described the delivery's shape
  // (someone commented) instead of the thing you are about to open.
  documentDecision: { icon: 'ballot', accent: 'var(--nim-purple)', label: 'Question' },
  documentDiscussion: { icon: 'description', accent: 'var(--nim-success)', label: 'Doc' },
  documentInlineComment: { icon: 'description', accent: 'var(--nim-success)', label: 'Doc' },
  // Shares the direct-message hue deliberately: both are addressed to you
  // personally rather than to a room, and the palette has no sixth hue that
  // is not a status color. The ballot glyph and the label carry the
  // distinction — this row wants an answer, a DM wants a reply.
  feedbackRequest: { icon: 'ballot', accent: 'var(--nim-purple)', label: 'Feedback' },
};

/**
 * A document delivery's `sourceTitle` is the file name, so the row can show the
 * document's own icon — a markdown file, a drawing, a spreadsheet — the same
 * one the file tree shows. `getFileIconName` returns a custom marker rather
 * than a symbol name for TypeScript, which this surface has no renderer for.
 */
function documentIcon(sourceTitle?: string): string {
  if (!sourceTitle) return 'description';
  const icon = getFileIconName(sourceTitle);
  return icon === 'typescript' ? 'code' : icon;
}

/** Shown when the row may not identify its source at all. */
const REDACTED_TYPE: InboxTypeIdentity = {
  icon: 'block',
  accent: 'var(--nim-text-faint)',
  label: 'Unavailable',
};

export const SOURCE_KIND_LABELS: Record<InboxSourceKind, string> = {
  roomMessage: 'Rooms',
  documentDiscussion: 'Document discussions',
  documentDecision: 'Document questions',
  dmMessage: 'Direct messages',
  trackerComment: 'Tracker comments',
  documentInlineComment: 'Inline comments',
  feedbackRequest: 'Feedback requests',
};

/**
 * Typed requests whose authorized state still asks this viewer for an answer.
 *
 * A comment or a mention is a statement the reader may act on; a feedback
 * request is a question with typed answers waiting on them, and the row has to
 * say so before it is opened. Derived from the source kind alone — response
 * state lives on the request resource, which a delivery does not carry.
 */
export function awaitsResponse(sourceKind: InboxSourceKind | undefined, reason?: string, documentDecisionNeedsResponse?: boolean): boolean {
  return sourceKind === 'feedbackRequest' || (sourceKind === 'documentDecision' && reason === 'assignment' && documentDecisionNeedsResponse === true);
}

/**
 * What kind of thing this row points at — resolved as specifically as the
 * delivery allows, because "what am I about to open" is the first question a
 * reader has and the one the old uniform gray glyph refused to answer.
 *
 * A tracker delivery resolves down to its item type when the delivery carried
 * one — a bug gets the bug icon and reads BUG, and a type registered by an
 * extension gets its own icon without the Inbox knowing about it. A document
 * delivery resolves to that document's file icon. Anything unresolvable falls
 * back to the generic identity for its kind rather than guessing; for trackers
 * the delivery is the only source, because the item may live in a project this
 * client has never synced.
 */
export function typeIdentity(
  sourceKind: InboxSourceKind | undefined,
  details: { itemType?: string; sourceTitle?: string } = {},
): InboxTypeIdentity {
  if (!sourceKind) return REDACTED_TYPE;

  if (sourceKind === 'trackerComment' && details.itemType) {
    return {
      icon: defaultTrackerTypeIcon(details.itemType),
      accent: defaultTrackerTypeColor(details.itemType),
      label: details.itemType,
    };
  }

  if (sourceKind === 'documentDiscussion' || sourceKind === 'documentInlineComment') {
    return { ...SOURCE_TYPES[sourceKind], icon: documentIcon(details.sourceTitle) };
  }

  return SOURCE_TYPES[sourceKind];
}

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? 'New activity';
}

/**
 * Reasons worth a chip. `dm` and `follow` are already carried by the type icon
 * and the Follows filter, and stamping them on every row is what buried the
 * rows that actually wanted attention.
 */
const CHIPPED_REASONS: Record<string, string> = {
  mention: 'Mention',
  agentMention: 'Agent mention',
  assignment: 'Assigned',
  reply: 'Reply',
};

export function reasonChipLabel(reason: string): string | undefined {
  return CHIPPED_REASONS[reason];
}

/**
 * What the open action promises. Naming the destination is the other half of
 * making the click model legible: selecting is free, and the one control that
 * does move you says where to.
 */
export function openActionLabel(row: Pick<InboxRowView, 'sourceKind' | 'itemType'>): string {
  switch (row.sourceKind) {
    case 'trackerComment':
      return row.itemType ? `Open ${row.itemType}` : 'Open tracker item';
    case 'documentDecision':
    case 'documentDiscussion':
    case 'documentInlineComment':
      return 'Open document';
    case 'roomMessage':
      return 'Open room';
    case 'dmMessage':
      return 'Open conversation';
    case 'feedbackRequest':
      return 'Open feedback request';
    case undefined:
      return 'Open';
    default: {
      const unhandled: never = row.sourceKind;
      void unhandled;
      return 'Open';
    }
  }
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
  // The item type identifies the source as surely as its title does, so it is
  // redacted on the same terms — a revoked row keeps nothing, and a deleted
  // source keeps the kind the reader already saw but not the specifics.
  const itemType = unavailable ? undefined : delivery.preview?.itemType;
  const sourceTitle = unavailable ? undefined : delivery.preview?.sourceTitle;
  const preview = unavailable ? undefined : delivery.preview?.snippet ? truncatePreview(delivery.preview.snippet) : undefined;
  const projectName = revoked ? undefined : delivery.projectName;

  const searchParts = [
    reasonLabel(delivery.reason),
    delivery.orgName,
    projectName ?? '',
    itemType ?? '',
    sourceTitle ?? '',
    actor?.displayName ?? '',
    actor?.onBehalfOfDisplayName ?? '',
    preview ?? '',
  ];

  return {
    id: delivery.id,
    teamMemberId: delivery.teamMemberId,
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
    blockId: revoked ? undefined : delivery.source.blockId,
    sourceKind,
    itemType,
    type: typeIdentity(sourceKind, { itemType, sourceTitle }),
    // Redacted with the source kind: a revoked row must not disclose that
    // someone was waiting on an answer from this reader.
    awaitsResponse: awaitsResponse(sourceKind, delivery.reason, delivery.documentDecisionNeedsResponse),
    archived: !!delivery.dismissedAt,
    sourceTitle,
    actor,
    preview,
    previewStale: stalePreviews && !!preview,
    createdAt: delivery.createdAt,
    timestampLabel: formatRelativeTimestamp(delivery.createdAt, now),
    // Same rule `isUnreadDelivery` applies to the fan-in, dismissal included —
    // now that Archived is a list you can stand in, a row that still read as
    // unread there would put a count in the header the nav row denies.
    unread: !delivery.dismissedAt
      && (!delivery.readAt || !!delivery.hasUnreadActivity),
    // An unavailable row is otherwise a dead end — dismissal is the only way to
    // clear it, so it must always be offered.
    dismissible: true,
    subscription: revoked ? undefined : delivery.subscription,
    canReply: !unavailable && delivery.capabilities.comment,
    readOnlyReason: unavailable ? undefined : delivery.capabilities.comment ? undefined : delivery.readOnlyReason,
    searchText: searchParts.filter(Boolean).join(' ').toLowerCase(),
  };
}

/**
 * The four facts every reason filter reads.
 *
 * Deliberately structural rather than `InboxRowView`: the sidebar's nav counts
 * run the same predicate over the raw fan-in, which never becomes a row view.
 * One predicate, two callers — the alternative is two definitions of "Mentions"
 * that can drift, with the badge and the list disagreeing about the same word.
 */
export interface InboxFilterSubject {
  reason?: string;
  subscription?: InboxSubscriptionState;
  /** From `awaitsResponse()`; redacted along with the source kind. */
  awaitsResponse: boolean;
  /** Dismissed. The Archived row's pool, and nobody else's. */
  archived: boolean;
}

export function matchesFilter(row: InboxFilterSubject, filter: InboxFilterId): boolean {
  // Archived is a state, not a reason: a dismissed delivery belongs to exactly
  // one row, and every other row reads the live pool. Without this, dismissing
  // something would only hide it from All.
  if (row.archived) return filter === 'archived';

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
    case 'awaiting':
      // The feedback row. `awaitsResponse` is the single definition of "this
      // wants something back from you"; it must not be restated here.
      return row.awaitsResponse;
    case 'follows':
      return row.subscription === 'following';
    case 'archived':
      return false;
    default: {
      const unhandled: never = filter;
      void unhandled;
      return true;
    }
  }
}

/**
 * One delivery from the org fan-in, as the reason filters read it.
 *
 * Mirrors `toRowView`'s redaction: an unavailable delivery discloses no source
 * kind, so it can never land in Awaiting my reply.
 */
function deliveryFilterSubject(
  delivery: TeamInboxMaterializedDelivery,
): InboxFilterSubject {
  const source = delivery.unavailable ? undefined : delivery.source;
  const sourceKind = source && 'sourceKind' in source ? source.sourceKind
    : source && 'resourceKind' in source && source.resourceKind === 'document' && source.eventClass.startsWith('documentDecision') ? 'documentDecision' : undefined;
  return {
    reason: delivery.reason,
    subscription: delivery.subscription,
    awaitsResponse: awaitsResponse(sourceKind, delivery.reason, (delivery as DocumentFeedbackInboxDelivery).documentDecisionNeedsResponse),
    archived: !!delivery.dismissedAt,
  };
}

/**
 * The badge on one Inbox nav row: unread deliveries in this organization that
 * the row's filter admits.
 *
 * Deliberately org-scoped and independent of the list's own scope, unread
 * toggle and search — those refine what you are looking at; the nav says how
 * much is waiting.
 *
 * Archived is structurally unbadged rather than special-cased: dismissing is
 * what `isUnreadDelivery` reads as "no longer waiting", so the one pool that
 * holds dismissed deliveries can never contribute to a count. Which is the
 * behaviour we want — a pill there would re-nag the reader for having said
 * they were done.
 */
export function inboxNavCount(
  snapshot: TeamInboxSnapshot,
  orgId: string,
  filter: InboxFilterId,
): number {
  let count = 0;
  for (const delivery of snapshot.deliveries) {
    if (delivery.orgId !== orgId) continue;
    // Shared with the sidebar's conversation counts and the mark-read-on-open
    // path, so the two can never disagree about what "unread" means.
    if (!isUnreadDelivery(delivery)) continue;
    if (matchesFilter(deliveryFilterSubject(delivery), filter)) count += 1;
  }
  return count;
}

/**
 * Deliveries a surface pinned to one organization is allowed to see.
 *
 * The fan-in behind the Inbox is deliberately multi-org, and the standalone
 * organization window is the surface that wants it that way. A surface embedded
 * in a project window is not: it renders under one organization's header, and
 * its rows open into that project's window — so a row from another organization
 * there both discloses that organization's activity under the wrong name and
 * lies about where opening it lands.
 */
export function deliveriesInOrg<T extends { orgId: string }>(
  deliveries: T[],
  restrictToOrgId?: string,
): T[] {
  if (!restrictToOrgId) return deliveries;
  return deliveries.filter((delivery) => delivery.orgId === restrictToOrgId);
}

/**
 * The scope a pinned surface actually applies.
 *
 * `inboxPreferences` stores one scope per user, not one per surface, so a
 * narrowing made in the organization window — "only Acme" — arrives here
 * verbatim. Applied as stored on a surface pinned to a different organization
 * it empties the list with no visible cause and no way back: the org axis is
 * not even offered once there is only one organization to offer. So the org
 * axis is dropped rather than honored — the pin *is* the org restriction, and
 * the stored one has nothing left to say. A stored project belonging to some
 * other organization goes the same way, for the same reason.
 */
export function scopeWithinOrg(
  scope: InboxScope,
  restrictToOrgId: string | undefined,
  deliveries: ReadonlyArray<{ orgId: string; projectId?: string }>,
): InboxScope {
  if (!restrictToOrgId) return scope;
  const projectIds = scope.projectIds?.filter((projectId) => deliveries.some(
    (delivery) => delivery.orgId === restrictToOrgId && delivery.projectId === projectId,
  )) ?? null;
  return {
    orgIds: null,
    sourceKinds: scope.sourceKinds,
    projectIds: projectIds && projectIds.length > 0 ? projectIds : null,
  };
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
  /** Independent of `filter`, so "unread mentions" is expressible. */
  unreadOnly?: boolean;
  scope: InboxScope;
  query: string;
  now: number;
  stalePreviews?: boolean;
  /**
   * Pin the list to one organization. Set by a surface that belongs to a single
   * organization (the project window's Org mode); absent in the standalone
   * organization window, which is the cross-org surface by design.
   */
  restrictToOrgId?: string;
}

export interface SelectRowsResult {
  /**
   * Rows after every axis except the search query. This is what "mark all
   * read" acts on, so it has to respect the unread toggle too — otherwise the
   * button silently reaches rows the list is not showing.
   */
  scoped: InboxRowView[];
  /** Rows the list renders: every axis plus the query. */
  rows: InboxRowView[];
  /**
   * Unread count within the active scope, across every reason. Per-reason
   * counts belong to the sidebar's nav rows now (`inboxNavCount`), which are
   * org-scoped and independent of what the list is narrowed to.
   */
  unreadInScope: number;
  /** Type counts within the active scope, for the type chips. */
  typeCounts: Partial<Record<InboxSourceKind, number>>;
}

export function selectRows(input: SelectRowsInput): SelectRowsResult {
  const { deliveries, filter, unreadOnly = false, query, now, stalePreviews, restrictToOrgId } = input;

  // The pin is applied to the pool itself rather than as one more scope axis:
  // it is not the user's to turn off, and every count below is derived from the
  // pool, so nothing downstream can promise a row the list refuses to show.
  const pool = deliveriesInOrg(deliveries, restrictToOrgId);
  const scope = scopeWithinOrg(input.scope, restrictToOrgId, pool);

  const all = pool
    .map((delivery) => toRowView(delivery, { now, stalePreviews }))
    .sort((a, b) => b.createdAt - a.createdAt);

  // The archived and live pools are disjoint, and only the active filter's pool
  // is in scope — so a dismissed delivery cannot inflate the live inbox's
  // unread count or its type chips, and the Archived row shows nothing else.
  const inPool = all.filter((row) => row.archived === (filter === 'archived'));
  const inScope = inPool.filter((row) => matchesScope(row, scope));
  const scoped = inScope
    .filter((row) => matchesFilter(row, filter))
    .filter((row) => !unreadOnly || row.unread);
  const rows = scoped.filter((row) => matchesQuery(row, query));

  // The type axis counts everything in scope, not just unread: the chips are a
  // "how much of each kind is here" control, and a zeroed chip for a type that
  // has rows would read as "none of those" rather than "none unread".
  const typeCounts: Partial<Record<InboxSourceKind, number>> = {};
  for (const row of inScope) {
    if (!row.sourceKind) continue;
    typeCounts[row.sourceKind] = (typeCounts[row.sourceKind] ?? 0) + 1;
  }

  return {
    scoped,
    rows,
    unreadInScope: inScope.filter((row) => row.unread).length,
    typeCounts,
  };
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

/**
 * Everything the scope control can offer, derived from the loaded rows — and,
 * on a pinned surface, only from the rows that surface can show. A control that
 * offered another organization's projects would be the leak the list no longer
 * is.
 */
export function deriveScopeOptions(
  deliveries: HydratedInboxDelivery[],
  restrictToOrgId?: string,
): InboxScopeOptions {
  const orgs = new Map<string, string>();
  const projects = new Map<string, string>();
  const sourceKinds = new Set<InboxSourceKind>();

  for (const delivery of deliveriesInOrg(deliveries, restrictToOrgId)) {
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
 * Whether the org/project scope control has anything to say.
 *
 * One organization is not a choice, and `projectId` is not on the wire at all
 * yet (`TeamInboxMaterializedDelivery` carries no project, so `deriveScopeOptions`
 * only ever finds projects in fixtures) — which together left the menu opening
 * onto an empty box for every real single-org user. A control that cannot
 * change anything should not be on screen; it comes back on its own the day a
 * second org, or a project-stamped delivery, shows up.
 *
 * An already-narrowed scope keeps the trigger regardless, or a restored
 * preference could hide rows with no visible way to undo it.
 */
export function hasScopeChoices(options: InboxScopeOptions, scope: InboxScope): boolean {
  return options.orgs.length > 1 || options.projects.length > 0 || !!(scope.orgIds || scope.projectIds);
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
 * Open a row's canonical source.
 *
 * Deliberately separate from selecting one. A single click only ever selects —
 * it fills the context pane and nothing moves — because when the same click
 * sometimes navigated and sometimes did not, which one you got depended on
 * whether the row happened to have a deep link, which is invisible at click
 * time. Opening is now always an explicit act: Enter, a double click, or the
 * pane's open button, each of which names where it is going.
 *
 * Read state is still consumed *only after navigation succeeds* (plan:
 * "Activating a row marks that delivery read only after navigation succeeds").
 * A failed open must leave the row unread so the work is not silently lost.
 */
export async function openRow(
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
