import type {
  Actor,
  Comment,
  CommentAdapter,
  CommentCapabilities,
  CommentChange,
  CommentDeliveryHints,
  CommentPage,
  CommentRef,
  ConversationEvent,
  CreateCommentInput,
  ReactionAggregate,
  ResourceRef,
  RichCommentBody,
} from '@nimbalyst/collab-protocol';
import {
  validateMentionLimits,
  validateResourceRefs,
  validateRichCommentBody,
} from '@nimbalyst/collab-protocol';
import type {
  ConversationAppendInput,
  ConversationHistoryPage,
  ConversationTarget,
} from '@nimbalyst/runtime/sync';
import type { Store } from 'jotai/vanilla/store';

import {
  conversationAtomKey,
  conversationStateAtomFamily,
  mergeConversationEvents,
} from '../../store/atoms/conversations';

type Invoke = (channel: string, request: unknown) => Promise<unknown>;

export interface ConversationCommentAdapterConfig extends ConversationTarget {
  sourceKind: Extract<
    CommentRef['sourceKind'],
    'roomMessage' | 'documentDiscussion' | 'dmMessage'
  >;
  viewerActor: Actor;
  capabilities: CommentCapabilities;
  pageSize?: number;
  store: Store;
  invoke?: Invoke;
  createMutationId?: () => string;
}

export function createConversationCommentAdapter(
  config: ConversationCommentAdapterConfig,
): CommentAdapter {
  const targetStore = config.store;
  const stateAtom = conversationStateAtomFamily(conversationAtomKey(config));
  const invoke: Invoke = config.invoke
    ?? ((channel, request) => window.electronAPI.invoke(channel, request));
  const mutationId = config.createMutationId ?? defaultMutationId;

  const mergeEvents = (events: readonly ConversationEvent[]) => {
    if (events.length === 0) return;
    const current = targetStore.get(stateAtom);
    targetStore.set(stateAtom, {
      ...current,
      events: mergeConversationEvents(current.events, events),
    });
  };

  const currentComments = () =>
    materializeConversationComments(
      targetStore.get(stateAtom).events,
      config,
    );

  const append = async (
    input: ConversationAppendInput,
  ): Promise<ConversationEvent> => {
    const result = await invoke('conversation:append', {
      orgId: config.orgId,
      conversationId: config.conversationId,
      input,
    }) as ConversationEvent;
    mergeEvents([result]);
    return result;
  };

  return {
    // Conversation events are already materialized in the store, so a room the
    // window showed a moment ago paints from here on mount rather than waiting
    // out an `conversation:list` round trip against a cache it already has.
    snapshot: currentComments,

    async list(cursor?: string): Promise<CommentPage> {
      const page = await invoke('conversation:list', {
        orgId: config.orgId,
        conversationId: config.conversationId,
        cursor,
        pageSize: config.pageSize,
      }) as ConversationHistoryPage;
      mergeEvents(page.events);
      const createdIds = new Set(
        page.events
          .filter((event) => event.operation === 'messageCreated')
          .map((event) => event.id),
      );
      return {
        comments: currentComments().filter((comment) =>
          createdIds.has(comment.ref.commentId)),
        nextCursor: page.nextCursor,
      };
    },

    async create(input: CreateCommentInput): Promise<Comment> {
      assertValidBody(input.body, input.resourceRefs, input.deliveryHints);
      const event = await append({
        clientMutationId: input.clientMutationId,
        actor: input.actor,
        operation: 'messageCreated',
        payload: {
          body: input.body,
          replyToMessageId: input.replyToCommentId,
          resourceRefs: input.resourceRefs,
        },
        deliveryHints: input.deliveryHints,
      });
      return requireComment(currentComments(), event.id);
    },

    async edit(ref: CommentRef, body: RichCommentBody): Promise<Comment> {
      // An edit is an append like any other, so it gets the same gate the
      // create path does — otherwise a body create refused walks in behind it.
      assertValidBody(body, currentResourceRefs(currentComments(), ref));
      await append({
        clientMutationId: mutationId(),
        actor: config.viewerActor,
        operation: 'messageEdited',
        targetMessageId: ref.commentId,
        payload: { body },
      });
      return requireComment(currentComments(), ref.commentId);
    },

    async remove(ref: CommentRef): Promise<void> {
      await append({
        clientMutationId: mutationId(),
        actor: config.viewerActor,
        operation: 'messageDeleted',
        targetMessageId: ref.commentId,
      });
    },

    async react(ref: CommentRef, emoji: string, on: boolean): Promise<void> {
      await append({
        clientMutationId: mutationId(),
        actor: config.viewerActor,
        operation: on ? 'reactionAdded' : 'reactionRemoved',
        targetMessageId: ref.commentId,
        payload: { emoji },
      });
    },

    subscribe(onChange: (change: CommentChange) => void): () => void {
      let previous = new Map(
        currentComments().map((comment) => [comment.ref.commentId, comment]),
      );
      return targetStore.sub(stateAtom, () => {
        const next = new Map(
          currentComments().map((comment) => [comment.ref.commentId, comment]),
        );
        for (const [id, comment] of next) {
          const before = previous.get(id);
          if (!before) {
            onChange({ type: 'created', comment });
          } else if (!commentsEqual(before, comment)) {
            onChange({ type: 'updated', comment });
          }
        }
        for (const [id, comment] of previous) {
          if (!next.has(id)) {
            onChange({ type: 'removed', ref: comment.ref });
          }
        }
        previous = next;
      });
    },
  };
}

/**
 * Run the protocol's shared body rules before anything leaves the client, so an
 * oversized or malformed body fails here instead of costing a round trip and a
 * server-side protocol error the composer cannot attribute.
 */
function assertValidBody(
  body: RichCommentBody,
  resourceRefs: readonly ResourceRef[] = [],
  deliveryHints?: CommentDeliveryHints,
): void {
  // An edit carries no delivery hints — the server re-derives them from the
  // stored message — so on that path the body's own mention entities stand in
  // for hints this caller cannot know. Every other rule still applies.
  const hints = deliveryHints ?? hintsFromBodyEntities(body);
  const errors = [
    ...validateRichCommentBody(body, {
      resourceRefs,
      deliveryHints: hints,
    }).errors,
    ...validateResourceRefs(resourceRefs).errors,
    ...validateMentionLimits(
      hints.mentionedUserIds,
      hints.mentionedAgentSessionIds,
    ).errors,
  ];
  if (errors.length === 0) return;
  throw new Error(
    `Comment body rejected: ${
      errors.map((error) => `${error.code} at ${error.path}`).join(', ')
    }`,
  );
}

function hintsFromBodyEntities(body: RichCommentBody): CommentDeliveryHints {
  const mentionedUserIds: string[] = [];
  const mentionedAgentSessionIds: string[] = [];
  for (const entity of body.entities ?? []) {
    if (entity.kind === 'userMention') mentionedUserIds.push(entity.userId);
    else if (entity.kind === 'agentMention') {
      mentionedAgentSessionIds.push(entity.sessionId);
    }
  }
  return { mentionedUserIds, mentionedAgentSessionIds, assignedUserIds: [] };
}

/** An edit keeps the message's existing refs, so `refIndex` addresses those. */
function currentResourceRefs(
  comments: readonly Comment[],
  ref: CommentRef,
): ResourceRef[] {
  return comments.find((comment) => comment.ref.commentId === ref.commentId)
    ?.resourceRefs ?? [];
}

export function materializeConversationComments(
  events: readonly ConversationEvent[],
  config: Pick<
    ConversationCommentAdapterConfig,
    | 'orgId'
    | 'conversationId'
    | 'sourceKind'
    | 'viewerActor'
    | 'capabilities'
  >,
): Comment[] {
  const ordered = [...events].sort(
    (left, right) =>
      left.sequence - right.sequence || left.id.localeCompare(right.id),
  );
  const comments = new Map<string, Comment>();
  const creationSequence = new Map<string, number>();
  const reactions = new Map<
    string,
    Map<string, { emoji: string; userId: string }>
  >();

  for (const event of ordered) {
    if (event.operation === 'messageCreated') {
      const body = event.payload?.body;
      if (!body) continue;
      comments.set(event.id, {
        ref: {
          orgId: config.orgId,
          sourceKind: config.sourceKind,
          sourceId: config.conversationId,
          commentId: event.id,
        },
        actor: event.actor,
        body,
        createdAt: event.createdAt,
        replyToCommentId: event.payload?.replyToMessageId,
        resourceRefs: event.payload?.resourceRefs ?? [],
        deliveryHints: event.deliveryHints,
        reactions: [],
        capabilities: capabilitiesFor(event.actor, config),
      });
      creationSequence.set(event.id, event.sequence);
      continue;
    }

    const targetId = event.targetMessageId;
    if (!targetId) continue;
    const current = comments.get(targetId);
    if (
      event.operation === 'reactionAdded'
      || event.operation === 'reactionRemoved'
    ) {
      const emoji = event.payload?.emoji;
      if (!emoji) continue;
      const targetReactions = reactions.get(targetId) ?? new Map();
      const userId = event.actor.onBehalfOfUserId;
      const key = JSON.stringify([userId, emoji]);
      if (event.operation === 'reactionAdded') {
        targetReactions.set(key, { emoji, userId });
      } else {
        targetReactions.delete(key);
      }
      reactions.set(targetId, targetReactions);
      if (current) {
        comments.set(targetId, {
          ...current,
          reactions: aggregateReactionEntries(
            targetReactions.values(),
            config.viewerActor.onBehalfOfUserId,
          ),
        });
      }
      continue;
    }
    if (!current) continue;
    if (event.operation === 'messageEdited') {
      comments.set(targetId, {
        ...current,
        body: event.payload?.body ?? current.body,
        resourceRefs:
          event.payload?.resourceRefs ?? current.resourceRefs,
        deliveryHints: event.deliveryHints ?? current.deliveryHints,
        editedAt: event.createdAt,
      });
    } else if (event.operation === 'messageDeleted') {
      comments.set(targetId, {
        ...current,
        deletedAt: event.createdAt,
      });
    }
  }

  return [...comments.values()].sort(
    (left, right) =>
      (creationSequence.get(left.ref.commentId) ?? 0)
        - (creationSequence.get(right.ref.commentId) ?? 0)
      || left.ref.commentId.localeCompare(right.ref.commentId),
  );
}

function capabilitiesFor(
  actor: Actor,
  config: Pick<
    ConversationCommentAdapterConfig,
    'viewerActor' | 'capabilities'
  >,
): CommentCapabilities {
  const own =
    actor.onBehalfOfUserId === config.viewerActor.onBehalfOfUserId;
  return {
    ...config.capabilities,
    editOwn: own && config.capabilities.editOwn,
    deleteOwn: own && config.capabilities.deleteOwn,
  };
}

function aggregateReactionEntries(
  entries: Iterable<{ emoji: string; userId: string }>,
  viewerUserId: string,
): ReactionAggregate[] {
  const aggregates = new Map<string, ReactionAggregate>();
  for (const entry of entries) {
    const current = aggregates.get(entry.emoji) ?? {
      emoji: entry.emoji,
      count: 0,
      reactedByMe: false,
    };
    aggregates.set(entry.emoji, {
      ...current,
      count: current.count + 1,
      reactedByMe:
        current.reactedByMe || entry.userId === viewerUserId,
    });
  }
  return [...aggregates.values()].sort((left, right) =>
    left.emoji.localeCompare(right.emoji));
}

function requireComment(
  comments: readonly Comment[],
  commentId: string,
): Comment {
  const comment = comments.find((item) => item.ref.commentId === commentId);
  if (!comment) {
    throw new Error(`Conversation event ${commentId} did not materialize`);
  }
  return comment;
}

function commentsEqual(left: Comment, right: Comment): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function defaultMutationId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
