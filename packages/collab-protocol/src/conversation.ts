/**
 * Conversation registry, event-stream, subscription, delivery, and activity
 * contracts for Teams messaging.
 */

import type {
  Actor,
  CommentDeliveryHints,
  CommentRef,
  MessagingValidationError,
  MessagingValidationResult,
  ResourceRef,
  RichCommentBody,
} from "./comments.js";

export const CONVERSATION_HISTORY_PAGE_SIZE = 100;
export const MAX_AGENT_MENTION_HOP_DEPTH = 4;
/** Hard ceiling every producer re-applies to `BoundedPreview.snippet`. */
export const MAX_INBOX_PREVIEW_SNIPPET_CHARS = 240;

export type ConversationDescriptor = {
  id: string;
  orgId: string;
  kind: "orgRoom" | "documentDiscussion" | "dm";
  visibility: "public" | "private" | "sourceInherited";
  documentId?: string;
  title?: string;
  topic?: string;
  agentPostingEnabled: boolean;
  createdByUserId: string;
  createdAt: number;
  archivedAt?: number;
  /**
   * Lean participant identity for direct conversations. Omitted for rooms and
   * by older servers.
   */
  participants?: ConversationParticipant[];
  /** Calling member's directory subscription. Omitted when none is stored. */
  subscription?: {
    state: "following" | "muted";
    notificationLevel: "all" | "mentions" | "none";
  };
};

export type ConversationMembership = {
  conversationId: string;
  userId: string;
  role: "member" | "roomAdmin";
  addedByUserId: string;
  createdAt: number;
  removedAt?: number;
  /** Org-roster identity when the server has it. */
  email?: string | null;
};

export type ConversationParticipant = {
  userId: string;
  role: ConversationMembership["role"];
  /** Org-roster identity when the server has it. */
  email?: string | null;
};

export type ConversationMembersResponse = {
  memberships: ConversationMembership[];
};

export type ConversationEvent = {
  id: string;
  conversationId: string;
  sequence: number;
  clientMutationId: string;
  actor: Actor;
  operation:
    | "messageCreated"
    | "messageEdited"
    | "messageDeleted"
    | "reactionAdded"
    | "reactionRemoved";
  targetMessageId?: string;
  payload?: {
    body?: RichCommentBody;
    emoji?: string;
    resourceRefs?: ResourceRef[];
    replyToMessageId?: string;
    agentHopDepth?: number;
  };
  /**
   * Server-reconciled delivery metadata. Mention ids correspond only to
   * validated visible body mentions; assignments remain a separate channel.
   */
  deliveryHints?: CommentDeliveryHints;
  createdAt: number;
  serverReceivedAt: number;
};

export type ConversationSubscription = {
  conversationId: string;
  userId: string;
  state: "following" | "muted";
  reason: "explicit" | "participated";
  notificationLevel: "all" | "mentions" | "none";
};

/**
 * Bounded, non-authoritative inbox copy used only until the source is hydrated.
 */
export type BoundedPreview = {
  actorLabel?: string;
  sourceTitle?: string;
  snippet?: string;
};

export type InboxDelivery = {
  id: string;
  recipientUserId: string;
  orgId: string;
  source: CommentRef | ActivityRef;
  reason: "mention" | "agentMention" | "assignment" | "reply" | "follow" | "dm";
  /**
   * Structured author of the source event. Optional: the server does not
   * populate it yet, so clients must fall back to display-only attribution
   * (`preview.actorLabel`) rather than fabricating an Actor.
   */
  actor?: Actor;
  preview?: BoundedPreview;
  createdAt: number;
  readAt?: number;
  dismissedAt?: number;
};

export type ActivityRef = {
  orgId: string;
  resourceKind: "tracker" | "document";
  resourceId: string;
  sourceEventId: string;
  eventClass: string;
};

function validationResult(
  errors: MessagingValidationError[]
): MessagingValidationResult {
  return { valid: errors.length === 0, errors };
}

export function validateConversationHistoryPage(
  events: readonly ConversationEvent[]
): MessagingValidationResult {
  if (events.length <= CONVERSATION_HISTORY_PAGE_SIZE) {
    return validationResult([]);
  }
  return validationResult([
    {
      code: "historyPageTooLarge",
      path: "events",
      message: `A conversation history page may contain at most ${CONVERSATION_HISTORY_PAGE_SIZE} events.`,
      limit: CONVERSATION_HISTORY_PAGE_SIZE,
      actual: events.length,
    },
  ]);
}

export function validateConversationClientMutationIds(
  events: readonly ConversationEvent[]
): MessagingValidationResult {
  const errors: MessagingValidationError[] = [];
  const seen = new Set<string>();
  events.forEach((event, index) => {
    const key = JSON.stringify([event.conversationId, event.clientMutationId]);
    if (seen.has(key)) {
      errors.push({
        code: "duplicateClientMutationId",
        path: `events[${index}].clientMutationId`,
        message: "clientMutationId must be unique within a conversation.",
      });
    }
    seen.add(key);
  });
  return validationResult(errors);
}

export function validateAgentMentionHopDepth(
  agentHopDepth: number
): MessagingValidationResult {
  if (agentHopDepth <= MAX_AGENT_MENTION_HOP_DEPTH) {
    return validationResult([]);
  }
  return validationResult([
    {
      code: "agentHopDepthExceeded",
      path: "payload.agentHopDepth",
      message: `Agent-to-agent mention hop depth must not exceed ${MAX_AGENT_MENTION_HOP_DEPTH}.`,
      limit: MAX_AGENT_MENTION_HOP_DEPTH,
      actual: agentHopDepth,
    },
  ]);
}
