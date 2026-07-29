import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

import { CommentActionMenu } from './CommentActionMenu';
import { CommentBody } from './CommentBody';
import { ReactionBar } from './ReactionBar';
import type { CommentActionKind, CommentView, ResourcePillView } from './commentTypes';

/**
 * One comment, in every surface: rooms, document discussions, DMs, tracker
 * comments, and inline document comments.
 *
 * The row renders a `CommentView` and makes no decisions. Availability,
 * redaction, and capability resolution all happened in `buildCommentView`; what
 * is left here is layout, which is why the same component can serve a 900px
 * room and a 300px conversation panel without a second design.
 *
 * Container queries (not media queries) drive the narrow layout, so the row
 * responds to the panel it is in rather than the window it is in.
 */
export function CommentRow({
  view,
  onAction,
  onToggleReaction,
  onOpenResource,
  onOpenMention,
  onOpenSession,
  onOpenReplyParent,
  onRetry,
  grouped = false,
}: {
  view: CommentView;
  onAction: (action: CommentActionKind, view: CommentView) => void;
  onToggleReaction: (emoji: string, on: boolean, view: CommentView) => void;
  onOpenResource?: (pill: ResourcePillView) => void;
  onOpenMention?: (userId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenReplyParent?: (commentId: string) => void;
  onRetry?: (view: CommentView) => void;
  /** Consecutive message from the same actor: suppress the repeated header. */
  grouped?: boolean;
}) {
  const isAgent = view.actor.kind === 'agent';

  return (
    <div
      className={`comment-row group relative flex gap-2.5 px-3 py-1.5 ${
        view.failed ? 'bg-[color-mix(in_srgb,var(--nim-error)_7%,transparent)]' : 'hover:bg-[var(--nim-bg-hover)]'
      }`}
      data-testid={`comment-row-${view.ref.commentId}`}
      data-actor-kind={view.actor.kind}
      data-deleted={view.deleted ? 'true' : 'false'}
      data-pending={view.pending ? 'true' : 'false'}
      role="article"
    >
      <div className="comment-row-gutter w-7 shrink-0 pt-0.5">
        {!grouped && <ActorAvatar view={view} />}
      </div>

      <div className="comment-row-main min-w-0 flex-1">
        {view.replyParent && (
          <ReplyParentStrip view={view} onOpenReplyParent={onOpenReplyParent} />
        )}

        {!grouped && (
          <div className="comment-row-header flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            <span className="comment-row-actor truncate text-[13px] font-semibold text-[var(--nim-text)]">
              {view.actor.displayName}
            </span>

            {isAgent && (
              <>
                <span
                  className="comment-row-agent-badge inline-flex shrink-0 items-center gap-1 rounded-[4px] bg-[color-mix(in_srgb,var(--nim-primary)_16%,transparent)] px-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--nim-primary)]"
                  data-testid="comment-row-agent-badge"
                >
                  <MaterialSymbol icon="smart_toy" size={10} /> Agent
                </span>
                {/* Authorship/authorization split: the session authored it, the
                    owner authorized it, and both belong in the header. */}
                <span
                  className="comment-row-agent-owner shrink-0 text-[12px] text-[var(--nim-text-faint)]"
                  data-testid="comment-row-agent-owner"
                >
                  for {view.actor.ownerDisplayName}
                </span>
              </>
            )}

            <span
              className="comment-row-timestamp shrink-0 text-[11px] text-[var(--nim-text-faint)]"
              title={view.timestampTitle}
            >
              {view.timestampLabel}
            </span>

            {view.editedLabel && (
              <span
                className="comment-row-edited shrink-0 text-[11px] text-[var(--nim-text-faint)]"
                data-testid="comment-row-edited"
                title={view.editedTitle}
              >
                ({view.editedLabel})
              </span>
            )}

            {isAgent && view.actor.sessionId && (
              <button
                type="button"
                data-testid="comment-row-session-chip"
                data-session-id={view.actor.sessionId}
                title={`Open session ${view.actor.sessionName}`}
                onClick={() => onOpenSession?.(view.actor.sessionId!)}
                className="comment-row-session-chip inline-flex min-w-0 shrink items-center gap-1 rounded-[5px] border border-[var(--nim-border)] px-1.5 text-[11px] text-[var(--nim-text-muted)] hover:border-[var(--nim-primary)] hover:bg-[var(--nim-bg-hover)]"
              >
                <MaterialSymbol icon="open_in_new" size={11} />
                <span className="comment-row-session-chip-label truncate">{view.actor.sessionName}</span>
              </button>
            )}

            {view.pending && (
              <span
                className="comment-row-pending inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--nim-bg-tertiary)] px-1.5 text-[10px] text-[var(--nim-text-muted)]"
                data-testid="comment-row-pending"
                title={view.pendingLabel}
              >
                <MaterialSymbol icon="hourglass_top" size={10} /> {view.pendingLabel ?? 'Pending'}
              </span>
            )}
          </div>
        )}

        {view.deleted ? (
          <p
            className="comment-row-deleted m-0 flex items-center gap-1.5 text-[13px] italic text-[var(--nim-text-faint)]"
            data-testid="comment-row-deleted"
          >
            <MaterialSymbol icon="block" size={13} />
            {view.deletedLabel}
          </p>
        ) : (
          <CommentBody
            segments={view.segments}
            onOpenResource={onOpenResource}
            onOpenMention={onOpenMention}
            onOpenSession={onOpenSession}
          />
        )}

        {view.failed && (
          <div
            className="comment-row-failed mt-1 flex items-center gap-2 text-[12px] text-[var(--nim-error)]"
            data-testid="comment-row-failed"
          >
            <MaterialSymbol icon="error" size={13} />
            <span>Not sent.</span>
            {onRetry && (
              <button
                type="button"
                className="comment-row-retry underline"
                data-testid="comment-row-retry"
                onClick={() => onRetry(view)}
              >
                Retry
              </button>
            )}
          </div>
        )}

        <ReactionBar
          reactions={view.reactions}
          supported={view.reactionsSupported}
          canReact={view.canReact}
          onToggle={(emoji, on) => onToggleReaction(emoji, on, view)}
        />
      </div>

      <div className="comment-row-actions absolute right-2 top-1 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
        <CommentActionMenu view={view} onAction={onAction} />
      </div>
    </div>
  );
}

function ActorAvatar({ view }: { view: CommentView }) {
  if (view.actor.kind === 'agent') {
    return (
      <span
        className="comment-row-avatar comment-row-avatar-agent flex size-7 items-center justify-center rounded-[6px] bg-[color-mix(in_srgb,var(--nim-primary)_18%,transparent)] text-[var(--nim-primary)]"
        data-testid="comment-row-agent-glyph"
        aria-label="Agent"
      >
        <MaterialSymbol icon="smart_toy" size={15} />
      </span>
    );
  }
  return (
    <span
      className="comment-row-avatar flex size-7 items-center justify-center rounded-full bg-[var(--nim-bg-active)] text-[10px] font-semibold text-[var(--nim-text-muted)]"
      data-testid="comment-row-avatar"
      aria-hidden="true"
    >
      {view.actor.initials}
    </span>
  );
}

/**
 * One displayed level of reply context, never a tree. When the parent is
 * deleted or the reader cannot see it, the strip says so and carries no
 * snippet.
 */
function ReplyParentStrip({
  view,
  onOpenReplyParent,
}: {
  view: CommentView;
  onOpenReplyParent?: (commentId: string) => void;
}) {
  const parent = view.replyParent!;
  const unavailable = parent.unavailableLabel !== undefined;

  return (
    <button
      type="button"
      data-testid="comment-reply-parent"
      data-unavailable={unavailable ? 'true' : 'false'}
      disabled={unavailable}
      onClick={() => onOpenReplyParent?.(parent.commentId)}
      className={`comment-reply-parent mb-0.5 flex w-full min-w-0 items-center gap-1.5 rounded border-l-2 border-[var(--nim-border)] pl-1.5 text-left text-[11px] ${
        unavailable ? 'cursor-default text-[var(--nim-text-faint)]' : 'text-[var(--nim-text-muted)] hover:border-[var(--nim-primary)]'
      }`}
    >
      <MaterialSymbol icon="reply" size={11} />
      {unavailable ? (
        <span className="truncate italic">{parent.unavailableLabel}</span>
      ) : (
        <>
          <span className="comment-reply-parent-actor shrink-0 font-medium">{parent.actorLabel}</span>
          <span className="comment-reply-parent-snippet truncate">{parent.snippet}</span>
        </>
      )}
    </button>
  );
}
