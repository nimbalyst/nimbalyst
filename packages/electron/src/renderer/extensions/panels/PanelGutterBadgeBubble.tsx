/** The bubble on an extension panel's gutter button (see panelGutterBadges.ts). */

import type { JSX } from 'react';
import React, { useSyncExternalStore } from 'react';
import { formatUnreadCount } from '../../store/projectWindowUnreadViewModel';
import { getPanelGutterBadge, subscribePanelGutterBadges } from './panelGutterBadges';

/** Subscribes on its own so a badge change never re-renders the whole gutter. */
export function PanelGutterBadgeBubble({ panelId }: { panelId: string }): JSX.Element | null {
  const badge = useSyncExternalStore(subscribePanelGutterBadges, () => getPanelGutterBadge(panelId));
  if (!badge) return null;
  const color = badge.tone === 'warning' ? 'bg-nim-warning' : 'bg-nim-error';
  // Lower corner, like the Organization unread bubble, so it clears the alpha dot.
  return badge.count > 0 ? (
    <span
      className={`extension-panel-gutter-badge absolute -bottom-1.5 -right-1.5 z-10 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-[var(--nim-bg-secondary)] ${color} px-1 text-[10px] font-bold leading-none text-white shadow-sm pointer-events-none`}
      aria-hidden="true"
      data-tone={badge.tone}
    >
      {formatUnreadCount(badge.count)}
    </span>
  ) : (
    <span
      className={`extension-panel-gutter-badge absolute bottom-0 right-0 z-10 h-[10px] w-[10px] rounded-full border-2 border-[var(--nim-bg-secondary)] ${color} pointer-events-none`}
      aria-hidden="true"
      data-tone={badge.tone}
    />
  );
}
