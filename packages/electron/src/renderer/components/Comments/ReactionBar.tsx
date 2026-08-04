import React from 'react';

import { emojiGlyphOrShortcode } from './emojiCatalog';
import type { ReactionAggregate } from './commentTypes';

/**
 * Aggregate reactions for one comment: chips only, and nothing at all when
 * there are none.
 *
 * The add-reaction affordance deliberately does *not* live here. Rendering it
 * in the bar meant every reactable message reserved a row of vertical space for
 * a button that was invisible until hover; in a dense timeline that is most of
 * the scroll height spent on nothing. It now sits in the row's hover actions
 * next to the action menu (see `CommentRow`), so an unreacted message costs
 * zero height.
 *
 * Two absence rules survive, and they mean different things:
 *
 *   `supported === false`  the adapter omits `react` -- tracker comments and
 *                          inline document comments in V1. Nothing renders,
 *                          even if aggregates came down the wire, because the
 *                          capability is not missing, the feature is.
 *   `canReact === false`   the surface supports reactions but this reader lacks
 *                          the `react` capability. Existing aggregates still
 *                          render (they are content) but are inert.
 */
export function ReactionBar({
  reactions,
  supported,
  canReact,
  onToggle,
}: {
  reactions: readonly ReactionAggregate[];
  supported: boolean;
  canReact: boolean;
  onToggle: (emoji: string, on: boolean) => void;
}) {
  if (!supported) return null;
  if (reactions.length === 0) return null;

  return (
    <div className="reaction-bar mt-1.5 flex flex-wrap items-center gap-1" data-testid="reaction-bar">
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          disabled={!canReact}
          data-testid={`reaction-chip-${reaction.emoji}`}
          data-reacted={reaction.reactedByMe ? 'true' : 'false'}
          aria-pressed={reaction.reactedByMe}
          title={`:${reaction.emoji}:`}
          onClick={() => onToggle(reaction.emoji, !reaction.reactedByMe)}
          className={`reaction-chip flex items-center gap-1 rounded-full border px-1.5 py-px text-[12px] leading-[1.5] ${
            reaction.reactedByMe
              ? 'border-[var(--nim-primary)] bg-[color-mix(in_srgb,var(--nim-primary)_16%,transparent)] text-[var(--nim-text)]'
              : 'border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text-muted)]'
          } ${canReact ? 'hover:border-[var(--nim-primary)]' : 'cursor-default'}`}
        >
          <span aria-hidden="true">{emojiGlyphOrShortcode(reaction.emoji)}</span>
          <span className="reaction-chip-count tabular-nums">{reaction.count}</span>
        </button>
      ))}
    </div>
  );
}
