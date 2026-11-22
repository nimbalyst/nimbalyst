/**
 * The shared collaborative comments panel.
 *
 * Editor-neutral: it is handed thread views and callbacks, and has no idea
 * whether the threads hang off Lexical marks, mockup elements, or graph nodes.
 * The owning editor decides where the panel lives (docked beside a document
 * pane, floating over a canvas) with `className`.
 *
 * Three things here are load-bearing rather than decorative:
 *
 * - **Detached threads keep a home.** Threads whose anchor is gone are grouped
 *   and explained, never filtered out. Losing the target must not lose the
 *   conversation.
 * - **Capabilities are read by the caller on every render.** A read-only
 *   viewer loses the composer and the destructive controls, and keeps every
 *   thread they could already see.
 * - **The list is a real keyboard surface.** Arrow keys move between threads
 *   with a roving tabindex, Escape closes, and focus is handed back to
 *   whatever opened the panel on unmount instead of falling to <body>.
 */

import type { JSX, KeyboardEvent, ReactNode } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import {
  canDeleteCommentThread,
  canDeleteThreadComment,
  canManageCommentThread,
} from '../capabilities';
import { CommentCountBadge } from './CommentCountBadge';
import { CommentThreadCard } from './CommentThreadCard';
import { isDetachedThread } from './types';
import type {
  CommentCapabilities,
  CommentMember,
  CommentThreadActions,
  CommentThreadView,
} from './types';

interface ThreadGroup {
  key: 'open' | 'detached' | 'resolved';
  heading: string | null;
  views: CommentThreadView[];
}

/**
 * Open threads first, then detached ones, then resolved.
 *
 * Anchor state outranks resolution: a detached-and-resolved thread belongs
 * with the rest of the resolved history, because resolving it was a decision
 * someone made and the detachment is no longer actionable.
 */
export function groupCommentThreads(
  views: CommentThreadView[],
  showResolved: boolean,
): ThreadGroup[] {
  const open: CommentThreadView[] = [];
  const detached: CommentThreadView[] = [];
  const resolved: CommentThreadView[] = [];

  for (const view of views) {
    if (view.thread.resolved) resolved.push(view);
    else if (isDetachedThread(view)) detached.push(view);
    else open.push(view);
  }

  const groups: ThreadGroup[] = [{ key: 'open', heading: null, views: open }];
  if (detached.length > 0) {
    groups.push({ key: 'detached', heading: 'Detached', views: detached });
  }
  if (showResolved && resolved.length > 0) {
    groups.push({ key: 'resolved', heading: 'Resolved', views: resolved });
  }
  return groups.filter((group) => group.views.length > 0);
}

export interface CollaborativeCommentsPanelProps extends CommentThreadActions {
  threads: CommentThreadView[];
  activeThreadId: string | null;
  capabilities: CommentCapabilities;
  /**
   * The signed-in user's id, as written in `actor.userId`. A commenter
   * (`editBody: false`) is offered resolve and delete only on their own
   * threads and comments; without it they are offered neither.
   */
  currentUserId?: string;
  getMembers(): CommentMember[];
  title?: string;
  /** Shown when there are no threads at all. */
  emptyMessage?: string;
  /** Extra header content, e.g. an editor-specific filter. */
  headerExtra?: ReactNode;
  onClose?(): void;
  /** Uncontrolled default; resolved threads stay visible unless hidden. */
  defaultShowResolved?: boolean;
  showResolved?: boolean;
  onShowResolvedChange?(next: boolean): void;
  /** Composer autofocus target — the thread the user just created. */
  autoFocusThreadId?: string | null;
  className?: string;
  /** Restore focus to whatever was focused before the panel mounted. */
  restoreFocusOnUnmount?: boolean;
}

export function CollaborativeCommentsPanel({
  threads,
  activeThreadId,
  capabilities,
  currentUserId,
  getMembers,
  title = 'Comments',
  emptyMessage,
  headerExtra,
  onClose,
  defaultShowResolved = true,
  showResolved: controlledShowResolved,
  onShowResolvedChange,
  autoFocusThreadId = null,
  className,
  restoreFocusOnUnmount = true,
  ...actions
}: CollaborativeCommentsPanelProps): JSX.Element {
  const titleId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement | null>());
  const [uncontrolledShowResolved, setUncontrolledShowResolved] =
    useState(defaultShowResolved);
  const showResolved = controlledShowResolved ?? uncontrolledShowResolved;
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);

  const canComment = capabilities.comment;
  const groups = groupCommentThreads(threads, showResolved);
  const ordered = groups.flatMap((group) => group.views);
  const resolvedCount = threads.filter((view) => view.thread.resolved).length;

  // The roving tabindex lands on the active thread when the user tabs in, so
  // arrow keys continue from wherever the document selection already is.
  const rovingThreadId =
    (focusedThreadId &&
      ordered.some((view) => view.thread.id === focusedThreadId) &&
      focusedThreadId) ||
    (activeThreadId &&
      ordered.some((view) => view.thread.id === activeThreadId) &&
      activeThreadId) ||
    ordered[0]?.thread.id ||
    null;

  const setShowResolved = useCallback(
    (next: boolean) => {
      setUncontrolledShowResolved(next);
      onShowResolvedChange?.(next);
    },
    [onShowResolvedChange],
  );

  // Focus restoration. Captured on mount rather than on open so a panel that
  // is portalled in and out still hands focus back to the toggle that opened
  // it instead of dropping the caret on <body>.
  useEffect(() => {
    if (!restoreFocusOnUnmount) return;
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [restoreFocusOnUnmount]);

  const focusThreadAt = useCallback(
    (index: number) => {
      const target = ordered[index];
      if (!target) return;
      setFocusedThreadId(target.thread.id);
      cardRefs.current.get(target.thread.id)?.focus();
    },
    [ordered],
  );

  const handleListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        if (onClose) {
          event.preventDefault();
          onClose();
        }
        return;
      }
      // Arrow keys inside a composer or a button belong to that control.
      const card = (event.target as HTMLElement).closest?.(
        '.nim-comment-thread',
      );
      if (!card || card !== event.target) return;

      const index = ordered.findIndex(
        (view) => view.thread.id === (card as HTMLElement).dataset.threadId,
      );
      if (index === -1) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusThreadAt(Math.min(index + 1, ordered.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusThreadAt(Math.max(index - 1, 0));
      } else if (event.key === 'Home') {
        event.preventDefault();
        focusThreadAt(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        focusThreadAt(ordered.length - 1);
      }
    },
    [ordered, focusThreadAt, onClose],
  );

  // A thread the user was standing on can vanish (deleted here, resolved by a
  // peer). Without this the browser drops focus to <body> and keyboard users
  // have to tab in from the top of the app again.
  useEffect(() => {
    if (!focusedThreadId) return;
    if (ordered.some((view) => view.thread.id === focusedThreadId)) return;
    const panelHasFocus =
      listRef.current?.contains(document.activeElement) ?? false;
    setFocusedThreadId(null);
    if (panelHasFocus || document.activeElement === document.body) {
      cardRefs.current.get(ordered[0]?.thread.id ?? '')?.focus();
    }
  }, [ordered, focusedThreadId]);

  const emptyText =
    emptyMessage ??
    (canComment
      ? 'No comments yet. Select text in the document and add one.'
      : 'No comments yet.');

  return (
    <section
      className={
        className ? `nim-comments-panel ${className}` : 'nim-comments-panel'
      }
      data-testid="comments-panel"
      aria-labelledby={titleId}
    >
      <div className="nim-comments-panel-header">
        <span
          aria-hidden="true"
          className="material-symbols-outlined nim-comments-panel-icon"
        >
          chat_bubble
        </span>
        <span className="nim-comments-panel-title" id={titleId}>
          {title}
        </span>
        <CommentCountBadge count={threads.length} />
        {headerExtra}
        {resolvedCount > 0 && (
          <button
            type="button"
            className="nim-comments-panel-filter"
            data-testid="comments-panel-resolved-filter"
            aria-pressed={showResolved}
            title={showResolved ? 'Hide resolved threads' : 'Show resolved threads'}
            aria-label={
              showResolved
                ? `Hide ${resolvedCount} resolved threads`
                : `Show ${resolvedCount} resolved threads`
            }
            onClick={() => setShowResolved(!showResolved)}
          >
            <span aria-hidden="true" className="material-symbols-outlined">
              {showResolved ? 'check_circle' : 'radio_button_unchecked'}
            </span>
          </button>
        )}
        {onClose && (
          <button
            type="button"
            className="nim-comments-panel-close"
            onClick={onClose}
            aria-label="Close comments"
            title="Close"
          >
            <span aria-hidden="true" className="material-symbols-outlined">
              close
            </span>
          </button>
        )}
      </div>

      {/* Explain the missing affordances once, at the container, rather than
          repeating a notice under every thread. */}
      {!canComment && (
        <div className="nim-comments-panel-notice" role="status">
          You have read-only access to this document.
        </div>
      )}

      <div
        className="nim-comments-panel-list"
        ref={listRef}
        onKeyDown={handleListKeyDown}
      >
        {ordered.length === 0 ? (
          <div className="nim-comments-empty">{emptyText}</div>
        ) : (
          groups.map((group) => (
            <div
              key={group.key}
              className={`nim-comments-group nim-comments-group-${group.key}`}
              role="list"
              aria-label={group.heading ? `${group.heading} threads` : title}
            >
              {group.heading && (
                <div className="nim-comments-group-heading" aria-hidden="true">
                  {group.heading}
                </div>
              )}
              {group.views.map((view) => (
                <CommentThreadCard
                  key={view.thread.id}
                  thread={view.thread}
                  anchorState={view.anchorState}
                  anchorLabel={view.anchorLabel}
                  isActive={view.thread.id === activeThreadId}
                  canComment={canComment}
                  canManageThread={canManageCommentThread(
                    capabilities,
                    currentUserId,
                    view.thread,
                  )}
                  canDeleteThread={canDeleteCommentThread(
                    capabilities,
                    currentUserId,
                    view.thread,
                  )}
                  canDeleteComment={(comment) =>
                    canDeleteThreadComment(capabilities, currentUserId, comment)
                  }
                  getMembers={getMembers}
                  tabIndex={view.thread.id === rovingThreadId ? 0 : -1}
                  autoFocusComposer={view.thread.id === autoFocusThreadId}
                  cardRef={(element) => {
                    if (element) cardRefs.current.set(view.thread.id, element);
                    else cardRefs.current.delete(view.thread.id);
                  }}
                  {...actions}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
