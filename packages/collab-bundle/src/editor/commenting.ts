import type { CommentCapabilities } from '@nimbalyst/runtime/editor/commenting/types';

import type {
  CollabEditorConnectionState,
  CollabEditorServerAccess,
} from './types';

export interface CollabEditorCommentsState {
  hasConnectedOnce: boolean;
  isHydrated: boolean;
  capabilities: CommentCapabilities;
}

export interface DocumentCommentAccessInput {
  orgId?: string | null;
  projectId?: string | null;
}

export type DocumentCommentAccessCheck = (input: DocumentCommentAccessInput & {
  action: 'view' | 'edit' | 'admin';
}) => Promise<{ allowed: boolean }>;

/**
 * Resolve the desktop host's comment capability without borrowing edit access.
 * Project view is the platform permission for reading and annotating a mockup;
 * editing its HTML remains a separate action.
 */
export async function resolveDocumentCommentCapabilities(
  canAccess: DocumentCommentAccessCheck,
  input: DocumentCommentAccessInput,
): Promise<CommentCapabilities> {
  const readAccess = await canAccess({ ...input, action: 'view' });
  return {
    read: readAccess.allowed,
    comment: readAccess.allowed,
  };
}

/**
 * Whether this user may author comments, from the two facts that decide it.
 *
 * The host's role-derived answer is the grant, and a server verdict that
 * refuses writes is the veto.
 *
 * This deliberately does *not* require positive write evidence from the
 * transport. `serverAccess` only reaches 'writable' when the server
 * acknowledges a `docUpdate`, and the server emits that ack in no other
 * circumstance -- so demanding it made commenting conditional on having first
 * edited the document. Opening a shared document purely to annotate it, which
 * is the whole point of the comment panel, was unreachable for every browser
 * user regardless of role.
 *
 * The residual risk is a host projection that has gone stale: an org `member`
 * whose project grant was downgraded is offered an affordance the server will
 * refuse. That is bounded and self-correcting rather than silent -- the refusal
 * arrives as `document_read_only`, which moves `serverAccess` to 'read-only'
 * and withdraws the affordance here. A room verdict of `canWrite: false,
 * canComment: true` ('comment-only') keeps commenting and locks the body. The two roles that must never reach it,
 * `viewer` and `guest`, are refused by the host answer itself and never depend
 * on the veto.
 */
export function deriveCollabEditorCommentsState(options: {
  connection: CollabEditorConnectionState;
  serverAccess: CollabEditorServerAccess;
  hasConnectedOnce: boolean;
  /** The host's role-derived answer; see `CollabEditorCommentsOptions.canComment`. */
  hostCanComment: boolean;
  /**
   * The host's body-edit answer; see `CollabEditorCommentsOptions.canEditBody`.
   * Omitted means permitted.
   */
  hostCanEditBody?: boolean;
}): CollabEditorCommentsState {
  const hasConnectedOnce = options.hasConnectedOnce || options.connection === 'connected';
  const serverRefusesWrites = options.serverAccess === 'read-only'
    || options.serverAccess === 'revoked';
  // A commenter verdict from the room and a host commenter answer are each
  // enough to lock the body: the most restrictive answer wins. The room's
  // verdict also covers a commenter the host's roster cannot see.
  const serverRefusesBody = serverRefusesWrites || options.serverAccess === 'comment-only';
  return {
    hasConnectedOnce,
    isHydrated: hasConnectedOnce,
    capabilities: {
      read: true,
      comment: options.hostCanComment && !serverRefusesWrites,
      editBody: (options.hostCanEditBody ?? true) && !serverRefusesBody,
    },
  };
}
