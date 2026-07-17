import React, { type JSX } from 'react';

export interface TrackerFavoriteStarProps {
  itemId: string;
  isFavorite: boolean;
  onToggle?: (itemId: string) => void;
  className?: string;
}

/** Non-row-owning action; aggressively isolates every row/card interaction. */
export function TrackerFavoriteStar({ itemId, isFavorite, onToggle, className = '' }: TrackerFavoriteStarProps): JSX.Element {
  return (
    <button
      type="button"
      draggable={false}
      aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
      aria-pressed={isFavorite}
      data-testid="tracker-favorite-star"
      className={`tracker-favorite-star shrink-0 inline-flex items-center justify-center w-6 h-6 rounded hover:bg-[var(--nim-bg-hover)] ${isFavorite ? 'text-amber-500' : 'text-[var(--nim-text-faint)] opacity-60 hover:opacity-100'} ${className}`}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); onToggle?.(itemId); }}
    >
      <span
        className="material-symbols-outlined"
        style={{ fontSize: '17px', fontVariationSettings: isFavorite ? "'FILL' 1" : "'FILL' 0" }}
      >star</span>
    </button>
  );
}
