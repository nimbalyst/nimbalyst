/**
 * The redaction and capability layer.
 *
 * Every rule that decides "may the reader see this" or "may the reader do this"
 * lives here, and the components below render only what comes out. Two
 * invariants hold this together:
 *
 *   1. No component receives a `ResourcePreviewState`. It receives a
 *      `ResourcePillView`, and the unavailable arm of that view has no field
 *      that could carry a title, participant, status, or former state.
 *   2. No component reads `Comment.capabilities` directly. It receives the
 *      resolved `actions` list. Renderer visibility is a usability affordance,
 *      never the security boundary -- the server re-checks every mutation.
 */

import {
  MAX_MENTIONED_AGENTS_PER_MESSAGE,
  MAX_MENTIONED_USERS_PER_MESSAGE,
  MAX_RESOURCE_REFS_PER_MESSAGE,
  MAX_RICH_COMMENT_TEXT_BYTES,
  validateMentionLimits,
  validateResourceRefs,
  validateRichCommentBody,
  type MessagingValidationError,
  type ReactionEntry,
} from '@nimbalyst/collab-protocol';

import { initialsFor, parseCommentBody, segmentsToPlainText } from './commentBodyParser';
import { resourceRefToUrn, messageUrn } from './resourceUrn';
import type {
  ActorView,
  AgentHandle,
  Comment,
  CommentActionKind,
  CommentCapabilities,
  CommentView,
  ComposerRestriction,
  ConversationContext,
  MentionDirectory,
  PersonHandle,
  ReactionAggregate,
  ReplyParentView,
  ResourceKind,
  ResourcePillView,
  ResourcePreviewState,
  ResourceRef,
  RichCommentBody,
} from './commentTypes';
import { EMPTY_DIRECTORY } from './commentTypes';

/* -------------------------------------------------------------------------- */
/* Pills                                                                       */
/* -------------------------------------------------------------------------- */

const KIND_ICON: Record<ResourceKind, string> = {
  tracker: 'confirmation_number',
  document: 'description',
  session: 'smart_toy',
  file: 'draft',
  commit: 'commit',
  pullRequest: 'call_merge',
  conversation: 'forum',
};

const KIND_LABEL: Record<ResourceKind, string> = {
  tracker: 'Tracker item',
  document: 'Document',
  session: 'Session',
  file: 'File',
  commit: 'Commit',
  pullRequest: 'Pull request',
  conversation: 'Conversation',
};

/** Kinds that can degrade to "Not in your workspace" rather than "Unavailable". */
const WORKSPACE_SCOPED: ReadonlySet<ResourceKind> = new Set<ResourceKind>(['file', 'commit', 'pullRequest']);

/**
 * The single redaction point for resource previews.
 *
 * `unavailable` deliberately produces a pill with no `secondary`, no `state`,
 * and a fixed label. The reader learns that a link existed and that they cannot
 * follow it, and nothing else -- not the title, not the participants, not the
 * status it used to have. A resolver that leaks by putting a title on the
 * unavailable arm cannot: the type has no such field.
 */
export function toPillView(ref: ResourceRef, state: ResourcePreviewState | undefined): ResourcePillView {
  const kind = ref.kind as ResourceKind;
  const urn = resourceRefToUrn(ref);
  const availability = state?.availability ?? 'loading';

  if (availability === 'available' && state && state.availability === 'available') {
    return {
      urn,
      kind,
      availability,
      icon: KIND_ICON[kind],
      label: state.title,
      secondary: state.secondary,
      state: state.state,
      actionable: true,
    };
  }

  if (availability === 'notInWorkspace' && WORKSPACE_SCOPED.has(kind)) {
    // The reader already holds the ref itself -- it arrived inside a body they
    // are authorized to read -- so echoing its own identity leaks nothing new.
    // The resolver's title is still withheld: that would be source state.
    return {
      urn,
      kind,
      availability,
      icon: KIND_ICON[kind],
      label: localRefIdentity(ref),
      secondary: 'Not in your workspace',
      actionable: false,
      hint: `This ${KIND_LABEL[kind].toLowerCase()} belongs to a project you do not have open.`,
    };
  }

  if (availability === 'loading') {
    return { urn, kind, availability, icon: KIND_ICON[kind], label: 'Loading', actionable: false };
  }

  return {
    urn,
    kind,
    availability: 'unavailable',
    icon: 'lock',
    label: 'Unavailable',
    actionable: false,
    hint: 'You do not have access to this, or it no longer exists.',
  };
}

/** Client-derivable identity for a workspace-scoped ref. Never resolver data. */
function localRefIdentity(ref: ResourceRef): string {
  switch (ref.kind) {
    case 'file': {
      const parts = ref.sourceId.split('/');
      return parts[parts.length - 1] || ref.sourceId;
    }
    case 'commit':
      return ref.sourceId.slice(0, 8);
    case 'pullRequest':
      return `#${ref.sourceId}`;
    default:
      return ref.sourceId;
  }
}

export function buildPillViews(
  refs: readonly ResourceRef[],
  previews: Record<string, ResourcePreviewState>,
): Record<string, ResourcePillView> {
  const out: Record<string, ResourcePillView> = {};
  for (const ref of refs) {
    const urn = resourceRefToUrn(ref);
    out[urn] = toPillView(ref, previews[urn]);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Capabilities                                                                */
/* -------------------------------------------------------------------------- */

export interface ResolveActionsInput {
  capabilities: CommentCapabilities;
  /** True when the viewer authored it, or owns the agent session that did. */
  own: boolean;
  deleted: boolean;
  hasMessageUrn: boolean;
}

/**
 * Capability -> action list.
 *
 * `moderate` grants delete on other people's comments but never edit: editing
 * someone else's words under their name is not a moderation power the plan
 * grants, and no capability in the seven-field contract expresses it.
 */
export function resolveActions(input: ResolveActionsInput): CommentActionKind[] {
  const { capabilities: caps, own, deleted, hasMessageUrn } = input;
  const actions: CommentActionKind[] = [];
  if (deleted) {
    // A tombstone has no body to reply to, quote, or edit.
    return actions;
  }
  if (caps.comment) actions.push('reply');
  if (own && caps.editOwn) actions.push('edit');
  if ((own && caps.deleteOwn) || caps.moderate) actions.push('delete');
  if (hasMessageUrn) actions.push('copyLink');
  return actions;
}

/**
 * Why the composer is read-only.
 *
 * Silently hiding the composer is the failure mode this exists to prevent: a
 * user who cannot post should be told which permission is missing, not left to
 * wonder whether the feature loaded.
 */
export function describeComposerRestriction(
  capabilities: CommentCapabilities,
  context: ConversationContext,
): ComposerRestriction | null {
  if (!capabilities.read) {
    return {
      title: 'You do not have access to this conversation',
      detail: 'Ask an organization admin or a room admin to add you.',
      icon: 'lock',
    };
  }
  if (context.archived) {
    return {
      title: `${context.surfaceLabel} is archived`,
      detail: 'Archived conversations are readable but closed to new messages.',
      icon: 'inventory_2',
    };
  }
  if (!capabilities.comment) {
    return {
      title: 'You have read-only access here',
      detail: `Posting needs the "comment" permission on ${context.surfaceLabel}. Your role grants read access only.`,
      icon: 'visibility_lock',
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Reactions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Fold raw per-user reaction entries into the aggregate the row renders.
 *
 * One-per-user-per-emoji is enforced here by construction, not by trusting the
 * caller: a duplicate (user, emoji) pair is counted once. `validateReactionEntries`
 * in the protocol reports the same duplicate as an error for the write path;
 * this is the read path, where the display must stay correct regardless.
 */
export function aggregateReactions(
  entries: readonly ReactionEntry[],
  viewerUserId: string,
): ReactionAggregate[] {
  const order: string[] = [];
  const byEmoji = new Map<string, Set<string>>();
  for (const entry of entries) {
    let users = byEmoji.get(entry.emoji);
    if (!users) {
      users = new Set<string>();
      byEmoji.set(entry.emoji, users);
      order.push(entry.emoji);
    }
    users.add(entry.userId);
  }
  return order.map((emoji) => {
    const users = byEmoji.get(emoji)!;
    return { emoji, count: users.size, reactedByMe: users.has(viewerUserId) };
  });
}

/**
 * Optimistic local fold of a toggle, so the row updates before the adapter
 * round-trips. Adding when already reacted is a no-op, which is what makes the
 * affordance a toggle rather than a counter the user can inflate.
 */
export function toggleReactionAggregate(
  aggregates: readonly ReactionAggregate[],
  emoji: string,
  on: boolean,
): ReactionAggregate[] {
  const existing = aggregates.find((aggregate) => aggregate.emoji === emoji);
  if (!existing) {
    return on ? [...aggregates, { emoji, count: 1, reactedByMe: true }] : [...aggregates];
  }
  if (existing.reactedByMe === on) return [...aggregates];
  const next = aggregates
    .map((aggregate) =>
      aggregate.emoji === emoji
        ? { ...aggregate, count: aggregate.count + (on ? 1 : -1), reactedByMe: on }
        : aggregate,
    )
    .filter((aggregate) => aggregate.count > 0);
  return next;
}

/* -------------------------------------------------------------------------- */
/* Comment view                                                                */
/* -------------------------------------------------------------------------- */

export interface BuildCommentViewContext {
  viewerUserId: string;
  directory: MentionDirectory;
  previews: Record<string, ResourcePreviewState>;
  /** False when the adapter omits `react` -- the affordance is absent, not disabled. */
  reactionsSupported: boolean;
  now: number;
  /** One displayed level of reply context. Never resolved recursively. */
  replyParent?: Comment | null;
  /** True when the parent exists but the reader may not see it. */
  replyParentUnavailable?: boolean;
  pending?: boolean;
  pendingLabel?: string;
  failed?: boolean;
}

export function buildCommentView(comment: Comment, ctx: BuildCommentViewContext): CommentView {
  const directory = ctx.directory ?? EMPTY_DIRECTORY;
  const deleted = comment.deletedAt !== undefined;
  const pills = buildPillViews(comment.resourceRefs ?? [], ctx.previews);

  const segments = deleted
    ? []
    : parseCommentBody(comment.body, {
        resourceRefs: comment.resourceRefs ?? [],
        mentionedUserIds: comment.deliveryHints?.mentionedUserIds ?? [],
        mentionedAgentSessionIds: comment.deliveryHints?.mentionedAgentSessionIds ?? [],
        directory,
        viewerUserId: ctx.viewerUserId,
        pills,
      });

  const actor = buildActorView(comment, directory, ctx.viewerUserId);
  const own = isOwnComment(comment, ctx.viewerUserId);
  const urn = messageUrn(comment.ref);

  return {
    key: `${comment.ref.sourceKind}:${comment.ref.sourceId}:${comment.ref.commentId}`,
    ref: comment.ref,
    messageUrn: urn,
    actor,
    timestampLabel: formatRelativeTime(comment.createdAt, ctx.now),
    timestampTitle: formatAbsoluteTime(comment.createdAt),
    editedLabel: comment.editedAt !== undefined && !deleted ? 'edited' : undefined,
    editedTitle: comment.editedAt !== undefined ? `Edited ${formatAbsoluteTime(comment.editedAt)}` : undefined,
    deleted,
    deletedLabel: deleted ? 'Message deleted' : undefined,
    segments,
    reactions: deleted ? [] : comment.reactions ?? [],
    reactionsSupported: ctx.reactionsSupported && !deleted,
    canReact: ctx.reactionsSupported && !deleted && comment.capabilities.react,
    actions: resolveActions({
      capabilities: comment.capabilities,
      own,
      deleted,
      hasMessageUrn: urn !== null,
    }),
    replyParent: buildReplyParent(comment, ctx, directory),
    pending: ctx.pending,
    pendingLabel: ctx.pendingLabel,
    failed: ctx.failed,
  };
}

/**
 * "Own" means the viewer is accountable for the post: they authored it, or an
 * agent posted it on their behalf. `onBehalfOfUserId` is server-stamped from
 * the JWT, so it is the field to trust for the agent case.
 */
export function isOwnComment(comment: Comment, viewerUserId: string): boolean {
  if (comment.actor.kind === 'agent') return comment.actor.onBehalfOfUserId === viewerUserId;
  return (comment.actor.userId ?? comment.actor.onBehalfOfUserId) === viewerUserId;
}

function buildActorView(comment: Comment, directory: MentionDirectory, viewerUserId: string): ActorView {
  const { actor } = comment;
  const ownerName =
    directory.displayNames[actor.onBehalfOfUserId] ??
    directory.people.find((person) => person.userId === actor.onBehalfOfUserId)?.displayName ??
    'a teammate';

  if (actor.kind === 'agent') {
    const sessionName = actor.sessionName ?? 'Agent session';
    return {
      kind: 'agent',
      displayName: sessionName,
      initials: initialsFor(sessionName),
      sessionId: actor.sessionId,
      sessionName,
      ownerDisplayName: ownerName,
      isViewer: actor.onBehalfOfUserId === viewerUserId,
    };
  }

  const userId = actor.userId ?? actor.onBehalfOfUserId;
  const person = directory.people.find((entry) => entry.userId === userId);
  const displayName = person?.displayName ?? directory.displayNames[userId] ?? 'Unknown member';
  return {
    kind: 'user',
    displayName,
    initials: person?.avatarInitials ?? initialsFor(displayName),
    isViewer: userId === viewerUserId,
  };
}

/**
 * One displayed level only. The parent's own `replyToCommentId` is ignored, so
 * a long chain renders as a flat list with a single line of context each --
 * never a recursive tree.
 */
function buildReplyParent(
  comment: Comment,
  ctx: BuildCommentViewContext,
  directory: MentionDirectory,
): ReplyParentView | undefined {
  if (!comment.replyToCommentId) return undefined;

  if (ctx.replyParentUnavailable || (ctx.replyParent === null && ctx.replyParent !== undefined)) {
    return { commentId: comment.replyToCommentId, unavailableLabel: 'Replying to a message you cannot see' };
  }
  const parent = ctx.replyParent;
  if (!parent) {
    return { commentId: comment.replyToCommentId, unavailableLabel: 'Replying to an earlier message' };
  }
  if (parent.deletedAt !== undefined) {
    return { commentId: comment.replyToCommentId, unavailableLabel: 'Replying to a deleted message' };
  }

  const parentActor = buildActorView(parent, directory, ctx.viewerUserId);
  const parentPills = buildPillViews(parent.resourceRefs ?? [], ctx.previews);
  const snippet = segmentsToPlainText(
    parseCommentBody(parent.body, {
      resourceRefs: parent.resourceRefs ?? [],
      mentionedUserIds: parent.deliveryHints?.mentionedUserIds ?? [],
      mentionedAgentSessionIds: parent.deliveryHints?.mentionedAgentSessionIds ?? [],
      directory,
      viewerUserId: ctx.viewerUserId,
      pills: parentPills,
    }),
  );

  return {
    commentId: comment.replyToCommentId,
    actorLabel: parentActor.displayName,
    snippet: snippet.length > 140 ? `${snippet.slice(0, 139)}…` : snippet,
  };
}

/* -------------------------------------------------------------------------- */
/* Mention picker                                                              */
/* -------------------------------------------------------------------------- */

export type MentionCandidate =
  | { kind: 'person'; person: PersonHandle }
  | { kind: 'agent'; agent: AgentHandle };

/**
 * One `@` produces one list containing both groups.
 *
 * Agent handles are withheld entirely -- not disabled -- when the room's
 * `agentPostingEnabled` is off, and only sessions the owner has explicitly
 * attached to this conversation are offered.
 */
export function mentionCandidates(
  directory: MentionDirectory,
  context: ConversationContext,
  query: string,
  limit = 8,
): MentionCandidate[] {
  const needle = query.trim().toLowerCase();
  const matches = (...fields: (string | undefined)[]) =>
    needle.length === 0 || fields.some((field) => field?.toLowerCase().includes(needle));

  const people: MentionCandidate[] = directory.people
    .filter((person) => matches(person.handle, person.displayName))
    .map((person) => ({ kind: 'person', person }));

  const attached = new Set(context.attachedAgentSessionIds);
  const agents: MentionCandidate[] = context.agentPostingEnabled
    ? directory.agents
        .filter((agent) => attached.has(agent.sessionId))
        .filter((agent) => matches(agent.handle, agent.sessionName, agent.ownerDisplayName))
        .map((agent) => ({ kind: 'agent', agent }))
    : [];

  // People first: mentioning a colleague is the common case, and an agent
  // dispatch is the consequential one, so it should not sit under the cursor
  // by default.
  return [...people, ...agents].slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/* Draft validation                                                            */
/* -------------------------------------------------------------------------- */

export interface DraftState {
  body: RichCommentBody;
  resourceRefs: ResourceRef[];
  mentionedUserIds: string[];
  mentionedAgentSessionIds: string[];
}

export interface DraftValidation {
  errors: MessagingValidationError[];
  canSend: boolean;
  isEmpty: boolean;
  bodyBytes: number;
  bodyBytesLimit: number;
  refCount: number;
  refLimit: number;
  mentionedUserCount: number;
  mentionedUserLimit: number;
  mentionedAgentCount: number;
  mentionedAgentLimit: number;
}

/**
 * Enforce the protocol bounds in the UI.
 *
 * Over-limit input is kept and reported, never truncated: silently dropping the
 * tail of what someone typed is worse than refusing to send it, because the
 * loss is invisible until after the message posts.
 */
export function validateDraft(draft: DraftState): DraftValidation {
  const errors: MessagingValidationError[] = [
    ...validateRichCommentBody(draft.body, {
      resourceRefs: draft.resourceRefs,
      deliveryHints: {
        mentionedUserIds: draft.mentionedUserIds,
        mentionedAgentSessionIds: draft.mentionedAgentSessionIds,
      },
    }).errors,
    ...validateResourceRefs(draft.resourceRefs).errors,
    ...validateMentionLimits(draft.mentionedUserIds, draft.mentionedAgentSessionIds).errors,
  ];

  const isEmpty = draft.body.text.trim().length === 0 && draft.resourceRefs.length === 0;

  return {
    errors,
    canSend: errors.length === 0 && !isEmpty,
    isEmpty,
    bodyBytes: new TextEncoder().encode(draft.body.text).byteLength,
    bodyBytesLimit: MAX_RICH_COMMENT_TEXT_BYTES,
    refCount: draft.resourceRefs.length,
    refLimit: MAX_RESOURCE_REFS_PER_MESSAGE,
    mentionedUserCount: new Set(draft.mentionedUserIds).size,
    mentionedUserLimit: MAX_MENTIONED_USERS_PER_MESSAGE,
    mentionedAgentCount: new Set(draft.mentionedAgentSessionIds).size,
    mentionedAgentLimit: MAX_MENTIONED_AGENTS_PER_MESSAGE,
  };
}

/* -------------------------------------------------------------------------- */
/* Time                                                                        */
/* -------------------------------------------------------------------------- */

export function formatRelativeTime(timestamp: number, now: number): string {
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 45) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatAbsoluteTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
