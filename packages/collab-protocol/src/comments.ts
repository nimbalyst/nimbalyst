/**
 * Shared logical comment contracts for Teams messaging and source-owned
 * comment adapters.
 *
 * These types normalize comments without changing which source owns their
 * persistence.
 */

/** Maximum UTF-8 bytes in `RichCommentBody.text`. */
export const MAX_RICH_COMMENT_TEXT_BYTES = 32 * 1024;
/** Maximum UTF-8 bytes in the complete JSON-encoded body envelope. */
export const MAX_RICH_COMMENT_BODY_ENVELOPE_BYTES = 64 * 1024;
export const MAX_RESOURCE_REFS_PER_MESSAGE = 16;
export const MAX_MENTIONED_USERS_PER_MESSAGE = 50;
export const MAX_MENTIONED_AGENTS_PER_MESSAGE = 8;
export const MAX_REACTION_EMOJI_PER_MESSAGE = 20;

export type Actor = {
  kind: "user" | "agent";
  userId?: string;
  sessionId?: string;
  sessionName?: string;
  onBehalfOfUserId: string;
};

export type CommentRef = {
  orgId: string;
  sourceKind:
    | "roomMessage"
    | "documentDiscussion"
    | "dmMessage"
    | "trackerComment"
    | "documentInlineComment";
  sourceId: string;
  commentId: string;
  threadId?: string;
};

export type BodyEntity =
  | {
      start: number;
      end: number;
      kind: "userMention";
      userId: string;
    }
  | {
      start: number;
      end: number;
      kind: "agentMention";
      sessionId: string;
    }
  | {
      start: number;
      end: number;
      kind: "resource";
      refIndex: number;
    };

/**
 * The shared V1 body representation.
 *
 * Entity positions are UTF-8 byte offsets into `text`. `plainText` means no
 * inline interpretation at all, including no emoji shortcode substitution.
 * `nimbalystMarkdown` names Nimbalyst's bounded inline dialect rather than
 * promising general Markdown behavior.
 */
export type RichCommentBody = {
  version: 1;
  format: "plainText" | "nimbalystMarkdown";
  text: string;
  entities?: BodyEntity[];
};

export type ReactionAggregate = {
  emoji: string;
  count: number;
  reactedByMe: boolean;
};

/**
 * Protocol-level effective capabilities.
 *
 * A legacy two-field CommentCapabilities also exists in
 * packages/runtime/src/editor/commenting/types.ts. Import this seven-field
 * protocol contract from @nimbalyst/collab-protocol and alias it when both
 * contracts are in scope.
 */
export type CommentCapabilities = {
  read: boolean;
  comment: boolean;
  react: boolean;
  editOwn: boolean;
  deleteOwn: boolean;
  moderate: boolean;
  manageRoom: boolean;
};

export type ResourceRef = {
  orgId: string;
  kind:
    | "tracker"
    | "document"
    | "session"
    | "file"
    | "commit"
    | "pullRequest"
    | "conversation";
  sourceId: string;
  projectId?: string;
  messageId?: string;
};

export type CommentDeliveryHints = {
  mentionedUserIds: string[];
  mentionedAgentSessionIds: string[];
  assignedUserIds: string[];
};

export type Comment = {
  ref: CommentRef;
  actor: Actor;
  body: RichCommentBody;
  createdAt: number;
  editedAt?: number;
  deletedAt?: number;
  replyToCommentId?: string;
  resourceRefs: ResourceRef[];
  reactions?: ReactionAggregate[];
  capabilities: CommentCapabilities;
  deliveryHints?: CommentDeliveryHints;
};

export type CommentPage = {
  comments: Comment[];
  nextCursor?: string;
};

export type CommentChange =
  | {
      type: "created" | "updated";
      comment: Comment;
    }
  | {
      type: "removed";
      ref: CommentRef;
    };

export type CreateCommentInput = {
  actor: Actor;
  body: RichCommentBody;
  clientMutationId: string;
  replyToCommentId?: string;
  resourceRefs?: ResourceRef[];
  deliveryHints?: CommentDeliveryHints;
};

export type Unsubscribe = () => void;

export interface CommentAdapter {
  list(cursor?: string): Promise<CommentPage>;
  create(input: CreateCommentInput): Promise<Comment>;
  edit(ref: CommentRef, body: RichCommentBody): Promise<Comment>;
  remove(ref: CommentRef): Promise<void>;
  react?(ref: CommentRef, emoji: string, on: boolean): Promise<void>;
  subscribe(onChange: (change: CommentChange) => void): Unsubscribe;
}

export type CollaborationAction =
  | "read"
  | "comment"
  | "react"
  | "editOwnComment"
  | "deleteOwnComment"
  | "moderateComments"
  | "manageRoom"
  | "receiveNotification";

export type MessagingValidationErrorCode =
  | "richBodyTooLarge"
  | "richBodyEnvelopeTooLarge"
  | "richBodyNotSerializable"
  | "bodyEntitiesNotAllowedInPlainText"
  | "bodyEntityOffsetInvalid"
  | "bodyEntitiesOutOfOrder"
  | "bodyEntitiesOverlap"
  | "bodyEntityResourceRefMissing"
  | "bodyEntityMentionHintMissing"
  | "tooManyResourceRefs"
  | "resourceRefProjectIdRequired"
  | "resourceRefMessageIdNotAllowed"
  | "tooManyMentionedUsers"
  | "tooManyMentionedAgents"
  | "tooManyReactionEmoji"
  | "duplicateReaction"
  | "historyPageTooLarge"
  | "duplicateClientMutationId"
  | "agentHopDepthExceeded";

export type MessagingValidationError = {
  code: MessagingValidationErrorCode;
  path: string;
  message: string;
  limit?: number;
  actual?: number;
};

export type MessagingValidationResult = {
  valid: boolean;
  errors: MessagingValidationError[];
};

export type RichCommentBodyValidationContext = {
  resourceRefs: readonly ResourceRef[];
  deliveryHints?: {
    mentionedUserIds: readonly string[];
    mentionedAgentSessionIds: readonly string[];
  };
};

export type ReactionEntry = {
  emoji: string;
  userId: string;
};

/** Shared across every byte-length measurement below; TextEncoder is stateless. */
const utf8Encoder = new TextEncoder();

function validationResult(
  errors: MessagingValidationError[]
): MessagingValidationResult {
  return { valid: errors.length === 0, errors };
}

function encodedByteLength(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined
      ? null
      : utf8Encoder.encode(encoded).byteLength;
  } catch {
    return null;
  }
}

export function validateRichCommentBody(
  body: RichCommentBody,
  context?: RichCommentBodyValidationContext
): MessagingValidationResult {
  const envelopeBytes = encodedByteLength(body);
  if (envelopeBytes === null) {
    return validationResult([
      {
        code: "richBodyNotSerializable",
        path: "body",
        message: "Rich comment body must be JSON serializable.",
      },
    ]);
  }

  const errors: MessagingValidationError[] = [];
  const textBytes = utf8Encoder.encode(body.text).byteLength;
  if (textBytes > MAX_RICH_COMMENT_TEXT_BYTES) {
    errors.push({
      code: "richBodyTooLarge",
      path: "body.text",
      message: `Rich comment body text must not exceed ${MAX_RICH_COMMENT_TEXT_BYTES} UTF-8 bytes.`,
      limit: MAX_RICH_COMMENT_TEXT_BYTES,
      actual: textBytes,
    });
  }
  if (envelopeBytes > MAX_RICH_COMMENT_BODY_ENVELOPE_BYTES) {
    errors.push({
      code: "richBodyEnvelopeTooLarge",
      path: "body",
      message: `Rich comment body envelope must not exceed ${MAX_RICH_COMMENT_BODY_ENVELOPE_BYTES} encoded bytes.`,
      limit: MAX_RICH_COMMENT_BODY_ENVELOPE_BYTES,
      actual: envelopeBytes,
    });
  }

  const entities = body.entities;
  if (entities === undefined || entities.length === 0) {
    return validationResult(errors);
  }
  if (body.format === "plainText" && entities.length > 0) {
    errors.push({
      code: "bodyEntitiesNotAllowedInPlainText",
      path: "body.entities",
      message: "plainText bodies cannot contain inline entities.",
    });
  }

  const byteBoundaries = utf8ByteBoundaries(body.text);
  const mentionedUsers = new Set(
    context?.deliveryHints?.mentionedUserIds ?? []
  );
  const mentionedAgents = new Set(
    context?.deliveryHints?.mentionedAgentSessionIds ?? []
  );
  let previous: BodyEntity | undefined;

  entities.forEach((entity, index) => {
    const path = `body.entities[${index}]`;
    const rangeValid =
      Number.isInteger(entity.start) &&
      Number.isInteger(entity.end) &&
      entity.start >= 0 &&
      entity.end > entity.start &&
      entity.end <= textBytes &&
      byteBoundaries.has(entity.start) &&
      byteBoundaries.has(entity.end);
    if (!rangeValid) {
      errors.push({
        code: "bodyEntityOffsetInvalid",
        path,
        message:
          "Body entity offsets must name a non-empty UTF-8 byte range within body.text.",
      });
    }

    if (previous && entity.start < previous.start) {
      errors.push({
        code: "bodyEntitiesOutOfOrder",
        path,
        message: "Body entities must be ordered by ascending start offset.",
      });
    } else if (previous && entity.start < previous.end) {
      errors.push({
        code: "bodyEntitiesOverlap",
        path,
        message: "Body entities must not overlap.",
      });
    }

    if (
      entity.kind === "resource" &&
      (!Number.isInteger(entity.refIndex) ||
        entity.refIndex < 0 ||
        (context !== undefined &&
          entity.refIndex >= context.resourceRefs.length))
    ) {
      errors.push({
        code: "bodyEntityResourceRefMissing",
        path: `${path}.refIndex`,
        message:
          "Resource body entity refIndex must address this message's resourceRefs.",
        actual: entity.refIndex,
      });
    }
    if (
      entity.kind === "userMention" &&
      context &&
      !mentionedUsers.has(entity.userId)
    ) {
      errors.push({
        code: "bodyEntityMentionHintMissing",
        path: `${path}.userId`,
        message:
          "User mention body entity must name an id in deliveryHints.mentionedUserIds.",
      });
    }
    if (
      entity.kind === "agentMention" &&
      context &&
      !mentionedAgents.has(entity.sessionId)
    ) {
      errors.push({
        code: "bodyEntityMentionHintMissing",
        path: `${path}.sessionId`,
        message:
          "Agent mention body entity must name an id in deliveryHints.mentionedAgentSessionIds.",
      });
    }

    previous = entity;
  });

  return validationResult(errors);
}

function utf8ByteBoundaries(text: string): ReadonlySet<number> {
  const boundaries = new Set<number>([0]);
  let byteOffset = 0;
  for (const character of text) {
    byteOffset += utf8Encoder.encode(character).byteLength;
    boundaries.add(byteOffset);
  }
  return boundaries;
}

export function validateResourceRef(
  ref: ResourceRef
): MessagingValidationResult {
  const errors: MessagingValidationError[] = [];
  if (
    (ref.kind === "file" ||
      ref.kind === "commit" ||
      ref.kind === "pullRequest") &&
    !ref.projectId
  ) {
    errors.push({
      code: "resourceRefProjectIdRequired",
      path: "projectId",
      message: `Resource references of kind ${ref.kind} require projectId.`,
    });
  }
  if (ref.kind !== "conversation" && ref.messageId !== undefined) {
    errors.push({
      code: "resourceRefMessageIdNotAllowed",
      path: "messageId",
      message: "messageId is only valid for conversation resource references.",
    });
  }
  return validationResult(errors);
}

export function validateResourceRefs(
  refs: readonly ResourceRef[]
): MessagingValidationResult {
  const errors: MessagingValidationError[] = [];
  if (refs.length > MAX_RESOURCE_REFS_PER_MESSAGE) {
    errors.push({
      code: "tooManyResourceRefs",
      path: "resourceRefs",
      message: `A message may contain at most ${MAX_RESOURCE_REFS_PER_MESSAGE} resource references.`,
      limit: MAX_RESOURCE_REFS_PER_MESSAGE,
      actual: refs.length,
    });
  }
  refs.forEach((ref, index) => {
    for (const error of validateResourceRef(ref).errors) {
      errors.push({ ...error, path: `resourceRefs[${index}].${error.path}` });
    }
  });
  return validationResult(errors);
}

export function validateMentionLimits(
  mentionedUserIds: readonly string[],
  mentionedAgentSessionIds: readonly string[]
): MessagingValidationResult {
  const errors: MessagingValidationError[] = [];
  const distinctUsers = new Set(mentionedUserIds).size;
  const distinctAgents = new Set(mentionedAgentSessionIds).size;
  if (distinctUsers > MAX_MENTIONED_USERS_PER_MESSAGE) {
    errors.push({
      code: "tooManyMentionedUsers",
      path: "deliveryHints.mentionedUserIds",
      message: `A message may mention at most ${MAX_MENTIONED_USERS_PER_MESSAGE} distinct users.`,
      limit: MAX_MENTIONED_USERS_PER_MESSAGE,
      actual: distinctUsers,
    });
  }
  if (distinctAgents > MAX_MENTIONED_AGENTS_PER_MESSAGE) {
    errors.push({
      code: "tooManyMentionedAgents",
      path: "deliveryHints.mentionedAgentSessionIds",
      message: `A message may mention at most ${MAX_MENTIONED_AGENTS_PER_MESSAGE} distinct agent handles.`,
      limit: MAX_MENTIONED_AGENTS_PER_MESSAGE,
      actual: distinctAgents,
    });
  }
  return validationResult(errors);
}

export function validateReactionEntries(
  reactions: readonly ReactionEntry[]
): MessagingValidationResult {
  const errors: MessagingValidationError[] = [];
  const emoji = new Set<string>();
  const userEmoji = new Set<string>();
  reactions.forEach((reaction, index) => {
    emoji.add(reaction.emoji);
    const key = JSON.stringify([reaction.userId, reaction.emoji]);
    if (userEmoji.has(key)) {
      errors.push({
        code: "duplicateReaction",
        path: `reactions[${index}]`,
        message: "A user may react only once per emoji on a message.",
      });
    }
    userEmoji.add(key);
  });
  if (emoji.size > MAX_REACTION_EMOJI_PER_MESSAGE) {
    errors.push({
      code: "tooManyReactionEmoji",
      path: "reactions",
      message: `A message may contain at most ${MAX_REACTION_EMOJI_PER_MESSAGE} distinct reaction emoji.`,
      limit: MAX_REACTION_EMOJI_PER_MESSAGE,
      actual: emoji.size,
    });
  }
  return validationResult(errors);
}
