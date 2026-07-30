/**
 * Renderer-local types for the shared comment renderer and composer.
 *
 * The wire contracts come from `@nimbalyst/collab-protocol` and are imported,
 * never redefined. Everything declared here is presentation state that has no
 * business on the wire: directory lookups, redacted pill views, and the
 * resolver seam the pills read previews through.
 *
 * NAME COLLISION: the protocol `CommentCapabilities` (seven fields) shares a
 * name with an unrelated two-field type in
 * `packages/runtime/src/editor/commenting/types.ts`. This module re-exports the
 * protocol one, so every file in this directory imports `CommentCapabilities`
 * from here and none of them has to pick a winner between two packages.
 */

import type {
  Actor,
  BodyEntity,
  Comment,
  CommentAdapter,
  CommentCapabilities,
  CommentChange,
  CommentPage,
  CommentRef,
  CreateCommentInput,
  MessageAttachment,
  ReactionAggregate,
  ResourceRef,
  RichCommentBody,
} from '@nimbalyst/collab-protocol';

export type {
  Actor,
  BodyEntity,
  Comment,
  CommentAdapter,
  CommentCapabilities,
  CommentChange,
  CommentPage,
  CommentRef,
  CreateCommentInput,
  MessageAttachment,
  ReactionAggregate,
  ResourceRef,
  RichCommentBody,
};

/** The seven `ResourceRef.kind` values, as a value the UI can iterate. */
export const RESOURCE_KINDS = [
  'tracker',
  'document',
  'session',
  'file',
  'commit',
  'pullRequest',
  'conversation',
] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** A person the viewer may mention. */
export interface PersonHandle {
  userId: string;
  displayName: string;
  /** Typed after `@`; unique within a conversation's roster. */
  handle: string;
  avatarInitials: string;
  /** Optional subtitle in the picker, e.g. "Admin". */
  subtitle?: string;
}

/**
 * A session its owner has attached to this conversation. Attachment is an
 * explicit act by the owner, so a stray mention cannot conscript someone
 * else's session.
 */
export interface AgentHandle {
  sessionId: string;
  sessionName: string;
  handle: string;
  ownerUserId: string;
  ownerDisplayName: string;
}

export interface MentionDirectory {
  people: PersonHandle[];
  agents: AgentHandle[];
  /** Display names for actors and reply parents, keyed by user id. */
  displayNames: Record<string, string>;
}

export const EMPTY_DIRECTORY: MentionDirectory = { people: [], agents: [], displayNames: {} };

/**
 * Conversation-level facts the renderer needs but that are not on a single
 * comment. `agentPostingEnabled` mirrors `ConversationDescriptor`.
 */
export interface ConversationContext {
  conversationId?: string;
  conversationTitle?: string;
  agentPostingEnabled: boolean;
  /** Session ids attached to this conversation by their owners. */
  attachedAgentSessionIds: string[];
  archived?: boolean;
  /** Human label for the surface, used in read-only explanations. */
  surfaceLabel: string;
}

/**
 * What a preview resolver is allowed to return. Availability is the only thing
 * a component ever branches on; the fields carrying source state exist solely
 * on the `available` arm so an unavailable preview has no title to leak, even
 * by accident.
 */
export type ResourcePreviewState =
  | { availability: 'loading' }
  | {
      availability: 'available';
      title: string;
      /** Second line: issue key, path, short sha, PR number, room name. */
      secondary?: string;
      /** Status/state chip text, e.g. "In review", "Merged", "Archived". */
      state?: string;
    }
  /** Source deleted, or the reader's access was removed. */
  | { availability: 'unavailable' }
  /** file/commit/pullRequest only: reader lacks the project or the checkout. */
  | { availability: 'notInWorkspace' };

/**
 * The seam every pill resolves through.
 *
 * Implementations must apply the reader's current source access and return
 * `unavailable` rather than a stale cached preview when access was removed.
 */
export interface ResourcePreviewResolver {
  /** Batched. Keyed by the ref's URN (see `resourceRefToUrn`). */
  resolve(refs: readonly ResourceRef[]): Promise<Record<string, ResourcePreviewState>>;
}

/**
 * The seam the composer uploads files through.
 *
 * Absent on a surface that cannot take files -- tracker comments, inline
 * document comments -- and its absence is what removes the affordance and the
 * paste handling, rather than a flag that has to agree with three call sites.
 * A rejection is thrown with a message written for the author to read.
 */
export interface AttachmentComposerHost {
  upload(file: File): Promise<MessageAttachment>;
}

/** An attachable reference offered by the composer's resource picker. */
export interface ResourceCandidate {
  ref: ResourceRef;
  label: string;
  secondary?: string;
}

/** Fully redacted pill state. Components render this and nothing else. */
export interface ResourcePillView {
  urn: string;
  kind: ResourceKind;
  availability: ResourcePreviewState['availability'];
  icon: string;
  /** Primary label. For non-available pills this is a fixed, source-free string. */
  label: string;
  secondary?: string;
  state?: string;
  /** False for loading/unavailable pills, which must not be clickable targets. */
  actionable: boolean;
  /** Tooltip explaining a degraded pill. Never contains source state. */
  hint?: string;
}

/**
 * A resolved attachment, ready to render.
 *
 * `src` is a `collab-asset://` URL the main-process protocol handler serves
 * decrypted, so an image is an ordinary `<img>` and a file is an ordinary link.
 * `isImage` is decided from the declared MIME type against a fixed list rather
 * than trusted wholesale: the type travels in body text that another client
 * wrote, and "render this as an image" is the one decision it must not make.
 */
export interface MessageAttachmentView {
  assetId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  /** Human size, e.g. "1.4 MB". */
  sizeLabel: string;
  isImage: boolean;
  src: string;
  width?: number;
  height?: number;
}

/** One run of a parsed comment body. */
export type BodySegment =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'emphasis'; text: string }
  | { type: 'emoji'; shortcode: string; glyph: string }
  | { type: 'mention'; userId: string; displayName: string; initials: string; isViewer: boolean }
  | { type: 'agentMention'; sessionId: string; sessionName: string; ownerDisplayName?: string }
  | { type: 'resource'; pill: ResourcePillView }
  /**
   * The message's files, as one trailing block rather than inline runs.
   *
   * Modelled as a segment so every existing consumer -- the row, the reply
   * snippet, the inbox preview -- picks attachments up without a second
   * channel to thread through. There is at most one, and it is always last.
   */
  | { type: 'attachments'; attachments: MessageAttachmentView[] };

export interface ActorView {
  kind: 'user' | 'agent';
  displayName: string;
  initials: string;
  sessionId?: string;
  sessionName?: string;
  ownerDisplayName?: string;
  isViewer: boolean;
}

/** The one displayed level of reply context. Never recursive. */
export interface ReplyParentView {
  commentId: string;
  /** Absent when the parent is unavailable or deleted. */
  actorLabel?: string;
  snippet?: string;
  unavailableLabel?: string;
}

export type CommentActionKind = 'reply' | 'edit' | 'delete' | 'copyLink';

export interface CommentView {
  key: string;
  ref: CommentRef;
  /** `nimbalyst://conversation/<id>/message/<messageId>`, or null off-conversation. */
  messageUrn: string | null;
  actor: ActorView;
  timestampLabel: string;
  timestampTitle: string;
  editedLabel?: string;
  editedTitle?: string;
  deleted: boolean;
  deletedLabel?: string;
  segments: BodySegment[];
  reactions: ReactionAggregate[];
  /** False when the adapter omits `react`; the affordance is absent, not disabled. */
  reactionsSupported: boolean;
  canReact: boolean;
  actions: CommentActionKind[];
  replyParent?: ReplyParentView;
  /** Optimistic local send, or an agent post awaiting its session. */
  pending?: boolean;
  pendingLabel?: string;
  failed?: boolean;
}

/** Compact source-owned domain change. Never used for comments. */
export interface ActivityView {
  key: string;
  icon: string;
  actorLabel: string;
  summary: string;
  timestampLabel: string;
  timestampTitle: string;
  /** Set when this activity row mirrors a comment that is already rendered. */
  correlatedCommentId?: string;
}

export type TimelineEntry =
  | { kind: 'comment'; comment: CommentView }
  | { kind: 'activity'; activity: ActivityView };

/** Why the composer is read-only, stated rather than silently hidden. */
export interface ComposerRestriction {
  title: string;
  detail: string;
  icon: string;
}
