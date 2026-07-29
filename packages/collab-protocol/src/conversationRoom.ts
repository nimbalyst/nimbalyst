/**
 * ConversationRoom wire protocol.
 *
 * One WebSocket per conversation (room id `org:{orgId}:conversation:{id}`,
 * see roomIds.ts), authorized by the team JWT. The server serializes
 * request/response pairs — protocol errors are deliberately small and carry
 * no request id — while `conversationEvent` broadcasts arrive independently.
 *
 * Server counterpart: nimbalyst-collab packages/collabv3/src/ConversationRoom.ts.
 */

import type { Actor, CommentDeliveryHints } from "./comments.js";
import type { ConversationEvent, ConversationSubscription } from "./conversation.js";

// ============================================================================
// Client -> Server Messages
// ============================================================================

export type ConversationClientMessage =
  | ConversationAppendMessage
  | ConversationHistoryRequestMessage
  | ConversationSubscriptionSetMessage;

/**
 * The event fields a client supplies on append. The server stamps `id`,
 * `sequence`, `serverReceivedAt`, and (for user actors) the identity fields
 * from the JWT; `createdAt` is clamped server-side when implausible.
 */
export interface ConversationAppendEventInput {
  clientMutationId: string;
  actor: Actor;
  operation: ConversationEvent["operation"];
  targetMessageId?: string;
  payload?: ConversationEvent["payload"];
  createdAt?: number;
}

/** Append one event; acknowledged with `conversationAppendAck`. */
export interface ConversationAppendMessage {
  type: "conversationAppend";
  event: ConversationAppendEventInput;
  deliveryHints?: CommentDeliveryHints;
}

/**
 * Page backwards through history; answered with
 * `conversationHistoryResponse`. `beforeSequence` is exclusive.
 */
export interface ConversationHistoryRequestMessage {
  type: "conversationHistory";
  beforeSequence?: number;
  pageSize?: number;
}

/** Set the caller's follow state; answered with `conversationSubscriptionAck`. */
export interface ConversationSubscriptionSetMessage {
  type: "conversationSubscriptionSet";
  state: ConversationSubscription["state"];
  notificationLevel: ConversationSubscription["notificationLevel"];
}

// ============================================================================
// Server -> Client Messages
// ============================================================================

export type ConversationServerMessage =
  | ConversationAppendAckMessage
  | ConversationHistoryResponseMessage
  | ConversationSubscriptionAckMessage
  | ConversationEventBroadcastMessage
  | ConversationErrorMessage;

/** Acknowledges `conversationAppend`. `replayed` marks an idempotent retry. */
export interface ConversationAppendAckMessage {
  type: "conversationAppendAck";
  event: ConversationEvent;
  replayed: boolean;
}

/**
 * Answers `conversationHistory`. `nextCursor` is the sequence to pass as the
 * next `beforeSequence`; absent when the page reached the beginning.
 */
export interface ConversationHistoryResponseMessage {
  type: "conversationHistoryResponse";
  events: ConversationEvent[];
  nextCursor?: number;
}

/** Acknowledges `conversationSubscriptionSet`. */
export interface ConversationSubscriptionAckMessage {
  type: "conversationSubscriptionAck";
  subscription: ConversationSubscription;
}

/** Realtime broadcast of an appended event to every open connection. */
export interface ConversationEventBroadcastMessage {
  type: "conversationEvent";
  event: ConversationEvent;
}

/** Terminal error for the in-flight request (no request id on the wire). */
export interface ConversationErrorMessage {
  type: "conversationError";
  code: string;
  message: string;
}
