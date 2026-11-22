/**
 * Resolving a host's document-comment capabilities.
 *
 * `CommentsConfig.getCapabilities` is optional, and an absent resolver means
 * "this host does not model per-document comment access" -- not "commenting is
 * forbidden". Every desktop host either answers `{ read: true, comment: true }`
 * or omits the resolver entirely, because reaching a mounted collaborative
 * editor there already implies write authorization. Defaulting closed would
 * silently remove the comment UI from those hosts, so the default is open.
 *
 * A host that *does* answer is authoritative, `false` included. That is the
 * seam the web console needs: its org `viewer` and `guest` roles are rejected
 * server-side (`document_comment_forbidden`), so an authoring affordance shown
 * to them writes into the Y.Doc and loses the thread on reload.
 *
 * Never cache the result. Access can be revoked mid-session while the config
 * object carrying the resolver keeps its identity, so a value memoized on that
 * identity would leave the gate decorative exactly when it matters.
 */

import type { Comment, CommentCapabilities, CommentsConfig, Thread } from './types';

/** Applied when the host supplies no `getCapabilities` resolver. */
export const DEFAULT_COMMENT_CAPABILITIES: CommentCapabilities = {
  read: true,
  comment: true,
};

type CapabilitySource = Pick<CommentsConfig, 'getCapabilities'>;

export function resolveCommentCapabilities(
  config: CapabilitySource | undefined,
): CommentCapabilities {
  return config?.getCapabilities?.() ?? DEFAULT_COMMENT_CAPABILITIES;
}

/**
 * Whether the current user may author comments. Call at render time *and*
 * again at mutation time; see the caching note above.
 */
export function canAuthorComments(config: CapabilitySource | undefined): boolean {
  return resolveCommentCapabilities(config).comment;
}

/** `editBody` absent means true; only an explicit `false` locks the body. */
export function canEditBody(capabilities: CommentCapabilities): boolean {
  return capabilities.editBody !== false;
}

/**
 * Whether the current user may change the document body. Same caching rule as
 * `canAuthorComments`: resolve at render time and again before any write.
 */
export function canEditCommentedBody(
  config: CapabilitySource | undefined,
): boolean {
  return canEditBody(resolveCommentCapabilities(config));
}

/**
 * Commenter mode: may comment, may not touch the body. Threads are stored
 * quote-anchored without a MarkNode, since a MarkNode is a write to `root`.
 */
export function isCommentOnly(config: CapabilitySource | undefined): boolean {
  const capabilities = resolveCommentCapabilities(config);
  return capabilities.comment && !canEditBody(capabilities);
}

/** Whether `comment` was written by the user `currentUserId`. */
function isOwnComment(comment: Comment | undefined, currentUserId: string | undefined): boolean {
  return (
    currentUserId !== undefined &&
    comment?.actor?.kind === 'user' &&
    comment.actor.userId === currentUserId
  );
}

/**
 * Whether the current user may resolve or reopen `thread`. Anyone who can
 * comment and edit the body may. A commenter may only for a thread they
 * started: the room owns a thread by its first comment's author and refuses,
 * terminally, a commenter's change to anyone else's. An empty thread has no
 * owner.
 */
export function canManageCommentThread(
  capabilities: CommentCapabilities,
  currentUserId: string | undefined,
  thread: Thread,
): boolean {
  if (!capabilities.comment) return false;
  if (canEditBody(capabilities)) return true;
  return isOwnComment(thread.comments[0], currentUserId);
}

/** Whether the current user may delete `comment`; a commenter only their own. */
export function canDeleteThreadComment(
  capabilities: CommentCapabilities,
  currentUserId: string | undefined,
  comment: Comment,
): boolean {
  if (!capabilities.comment) return false;
  if (canEditBody(capabilities)) return true;
  return isOwnComment(comment, currentUserId);
}

/**
 * Whether the current user may delete `thread` outright. A commenter may only
 * when every comment in it is theirs: removing the thread removes each reply
 * with it, and the room refuses a commenter's removal of another person's
 * comment. An own thread with someone else's reply can still be resolved.
 */
export function canDeleteCommentThread(
  capabilities: CommentCapabilities,
  currentUserId: string | undefined,
  thread: Thread,
): boolean {
  if (!canManageCommentThread(capabilities, currentUserId, thread)) return false;
  if (canEditBody(capabilities)) return true;
  return thread.comments.every((comment) => isOwnComment(comment, currentUserId));
}
