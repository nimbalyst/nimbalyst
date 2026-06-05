/**
 * Public configuration types for the Lexical document-comments feature.
 *
 * The runtime editor is platform-agnostic, so everything it needs to power
 * comments (the shared Y.Doc, the current user, team members for @-mentions,
 * document metadata, and the inbox-fanout callback) is supplied by the host
 * through `EditorConfig.comments`. The electron `CollaborativeTabEditor`
 * populates this from the DocumentSyncProvider + TeamSyncProvider.
 */

import type { Doc } from 'yjs';

/** A team member that can be @-mentioned in a comment. */
export interface CommentMember {
  userId: string;
  /** Display name shown in the mention picker. */
  name: string;
  /**
   * The member's personal org id, required by inbox fanout routing. Members
   * without one (haven't announced yet) can still be mentioned, but won't
   * receive an inbox event until they do.
   */
  personalOrgId?: string | null;
}

/**
 * Decrypted inbox-event payload for a comment `@`-mention. Mirrors
 * `InboxEventPayload` from `@nimbalyst/collab-protocol`; redeclared here so the
 * runtime editor's public config has no protocol dependency.
 */
export interface CommentMentionPayload {
  /** Display name of the comment author. */
  actorName?: string;
  /** Title of the document the comment is on. */
  sourceTitle?: string;
  /** Short excerpt of the comment text. */
  snippet?: string;
  /** Comment thread id. */
  threadId?: string;
  /** MarkNode id anchoring the comment in the document. */
  markId?: string;
  /** Deep-link target (e.g. `collab://org:..:doc:..`). */
  url?: string;
}

/** Host-supplied configuration enabling document comments in the editor. */
export interface CommentsConfig {
  /**
   * Returns the shared Y.Doc the comments live in (the same Y.Doc as the
   * document content; comments are stored under a top-level `comments`
   * YArray). Returns null until the collaboration provider is ready.
   */
  getYDoc: () => Doc | null;
  /** The signed-in user, used as the comment author and mention actor. */
  currentUser: { id: string; name: string };
  /** Team members available to @-mention. Read lazily so the roster stays fresh. */
  getMembers: () => CommentMember[];
  /** Title of the document (used in inbox payloads). */
  documentTitle: string;
  /** Document id within the source org (the inbox event `sourceId`). */
  documentId: string;
  /** `collab://` deep-link URI for the document. */
  documentUri: string;
  /**
   * Called when a submitted comment `@`-mentions one or more members. The host
   * wires this to `TeamSyncProvider.fanoutInboxEvent`. `recipientUserIds`
   * excludes the author. No-op safe when undefined.
   */
  onMention?: (recipientUserIds: string[], payload: CommentMentionPayload) => void;
}
