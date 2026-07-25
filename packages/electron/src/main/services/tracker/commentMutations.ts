/**
 * Author-guarded tracker comment mutations (NIM-360).
 *
 * Comment edit and (soft) delete must be limited to the comment's author. This
 * is the local UX/correctness gate the `tracker-item-update-comment` IPC handler
 * enforces; for shared trackers the server-side permission model (Epic H) stays
 * authoritative. Kept as a pure function so the authorization + LWW-stamp logic
 * is unit-testable without a database or IPC harness.
 */

import type { TrackerIdentity } from '@nimbalyst/runtime';
import { isSameIdentity } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';

/** The mutable subset of a stored comment this helper touches. */
export interface MutableComment {
  id: string;
  authorIdentity?: TrackerIdentity | null;
  body?: string;
  updatedAt?: number | null;
  deleted?: boolean;
  [key: string]: unknown;
}

export type CommentMutation =
  | { kind: 'edit'; body: string }
  | { kind: 'delete' };

export type CommentMutationResult =
  | { ok: true; comments: MutableComment[]; previous: MutableComment; comment: MutableComment }
  | { ok: false; error: string; code: 'not-found' | 'forbidden' | 'invalid' };

/**
 * Apply an author-scoped edit/delete to a comment list. Returns a NEW array on
 * success (callers persist it); never mutates the input. Fails closed: an
 * unknown comment, a non-author actor, or an empty edit body are all rejected.
 */
export function applyCommentMutation(
  comments: MutableComment[],
  commentId: string,
  mutation: CommentMutation,
  actor: TrackerIdentity | null | undefined,
  now: number,
): CommentMutationResult {
  const next = comments.map((c) => ({ ...c }));
  const idx = next.findIndex((c) => c.id === commentId);
  if (idx === -1) {
    return { ok: false, error: 'Comment not found', code: 'not-found' };
  }

  const target = next[idx];
  if (!isSameIdentity(target.authorIdentity ?? null, actor ?? null)) {
    return {
      ok: false,
      error: 'Only the comment author can edit or delete this comment',
      code: 'forbidden',
    };
  }

  const previous = { ...target };

  if (mutation.kind === 'edit') {
    const body = mutation.body?.trim();
    if (!body) {
      return { ok: false, error: 'Comment body cannot be empty', code: 'invalid' };
    }
    target.body = body;
    target.updatedAt = now;
  } else {
    // Soft-delete: body stays for audit; the UI hides deleted comments.
    target.deleted = true;
    target.updatedAt = now;
  }

  return { ok: true, comments: next, previous, comment: target };
}
