/**
 * TeamInboxRoom wire protocol.
 *
 * One WebSocket per member per organization (room id
 * `org:{orgId}:user:{teamMemberId}:inbox`, see roomIds.ts), authorized by the
 * team JWT. Delivery content is encrypted at rest under the org's
 * server-managed DEK; a delivery the recipient may no longer read hydrates as
 * an `InboxUnavailableDelivery` that reveals only its own metadata.
 *
 * Server counterpart: nimbalyst-collab packages/collabv3/src/TeamInboxRoom.ts.
 */

import type { ConversationSubscription, InboxDelivery } from "./conversation.js";

/**
 * A stored delivery whose source the recipient can no longer be shown
 * (notification capability revoked). Only the delivery's own metadata
 * survives hydration.
 */
export type InboxUnavailableDelivery = {
  id: string;
  recipientUserId: string;
  orgId: string;
  createdAt: number;
  readAt?: number;
  dismissedAt?: number;
  unavailable: true;
};

/** What `inboxSyncResponse.deliveries` actually carries. */
export type InboxWireDelivery = InboxDelivery | InboxUnavailableDelivery;

/** Latest observed sequence per conversation, for unread-activity tracking. */
export type InboxWatermark = {
  conversationId: string;
  sequence: number;
  updatedAt: number;
};

// ============================================================================
// Client -> Server Messages
// ============================================================================

export type TeamInboxClientMessage =
  | InboxSyncRequestMessage
  | MarkInboxReadMessage
  | DismissInboxMessage;

/** Request the full hydrated inbox state; answered with `inboxSyncResponse`. */
export interface InboxSyncRequestMessage {
  type: "inboxSyncRequest";
}

/**
 * Mark deliveries read. An empty `deliveryIds` marks every undismissed
 * delivery read. Answered (broadcast to all connections) with
 * `markInboxReadResponse`.
 */
export interface MarkInboxReadMessage {
  type: "markInboxRead";
  deliveryIds: string[];
}

/** Dismiss deliveries; broadcast-answered with `dismissInboxResponse`. */
export interface DismissInboxMessage {
  type: "dismissInbox";
  deliveryIds: string[];
}

// ============================================================================
// Server -> Client Messages
// ============================================================================

export type TeamInboxServerMessage =
  | InboxSyncResponseMessage
  | InboxDeliveryBroadcastMessage
  | ConversationAdvancedBroadcastMessage
  | ConversationSubscriptionBroadcastMessage
  | MarkInboxReadResponseMessage
  | DismissInboxResponseMessage
  | InboxErrorMessage;

/** Full hydrated state: undismissed deliveries (newest first, capped server-side). */
export interface InboxSyncResponseMessage {
  type: "inboxSyncResponse";
  deliveries: InboxWireDelivery[];
  watermarks: InboxWatermark[];
  subscriptions: ConversationSubscription[];
  unreadCount: number;
}

/** Realtime broadcast of a newly routed delivery. */
export interface InboxDeliveryBroadcastMessage {
  type: "inboxDeliveryBroadcast";
  delivery: InboxDelivery;
}

/** A followed conversation advanced past this member's last-known sequence. */
export interface ConversationAdvancedBroadcastMessage {
  type: "conversationAdvancedBroadcast";
  conversationId: string;
  sequence: number;
  updatedAt: number;
}

/** The member's subscription for a conversation changed (from any device). */
export interface ConversationSubscriptionBroadcastMessage {
  type: "conversationSubscriptionBroadcast";
  subscription: ConversationSubscription;
}

/** Broadcast answer to `markInboxRead`; echoes the affected ids. */
export interface MarkInboxReadResponseMessage {
  type: "markInboxReadResponse";
  deliveryIds: string[];
  readAt: number;
  unreadCount: number;
}

/** Broadcast answer to `dismissInbox`; echoes the affected ids. */
export interface DismissInboxResponseMessage {
  type: "dismissInboxResponse";
  deliveryIds: string[];
  dismissedAt: number;
  unreadCount: number;
}

/** Terminal error for the in-flight request (no request id on the wire). */
export interface InboxErrorMessage {
  type: "inboxError";
  code: string;
  message: string;
}
