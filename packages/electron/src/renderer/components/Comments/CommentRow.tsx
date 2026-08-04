import React, { useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

import { CommentActionMenu } from './CommentActionMenu';
import { CommentBody } from './CommentBody';
import { EmojiPicker, EmojiTriggerButton } from './EmojiPicker';
import { ReactionBar } from './ReactionBar';
import type {
  CommentActionKind,
  CommentView,
  ResourceOpenHandler,
} from './commentTypes';

/**
 * How much vertical room a message row takes.
 *
 * `comfortable` is the avatar-and-header layout every surface has always used.
 * `compact` is the single-line variant: a clock gutter on the left, then the
 * author and the message on one line, no avatar. It is chosen per surface, not
 * per row -- the org window reads the user's preference and passes it down;
 * document comments never do.
 */
export type CommentDensity = 'comfortable' | 'compact';

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
  density = 'comfortable',
  timestampMs,
}: {
  view: CommentView;
  onAction: (action: CommentActionKind, view: CommentView) => void;
  onToggleReaction: (emoji: string, on: boolean, view: CommentView) => void;
  onOpenResource?: ResourceOpenHandler;
  onOpenMention?: (userId: string) => void;
  onOpenSession?: (sessionId: string) => void;
  onOpenReplyParent?: (commentId: string) => void;
  onRetry?: (view: CommentView) => void;
  /** Consecutive message from the same actor: suppress the repeated header. */
  grouped?: boolean;
  density?: CommentDensity;
  /**
   * Post time, for the compact clock gutter. `CommentView.timestampLabel` is
   * relative ("4m", "2d") because that is what the comfortable header wants;
   * the compact gutter wants a wall clock, and the view model is shared with
   * every other surface, so the row formats it from the raw value instead.
   */
  timestampMs?: number;
}) {
  const isAgent = view.actor.kind === 'agent';
  const compact = density === 'compact';
  // Lifted out of the picker so the hover-revealed actions container can stay
  // visible while the popover is open: the picker's search field autofocuses
  // into a portal, which `focus-within` on this row cannot see.
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const canAddReaction = view.reactionsSupported && view.canReact;

  const body = view.deleted ? (
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
  );

  return (
    <div
      className={`comment-row ${compact ? 'comment-row-compact items-baseline gap-2 py-[3px]' : 'gap-2.5 py-1.5'} group relative flex px-3 ${
        view.failed ? 'bg-[color-mix(in_srgb,var(--nim-error)_7%,transparent)]' : 'hover:bg-[var(--nim-bg-hover)]'
      }`}
      data-testid={`comment-row-${view.ref.commentId}`}
      data-actor-kind={view.actor.kind}
      data-deleted={view.deleted ? 'true' : 'false'}
      data-pending={view.pending ? 'true' : 'false'}
      data-density={density}
      role="article"
    >
      {compact ? (
        <ClockGutter
          view={view}
          grouped={grouped}
          timestampMs={timestampMs}
        />
      ) : (
        <div className="comment-row-gutter w-7 shrink-0 pt-0.5">
          {!grouped && <ActorAvatar view={view} />}
        </div>
      )}

      <div className="comment-row-main min-w-0 flex-1">
        {view.replyParent && (
          <ReplyParentStrip view={view} onOpenReplyParent={onOpenReplyParent} />
        )}

        {compact ? (
          /* Author and message share one line. The body is a flex item rather
             than inline text so a message that wraps hangs under itself instead
             of running back under the author name.

             The line must NOT wrap: a wrapping flex line breaks before it
             shrinks, so any message wider than the space left beside the name
             would drop to its own line and the row would stop being one line at
             all. `flex-1 min-w-0` on the body makes it shrink instead. */
          <div className="comment-row-compact-line flex min-w-0 items-baseline gap-x-1.5">
            {!grouped && (
              <>
                <span className="comment-row-actor max-w-[180px] shrink-0 truncate text-[13px] font-semibold text-[var(--nim-text)]">
                  {view.actor.displayName}
                </span>
                {isAgent && <AgentBadges view={view} />}
              </>
            )}
            <div className="comment-row-compact-body min-w-0 flex-1">{body}</div>
            <RowStatusBadges view={view} isAgent={isAgent} onOpenSession={onOpenSession} />
          </div>
        ) : (
          <>
            {!grouped && (
              <div className="comment-row-header flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                <span className="comment-row-actor truncate text-[13px] font-semibold text-[var(--nim-text)]">
                  {view.actor.displayName}
                </span>

                {isAgent && <AgentBadges view={view} />}

                <span
                  className="comment-row-timestamp shrink-0 text-[11px] text-[var(--nim-text-faint)]"
                  title={view.timestampTitle}
                >
                  {view.timestampLabel}
                </span>

                <RowStatusBadges view={view} isAgent={isAgent} onOpenSession={onOpenSession} />
              </div>
            )}

            {body}
          </>
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

      <div
        className={`comment-row-actions absolute right-2 ${compact ? 'top-0' : 'top-1'} flex items-center gap-0.5 ${
          reactionPickerOpen ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100'
        }`}
        data-testid="comment-row-actions"
      >
        {canAddReaction && (
          <EmojiPicker
            placement="bottom-end"
            testId="reaction-emoji-picker"
            open={reactionPickerOpen}
            onOpenChange={setReactionPickerOpen}
            onSelect={(emoji) => onToggleReaction(emoji, true, view)}
            trigger={(props) => (
              <EmojiTriggerButton label="Add reaction" testId="reaction-add-trigger" triggerProps={props} />
            )}
          />
        )}
        <CommentActionMenu view={view} onAction={onAction} />
      </div>
    </div>
  );
}

/**
 * The compact row's left gutter: the post's wall-clock time, in place of the
 * avatar.
 *
 * On a grouped row the time is revealed on hover rather than removed, so a run
 * of messages reads as one block while every row can still be dated. The
 * element stays mounted either way -- the gutter must reserve its width or the
 * bodies of grouped and ungrouped rows would not line up.
 */
function ClockGutter({
  view,
  grouped,
  timestampMs,
}: {
  view: CommentView;
  grouped: boolean;
  timestampMs?: number;
}) {
  const label = timestampMs !== undefined ? formatClockTime(timestampMs) : view.timestampLabel;
  return (
    <div className="comment-row-gutter comment-row-clock-gutter w-[58px] shrink-0 text-right">
      <span
        className={`comment-row-clock text-[11px] tabular-nums text-[var(--nim-text-faint)] ${
          grouped ? 'opacity-0 group-hover:opacity-100' : ''
        }`}
        data-testid="comment-row-clock"
        data-hover-only={grouped ? 'true' : 'false'}
        title={view.timestampTitle}
      >
        {label}
      </span>
    </div>
  );
}

/** `12:35 PM` in the reader's locale, matching the compact gutter's fixed width. */
export function formatClockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Authorship/authorization split: the session authored it, the owner authorized
 * it, and both belong next to the name in either density.
 */
function AgentBadges({ view }: { view: CommentView }) {
  return (
    <>
      <span
        className="comment-row-agent-badge inline-flex shrink-0 items-center gap-1 rounded-[4px] bg-[color-mix(in_srgb,var(--nim-primary)_16%,transparent)] px-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--nim-primary)]"
        data-testid="comment-row-agent-badge"
      >
        <MaterialSymbol icon="smart_toy" size={10} /> Agent
      </span>
      <span
        className="comment-row-agent-owner shrink-0 text-[12px] text-[var(--nim-text-faint)]"
        data-testid="comment-row-agent-owner"
      >
        for {view.actor.ownerDisplayName}
      </span>
    </>
  );
}

/**
 * Edited / session / pending markers. They trail the header in comfortable and
 * the message in compact, so a row never loses them to the denser layout.
 */
function RowStatusBadges({
  view,
  isAgent,
  onOpenSession,
}: {
  view: CommentView;
  isAgent: boolean;
  onOpenSession?: (sessionId: string) => void;
}) {
  return (
    <>
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
    </>
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
