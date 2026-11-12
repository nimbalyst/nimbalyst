/**
 * One comment thread: its anchor line, its comments, and the affordances that
 * act on it.
 *
 * The card knows nothing about how the thread is attached to the document. It
 * is handed an anchor state and a label; whether that came from a Lexical
 * MarkNode, a mockup element id, or a graph node is the owning editor's
 * business. A thread whose anchor is gone renders exactly as loudly as one
 * that is attached — the history is the point, and it is never hidden or
 * deleted because the target disappeared.
 */

import type { JSX, KeyboardEvent, Ref } from 'react';
import { useCallback, useRef } from 'react';

import type { Comment, Thread } from '../types';
import { CommentActorLabel, commentActorName } from './CommentActorLabel';
import { CommentComposer } from './CommentComposer';
import type {
  CommentAnchorState,
  CommentMember,
  CommentThreadActions,
} from './types';

function formatTimestamp(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function replyTargetName(thread: Thread, comment: Comment): string {
  const target = thread.comments.find(
    (candidate) => candidate.id === comment.replyToCommentId,
  );
  return target ? commentActorName(target) : 'an earlier comment';
}

const DETACHED_EXPLANATION: Record<
  Exclude<CommentAnchorState, 'attached'>,
  string
> = {
  orphaned:
    'What this comment was on is no longer in the document. The conversation is kept.',
  unsupported:
    'This comment is anchored to something this editor does not understand, likely written by a newer version. The conversation is kept.',
};

/** Accessible name for the card, so the list is navigable without sight. */
function threadAccessibleLabel(
  thread: Thread,
  anchorState: CommentAnchorState,
  anchorLabel: string,
): string {
  const count = thread.comments.length;
  const parts = [
    `Comment thread on ${anchorLabel || 'this document'}`,
    `${count} ${count === 1 ? 'comment' : 'comments'}`,
  ];
  if (thread.resolved) parts.push('resolved');
  if (anchorState !== 'attached') parts.push('detached');
  return parts.join(', ');
}

export interface CommentThreadCardProps extends CommentThreadActions {
  thread: Thread;
  /** Defaults to `attached`. */
  anchorState?: CommentAnchorState;
  /** Falls back to `thread.quote`. */
  anchorLabel?: string;
  isActive: boolean;
  /** False for a read-only viewer: reading stays, authoring disappears. */
  canComment: boolean;
  /**
   * Resolve, reopen and delete of the whole thread. Defaults to `canComment`;
   * a commenter gets it only on threads they started.
   */
  canManageThread?: boolean;
  /**
   * Delete of the whole thread. Defaults to `canManageThread`; a commenter
   * only when every comment in it is theirs.
   */
  canDeleteThread?: boolean;
  /** Per-comment delete. Defaults to `canComment`; a commenter's own only. */
  canDeleteComment?(comment: Comment): boolean;
  getMembers(): CommentMember[];
  /** Set by the panel's roving tabindex; defaults to focusable. */
  tabIndex?: number;
  cardRef?: Ref<HTMLDivElement>;
  /** Composer autofocus, for a thread the user just created. */
  autoFocusComposer?: boolean;
}

export function CommentThreadCard({
  thread,
  anchorState = 'attached',
  anchorLabel,
  isActive,
  canComment,
  canManageThread = canComment,
  canDeleteThread = canManageThread,
  canDeleteComment = () => canComment,
  getMembers,
  tabIndex = 0,
  cardRef,
  autoFocusComposer = false,
  onSelectThread,
  onSetThreadResolved,
  onDeleteThread,
  onDeleteComment,
  onReply,
  onOpenAgentSession,
}: CommentThreadCardProps): JSX.Element {
  const localRef = useRef<HTMLDivElement | null>(null);
  const label = anchorLabel ?? thread.quote;
  const isDetached = anchorState !== 'attached';
  const isEmpty = thread.comments.length === 0;

  const select = useCallback(
    () => onSelectThread(thread.id),
    [onSelectThread, thread.id],
  );

  // Cancelling a reply hands focus back to the card so keyboard users are not
  // dropped onto <body>. Cancelling an empty thread deletes it, and the panel
  // takes focus from there.
  const handleComposerCancel = useCallback(() => {
    if (isEmpty) {
      onDeleteThread(thread);
      return;
    }
    localRef.current?.focus();
  }, [isEmpty, onDeleteThread, thread]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select();
      }
    },
    [select],
  );

  return (
    <div
      ref={(element) => {
        localRef.current = element;
        if (typeof cardRef === 'function') cardRef(element);
        else if (cardRef) {
          (cardRef as { current: HTMLDivElement | null }).current = element;
        }
      }}
      className={
        'nim-comment-thread' +
        (isActive ? ' active' : '') +
        (thread.resolved ? ' resolved' : '') +
        (isDetached ? ' detached' : '')
      }
      data-testid="comment-thread"
      data-thread-id={thread.id}
      data-resolved={thread.resolved ? 'true' : 'false'}
      data-anchor-state={anchorState}
      role="listitem"
      tabIndex={tabIndex}
      aria-current={isActive ? 'true' : undefined}
      aria-label={threadAccessibleLabel(thread, anchorState, label)}
      onClick={select}
      onKeyDown={handleKeyDown}
    >
      <div className="nim-comment-quote" title={label}>
        {thread.resolved && (
          <span className="nim-comment-resolved-badge" title="Resolved">
            <span className="material-symbols-outlined">check_circle</span>
          </span>
        )}
        {label || '(no quote)'}
      </div>

      {isDetached && (
        <div className="nim-comment-detached-notice" data-testid="comment-thread-detached">
          <span className="material-symbols-outlined">link_off</span>
          <span>{DETACHED_EXPLANATION[anchorState]}</span>
        </div>
      )}

      {thread.resolved ? (
        // Resolved threads collapse to a dimmed summary with an Unresolve
        // affordance; comments and the reply composer are hidden until the
        // thread is reopened.
        <div
          className="nim-comment-thread-footer"
          onClick={(event) => event.stopPropagation()}
        >
          <span className="nim-comment-resolved-summary">
            {thread.comments.length}{' '}
            {thread.comments.length === 1 ? 'comment' : 'comments'}
            {' · Resolved'}
          </span>
          {canManageThread && (
            <>
              <button
                type="button"
                className="nim-comment-btn nim-comment-btn-unresolve"
                onClick={(event) => {
                  event.stopPropagation();
                  onSetThreadResolved(thread, false);
                }}
              >
                Unresolve
              </button>
              {canDeleteThread && (
                <button
                  type="button"
                  className="nim-comment-btn nim-comment-btn-delete-thread"
                  title="Delete thread"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteThread(thread);
                  }}
                >
                  Delete
                </button>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          {thread.comments.map((comment) => (
            <div key={comment.id} className="nim-comment" data-comment-id={comment.id}>
              <div className="nim-comment-meta">
                <CommentActorLabel
                  comment={comment}
                  onOpenAgentSession={onOpenAgentSession}
                />
                <span className="nim-comment-time">
                  {formatTimestamp(comment.timeStamp)}
                </span>
                {canDeleteComment(comment) && (
                  <button
                    type="button"
                    className="nim-comment-delete"
                    title="Delete comment"
                    aria-label={`Delete comment by ${commentActorName(comment)}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteComment(comment, thread);
                    }}
                  >
                    <span className="material-symbols-outlined">delete</span>
                  </button>
                )}
              </div>
              {comment.replyToCommentId && (
                <div className="nim-comment-reply-target">
                  Replying to {replyTargetName(thread, comment)}
                </div>
              )}
              <div className="nim-comment-content">{comment.content}</div>
            </div>
          ))}
          {canComment && (
            <div
              className="nim-comment-thread-footer"
              onClick={(event) => event.stopPropagation()}
            >
              <CommentComposer
                getMembers={getMembers}
                submitLabel={isEmpty ? 'Comment' : 'Reply'}
                placeholder={
                  isEmpty ? 'Add a comment... use @ to mention' : 'Reply...'
                }
                label={
                  isEmpty
                    ? `Comment on ${label || 'this document'}`
                    : `Reply to the thread on ${label || 'this document'}`
                }
                autoFocus={isEmpty && autoFocusComposer}
                onSubmit={(text, mentioned) => onReply(thread, text, mentioned)}
                onCancel={handleComposerCancel}
              />
              {canManageThread && (
                <>
                  <button
                    type="button"
                    className="nim-comment-btn nim-comment-btn-resolve"
                    onClick={(event) => {
                      event.stopPropagation();
                      onSetThreadResolved(thread, true);
                    }}
                  >
                    Resolve
                  </button>
                  {canDeleteThread && (
                    <button
                      type="button"
                      className="nim-comment-btn nim-comment-btn-delete-thread"
                      title="Delete thread"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteThread(thread);
                      }}
                    >
                      Delete
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
