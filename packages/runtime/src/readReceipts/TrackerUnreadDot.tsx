/**
 * TrackerUnreadDot — the 8px "unread" dot shown on tracker rows / cards.
 *
 * Mirrors the AI-session unread dot (filled `circle` in `--nim-primary`).
 * Reads `trackerUnreadAtom(itemId)` so only the affected row re-renders when an
 * item's unread state flips. Renders nothing when the item is read.
 *
 * Lives in runtime so both the runtime `TrackerTable` and the electron
 * Kanban/Tag cards render an identical dot.
 */

import React from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '../ui/icons/MaterialSymbol';
import { trackerUnreadAtom } from './trackerUnreadAtoms';

interface TrackerUnreadDotProps {
  itemId: string;
  className?: string;
}

export const TrackerUnreadDot: React.FC<TrackerUnreadDotProps> = ({ itemId, className }) => {
  const unread = useAtomValue(trackerUnreadAtom(itemId));
  if (!unread) return null;
  return (
    <span
      className={`tracker-unread-dot inline-flex items-center justify-center shrink-0 text-[var(--nim-primary)]${
        className ? ` ${className}` : ''
      }`}
      title="Updated since you last viewed"
      aria-label="Unread"
    >
      <MaterialSymbol icon="circle" size={8} fill />
    </span>
  );
};
