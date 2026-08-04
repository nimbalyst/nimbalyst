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
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { TrackerIdentity } from '@nimbalyst/runtime';
import { isSameIdentity } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { getRelativeTimeString } from '../../utils/dateFormatting';
import { invokeTrackerCommentMutation } from './trackerCommentMutation';

export interface TrackerCommentsSectionProps {
  itemId: string;
  comments?: any[];
}

export const TrackerCommentsSection: React.FC<TrackerCommentsSectionProps> = ({ itemId, comments }) => {
  const [newComment, setNewComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Optimistic comments shown immediately on submit, before the atom round-trips
  const [optimisticComments, setOptimisticComments] = useState<any[]>([]);
  // Current user identity, used to gate edit/delete to the comment author (NIM-360).
  const [currentIdentity, setCurrentIdentity] = useState<TrackerIdentity | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [commentError, setCommentError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI
      .invoke('document-service:get-current-identity')
      .then((result: any) => {
        if (cancelled) return;
        if (result?.success && result.identity) setCurrentIdentity(result.identity);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleEditSave = useCallback(async (commentId: string) => {
    const body = editBody.trim();
    if (!body) return;
    setCommentError(null);
    try {
      await invokeTrackerCommentMutation(window.electronAPI.invoke, 'document-service:tracker-item-update-comment', {
        itemId,
        commentId,
        body,
      });
      setEditingId(null);
    } catch (err) {
      console.error('Failed to edit comment:', err);
      setCommentError(err instanceof Error ? err.message : String(err));
    }
  }, [itemId, editBody]);

  const handleDelete = useCallback(async (commentId: string) => {
    setCommentError(null);
    try {
      await invokeTrackerCommentMutation(window.electronAPI.invoke, 'document-service:tracker-item-update-comment', {
        itemId,
        commentId,
        deleted: true,
      });
    } catch (err) {
      console.error('Failed to delete comment:', err);
      setCommentError(err instanceof Error ? err.message : String(err));
    }
  }, [itemId]);

  // When server-side comments arrive (atom update), clear optimistic entries
  // that are now present in the real data.
  const serverComments = (comments || []).filter((c: any) => !c.deleted);
  const visibleComments = useMemo(() => {
    if (optimisticComments.length === 0) return serverComments;
    // Keep only optimistic comments whose body isn't yet in the server list
    // (simple dedup -- optimistic entries don't have real IDs)
    const serverBodies = new Set(serverComments.map((c: any) => c.body));
    const stillPending = optimisticComments.filter(c => !serverBodies.has(c.body));
    if (stillPending.length < optimisticComments.length) {
      // Some optimistic comments were confirmed -- schedule cleanup
      // Use queueMicrotask to avoid setState during render
      queueMicrotask(() => setOptimisticComments(stillPending));
    }
    return [...serverComments, ...stillPending];
  }, [serverComments, optimisticComments]);

  const handleSubmit = useCallback(async () => {
    if (!newComment.trim() || submitting) return;
    const body = newComment.trim();
    setSubmitting(true);
    setCommentError(null);
    // Optimistically show the comment immediately
    setOptimisticComments(prev => [...prev, {
      id: `optimistic_${Date.now()}`,
      body,
      createdAt: Date.now(),
      updatedAt: null,
      deleted: false,
      _optimistic: true,
    }]);
    setNewComment('');
    try {
      await invokeTrackerCommentMutation(window.electronAPI.invoke, 'document-service:tracker-item-add-comment', {
        itemId,
        body,
      });
    } catch (err) {
      console.error('Failed to add comment:', err);
      // Remove the optimistic comment on failure
      setOptimisticComments(prev => prev.filter(c => c.body !== body));
      setNewComment(body);
      setCommentError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [itemId, newComment, submitting]);

  return (
    <div className="tracker-comments-section space-y-2 select-text">
      {visibleComments.map((comment: any) => {
        const isAuthor = !comment._optimistic
          && isSameIdentity(comment.authorIdentity ?? null, currentIdentity);
        const isEditing = editingId === comment.id;
        return (
          <div key={comment.id} className={`tracker-comment group rounded bg-nim-tertiary p-2 space-y-1${comment._optimistic ? ' opacity-70' : ''}`}>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="font-medium text-nim-muted">{comment.authorIdentity?.displayName || 'You'}</span>
              <span className="text-nim-faint">{getRelativeTimeString(comment.createdAt)}</span>
              {comment.updatedAt && <span className="text-nim-faint">(edited)</span>}
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
                    onClick={() => handleDelete(comment.id)}
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
                  className="flex-1 bg-nim-secondary border border-nim rounded px-2 py-1 text-xs text-nim outline-none focus:border-nim-primary"
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
      <div className="flex gap-1">
        <input
          type="text"
          value={newComment}
          onChange={e => setNewComment(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
          placeholder="Add a comment..."
          className="flex-1 bg-nim-secondary border border-nim rounded px-2 py-1 text-xs text-nim placeholder:text-nim-faint outline-none focus:border-nim-primary"
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
      {commentError && (
        <p className="tracker-comment-error m-0 text-xs text-nim-error" role="alert">
          {commentError}
        </p>
      )}
    </div>
  );
};
