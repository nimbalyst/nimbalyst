/**
 * Document-comment notification producer.
 *
 * Document comments live in the shared document's Y.Doc, so no server-side
 * event exists for the org inbox to fan out from — the authoring client has to
 * announce mentions and replies over its existing team connection. This is the
 * single producer for that lane, shared by the mounted collaborative editor and
 * the headless (IPC/MCP) comment controller so the two never drift.
 *
 * Nothing here is authoritative. The TeamRoom re-derives the author from the
 * team JWT, intersects the recipients with the live roster, and each
 * TeamInboxRoom makes the final `receiveNotification` decision. Delivery is
 * idempotent per `(recipient, commentId)`, so a duplicate call is harmless.
 */
import type {
  CommentMentionPayload,
  CommentReplyPayload,
} from '@nimbalyst/runtime/editor';

import { getTeamSyncProviderForScopeKey } from '../store/atoms/collabDocuments';

export interface DocumentCommentNotification {
  workspacePath: string;
  documentId: string;
  reason: 'mention' | 'reply';
  /** Already excludes the author. */
  recipientUserIds: string[];
  payload: CommentMentionPayload | CommentReplyPayload;
}

export function notifyDocumentCommentRecipients(
  input: DocumentCommentNotification,
): void {
  if (input.recipientUserIds.length === 0) return;

  const commentId = input.payload.commentId;
  if (!commentId) {
    // The comment id is the server's idempotency key; without one a retry
    // would duplicate the recipient's inbox row, so drop it loudly instead.
    console.warn(
      '[documentCommentNotifier] Skipping notification without a comment id',
      input.documentId,
      input.reason,
    );
    return;
  }

  const teamProvider = getTeamSyncProviderForScopeKey(input.workspacePath);
  if (!teamProvider) {
    console.warn(
      '[documentCommentNotifier] No team connection for workspace; mention not routed',
      input.workspacePath,
    );
    return;
  }

  const preview = {
    ...(input.payload.actorName ? { actorLabel: input.payload.actorName } : {}),
    ...(input.payload.sourceTitle
      ? { sourceTitle: input.payload.sourceTitle }
      : {}),
    ...(input.payload.snippet ? { snippet: input.payload.snippet } : {}),
  };

  teamProvider.notifyDocumentComment({
    documentId: input.documentId,
    commentId,
    ...(input.payload.threadId ? { threadId: input.payload.threadId } : {}),
    reason: input.reason,
    recipientUserIds: input.recipientUserIds,
    ...(Object.keys(preview).length > 0 ? { preview } : {}),
  });
}
