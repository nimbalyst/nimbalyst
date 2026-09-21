/**
 * The item's discussion thread (`system.comments` on the tracker row).
 *
 * Extracted from `TrackerItemDetail` so the item view and the document view's
 * right panel render the *same* thread -- two copies would drift, and this is
 * the collaboration surface a teammate expects to find in either place.
 *
 * Distinct from the inline comments anchored to document text: those ride the
 * body Y.Doc (see the tracker-document-mode plan, Layer 1). Same relationship a
 * pull request has between its conversation and its review comments.
 *
 * The thread does not know how a comment is written. Desktop posts over IPC and
 * the browser posts through the tracker data source's optimistic path; both hand
 * in a `mutate` that resolves once the write enters its host mutation path.
 * Immediate failures reject; later room refusals arrive through
 * `mutationRejection`, which retires the matching pending entry after the
 * engine has restored its projection.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { TrackerIdentity } from '@nimbalyst/runtime/core/DocumentService';
import type { TrackerCommentEntry } from '@nimbalyst/runtime/sync/trackerProtocol';
import { isSameIdentity } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import type { TrackerMutationRejection } from '@nimbalyst/collab-client/trackers';
import { formatTrackerMutationRejection } from './TrackerMutationRejectionNotice';

/** A comment awaiting its round trip; carries no server id yet. */
type PendingComment = Pick<TrackerCommentEntry, 'id' | 'body' | 'createdAt'> & {
  pending: true;
  clientMutationId?: string;
};

type DisplayComment = TrackerCommentEntry | PendingComment;

function isPending(comment: DisplayComment): comment is PendingComment {
  return (comment as PendingComment).pending === true;
}

export type TrackerCommentMutation =
  | { kind: 'add'; body: string }
  | { kind: 'update'; commentId: string; body: string }
  | { kind: 'delete'; commentId: string };

export interface TrackerCommentsSectionProps {
  comments?: TrackerCommentEntry[];
  /** Who "me" is; gates edit and delete to the comment's author (NIM-360). */
  identity: TrackerIdentity | null;
  /** Rejects to surface the failure and roll the optimistic entry back. */
  mutate: (mutation: TrackerCommentMutation) => Promise<unknown>;
  formatTimestamp: (createdAt: number) => string;
  /** Suppresses the composer and the per-comment actions. */
  readOnly?: boolean;
  /** Lets an asynchronous server refusal retire the matching optimistic row. */
  mutationRejection?: TrackerMutationRejection | null;
  collapsedComposer?: boolean;
  draft?: string;
  onDraftChange?: (text: string) => void;
}

function clientMutationIdFrom(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const direct = (result as { clientMutationId?: unknown }).clientMutationId;
  if (typeof direct === 'string') return direct;
  return clientMutationIdFrom((result as { result?: unknown }).result);
}

export const TrackerCommentsSection: React.FC<TrackerCommentsSectionProps> = ({
  comments,
  identity,
  mutate,
  formatTimestamp,
  readOnly = false,
  mutationRejection = null,
  collapsedComposer = false,
  draft,
  onDraftChange,
}) => {
  const [localDraft, setLocalDraft] = useState('');
  const newComment = draft ?? localDraft;
  const setNewComment = onDraftChange ?? setLocalDraft;
  const latestDraft = useRef(newComment);
  latestDraft.current = newComment;
  const restoreDraft = useCallback((body: string) => {
    const current = latestDraft.current;
    setNewComment(current && current !== body ? `${body}\n\n${current}` : body);
  }, [setNewComment]);
  const [composerOpen, setComposerOpen] = useState(false);
  const Composer = collapsedComposer ? 'textarea' : 'input';
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<PendingComment[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const serverComments = useMemo(
    () => (comments ?? []).filter((comment) => !comment.deleted),
    [comments],
  );

  // Pending entries have no server id, so they are reconciled by body: once the
  // room echoes the text back, the local copy is redundant.
  const visibleComments = useMemo<DisplayComment[]>(() => {
    if (pending.length === 0) return serverComments;
    const serverBodies = new Set(serverComments.map((comment) => comment.body));
    const stillPending = pending.filter((comment) => !serverBodies.has(comment.body));
    if (stillPending.length < pending.length) {
      queueMicrotask(() => setPending(stillPending));
    }
    return [...serverComments, ...stillPending];
  }, [serverComments, pending]);

  const run = useCallback(async (mutation: TrackerCommentMutation): Promise<{
    accepted: boolean;
    result?: unknown;
  }> => {
    setError(null);
    try {
      return { accepted: true, result: await mutate(mutation) };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return { accepted: false };
    }
  }, [mutate]);

  useEffect(() => {
    const clientMutationId = mutationRejection?.clientMutationId;
    if (!mutationRejection || !clientMutationId) return;
    const rejectedPending = pending.find((comment) => comment.clientMutationId === clientMutationId);
    if (!rejectedPending) return;
    restoreDraft(rejectedPending.body);
    setPending((previous) => previous.filter((comment) => comment.clientMutationId !== clientMutationId));
    setError(formatTrackerMutationRejection(mutationRejection));
  }, [mutationRejection, pending, restoreDraft]);

  const handleSubmit = useCallback(async () => {
    const body = newComment.trim();
    if (!body || submitting) return;
    setSubmitting(true);
    setComposerOpen(true);
    const optimistic: PendingComment = {
      id: `pending_${Date.now()}`,
      body,
      createdAt: Date.now(),
      pending: true,
    };
    setPending((previous) => [...previous, optimistic]);
    setNewComment('');
    const outcome = await run({ kind: 'add', body });
    if (!outcome.accepted) {
      setPending((previous) => previous.filter((comment) => comment.id !== optimistic.id));
      restoreDraft(body);
    } else {
      const clientMutationId = clientMutationIdFrom(outcome.result);
      if (clientMutationId) {
        setPending((previous) => previous.map((comment) => (
          comment.id === optimistic.id ? { ...comment, clientMutationId } : comment
        )));
      }
    }
    setSubmitting(false);
  }, [newComment, run, submitting, setNewComment, restoreDraft]);

  const handleEditSave = useCallback(async (commentId: string) => {
    const body = editBody.trim();
    if (!body) return;
    if ((await run({ kind: 'update', commentId, body })).accepted) setEditingId(null);
  }, [editBody, run]);

  return (
    <div className="tracker-comments-section space-y-2 select-text">
      {visibleComments.map((comment) => {
        const pendingEntry = isPending(comment);
        const isAuthor = !readOnly && !pendingEntry
          && isSameIdentity(comment.authorIdentity ?? null, identity);
        const isEditing = editingId === comment.id;
        return (
          <div
            key={comment.id}
            className={`tracker-comment group rounded bg-nim-tertiary p-2 space-y-1${pendingEntry ? ' opacity-70' : ''}`}
          >
            <div className="flex items-center gap-2 text-[11px]">
              <span className="font-medium text-nim-muted">
                {(!pendingEntry && comment.authorIdentity?.displayName) || 'You'}
              </span>
              <span className="text-nim-faint">{formatTimestamp(comment.createdAt)}</span>
              {!pendingEntry && comment.updatedAt ? <span className="text-nim-faint">(edited)</span> : null}
              {isAuthor && !isEditing && (
                <span className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    className="tracker-comment-edit text-nim-faint hover:text-nim"
                    title="Edit comment"
                    onClick={() => { setEditingId(comment.id); setEditBody(comment.body); }}
                  >
                    <MaterialSymbol icon="edit" size={13} />
                  </button>
                  <button
                    className="tracker-comment-delete text-nim-faint hover:text-nim-error"
                    title="Delete comment"
                    onClick={() => run({ kind: 'delete', commentId: comment.id })}
                  >
                    <MaterialSymbol icon="delete" size={13} />
                  </button>
                </span>
              )}
            </div>
            {isEditing ? (
              <div className="flex gap-1">
                <input
                  type="text"
                  value={editBody}
                  autoFocus
                  onChange={e => setEditBody(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditSave(comment.id); }
                    if (e.key === 'Escape') { setEditingId(null); }
                  }}
                  className="min-w-0 flex-1 bg-nim-secondary border border-nim rounded px-2 py-1 text-xs text-nim outline-none focus:border-nim-primary"
                />
                <button
                  onClick={() => handleEditSave(comment.id)}
                  disabled={!editBody.trim()}
                  className="px-2 py-1 rounded text-xs bg-nim-primary text-nim-on-primary disabled:opacity-40"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditingId(null)}
                  className="px-2 py-1 rounded text-xs text-nim-muted hover:text-nim"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <p className="text-xs text-nim m-0 whitespace-pre-wrap">{comment.body}</p>
            )}
          </div>
        );
      })}
      {readOnly ? null : collapsedComposer && !composerOpen && !newComment ? (
        <button type="button" className="tracker-add-comment" onClick={() => setComposerOpen(true)}>Add comment</button>
      ) : (
        <div className="tracker-comment-composer flex gap-1">
          <Composer
            {...(collapsedComposer ? { rows: 3 } : { type: 'text' })}
            aria-label="Comment"
            value={newComment}
            onChange={e => setNewComment(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && ((!collapsedComposer && !e.shiftKey) || e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSubmit(); } }}
            placeholder="Add a comment..."
            className="min-w-0 flex-1 bg-nim-secondary border border-nim rounded px-2 py-1 text-xs text-nim placeholder:text-nim-faint outline-none focus:border-nim-primary"
            data-testid="tracker-comment-input"
          />
          <button
            onClick={handleSubmit}
            disabled={!newComment.trim() || submitting}
            className="px-2 py-1 rounded text-xs bg-nim-primary text-nim-on-primary disabled:opacity-40 hover:opacity-90 transition-opacity"
          >
            Post
          </button>
        </div>
      )}
      {error && (
        <p className="tracker-comment-error m-0 text-xs text-nim-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};
