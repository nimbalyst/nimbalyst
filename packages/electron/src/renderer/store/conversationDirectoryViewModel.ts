import type { TeamInboxSnapshot } from '@nimbalyst/runtime/sync';
import type { ConversationTarget } from '@nimbalyst/runtime/sync';

import type { ConversationDirectoryEntry } from '../../shared/conversationDirectory';

export interface SelectConversationDirectoryOptions {
  orgId: string;
  includeArchived?: boolean;
  kinds?: ConversationDirectoryEntry['kind'][];
}

/**
 * Normalize server directory entries at the renderer boundary.
 *
 * The server is authoritative for capability resolution. The client still
 * filters out unreadable or cross-org descriptors before they reach atoms so
 * stale/malformed fixture data cannot become a visible directory row.
 */
export function selectConversationDirectory(
  conversations: readonly ConversationDirectoryEntry[],
  options: SelectConversationDirectoryOptions,
): ConversationDirectoryEntry[] {
  const kinds = options.kinds ? new Set(options.kinds) : null;
  return conversations.filter((conversation) => (
    conversation.orgId === options.orgId
    // A server old enough to omit capabilities grants nothing, which drops the
    // row rather than throwing and taking the whole directory down with it.
    && (conversation.capabilities ?? []).includes('read')
    && (options.includeArchived === true || conversation.archivedAt === undefined)
    && (!kinds || kinds.has(conversation.kind))
  ));
}

/**
 * The one encoding of "this delivery still wants attention": not dismissed, and
 * either never read or read before the followed conversation moved on
 * (`hasUnreadActivity`, materialized by TeamInboxFanIn). Every unread count and
 * mark-read path in the org window derives from this predicate.
 */
export function isUnreadDelivery(
  delivery: TeamInboxSnapshot['deliveries'][number],
): boolean {
  return !delivery.dismissedAt
    && (!delivery.readAt || delivery.hasUnreadActivity);
}

/**
 * The unread deliveries pointing at one conversation. Opening a room marks
 * exactly these read, and the sidebar counts exactly these.
 */
export function unreadDeliveryIdsForConversation(
  snapshot: TeamInboxSnapshot,
  target: ConversationTarget,
): string[] {
  return snapshot.deliveries
    .filter((delivery) => (
      delivery.orgId === target.orgId
      && !!delivery.source
      && 'sourceId' in delivery.source
      && delivery.source.sourceId === target.conversationId
      && isUnreadDelivery(delivery)
    ))
    .map((delivery) => delivery.id);
}

/**
 * Every unread delivery in one organization's inbox — trackers and documents
 * included, matching what the sidebar's Inbox pill counts.
 *
 * This is what Messages > Mark All as Read acts on. It is deliberately wider
 * than the Inbox surface's own "Mark <filter> read" button, which is scoped to
 * the filter on screen; the menu command works from any surface in the window,
 * including one where no filter is visible.
 */
export function unreadDeliveryIdsForOrg(
  snapshot: TeamInboxSnapshot,
  orgId: string,
): string[] {
  return snapshot.deliveries
    .filter((delivery) => delivery.orgId === orgId && isUnreadDelivery(delivery))
    .map((delivery) => delivery.id);
}

/**
 * A room is unread when its org-scoped inbox has either an unread delivery or
 * a read delivery whose followed-conversation watermark advanced afterward.
 */
export function isConversationUnread(
  snapshot: TeamInboxSnapshot,
  target: ConversationTarget,
): boolean {
  return unreadDeliveryIdsForConversation(snapshot, target).length > 0;
}
