/**
 * A Pages section's root: the menu that empty tree space and the section
 * header open (New page, then Place type...), and the messages an empty or
 * filtered-out tree shows instead of rows. A page started from any of these
 * lands at the section root.
 */
import React, { useMemo } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { FloatingPortal, useFloatingMenu, virtualElement } from '../ui-primitives/useFloatingMenu';

const MENU_ENTRY_CLASS = 'w-full flex items-center gap-2.5 px-3 py-1.5 rounded border-none bg-transparent cursor-pointer transition-colors text-left text-nim hover:bg-nim-hover';

/** A host's own entry in a section menu, after New page and Place type... */
export interface CollabSectionMenuItem {
  /** Stable kebab-case marker, used as the entry's class. */
  id: string;
  label: string;
  icon: string;
  onSelect: () => void;
}

export const CollabSectionMenu: React.FC<{
  x: number;
  y: number;
  onNewPage: () => void;
  /** Absent without tracker data (no types to place). */
  onPlaceType?: () => void;
  extraItems?: readonly CollabSectionMenuItem[];
  onClose: () => void;
}> = ({ x, y, onNewPage, onPlaceType, extraItems, onClose }) => {
  const reference = useMemo(() => virtualElement(x, y), [x, y]);
  const floating = useFloatingMenu({
    placement: 'right-start',
    reference,
    open: true,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
  });
  return (
    <FloatingPortal>
      <div
        ref={floating.refs.setFloating}
        style={floating.floatingStyles}
        {...floating.getFloatingProps()}
        className="collab-section-menu min-w-[180px] rounded-md z-[10000] text-[13px] p-1 bg-nim-secondary border border-nim text-nim backdrop-blur-[10px] shadow-lg"
      >
        <button type="button" className={`collab-section-new-page ${MENU_ENTRY_CLASS}`} onClick={onNewPage}>
          <MaterialSymbol icon="note_add" size={18} />
          <span>New page</span>
        </button>
        {onPlaceType && (
          <button type="button" className={`collab-section-place-type ${MENU_ENTRY_CLASS}`} onClick={onPlaceType}>
            <MaterialSymbol icon="table" size={18} />
            <span>Place type...</span>
          </button>
        )}
        {extraItems?.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`collab-section-${item.id} ${MENU_ENTRY_CLASS}`}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <MaterialSymbol icon={item.icon} size={18} />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </FloatingPortal>
  );
};

export type CollabTreeEmptyReason = 'empty' | 'favorites' | 'updated';

const EMPTY_ICON: Record<CollabTreeEmptyReason, string> = {
  empty: 'cloud_sync',
  favorites: 'star',
  updated: 'mark_email_read',
};

export const CollabTreeEmptyState: React.FC<{
  reason: CollabTreeEmptyReason;
  personal: boolean;
  scopeAvailable: boolean;
  /** Absent when no page type can be created here. */
  onNewPage?: () => void;
}> = ({ reason, personal, scopeAvailable, onNewPage }) => {
  const [title, hint] = reason === 'favorites'
    ? ['No favorites yet.', 'Star a document to pin it here.']
    : reason === 'updated'
      ? ["You're all caught up.", 'No documents changed since you last viewed them.']
      : personal
        ? ['No personal pages yet.', null]
        : scopeAvailable
          ? ['No shared documents yet.', 'Create one here or share a local file to collaborate.']
          : ['No team connected to this workspace.', null];
  return (
    <div className="collab-tree-empty px-2 py-4 text-center">
      <MaterialSymbol icon={EMPTY_ICON[reason]} size={32} className="text-nim-faint mb-2" />
      <p className="text-xs text-nim-faint m-0">{title}</p>
      {hint && <p className="text-xs text-nim-faint mt-1 m-0">{hint}</p>}
      {reason === 'empty' && scopeAvailable && onNewPage && (
        <button
          type="button"
          className="collab-empty-new-page mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-[var(--nim-border)] bg-transparent text-xs text-[var(--nim-text)] cursor-pointer hover:bg-[var(--nim-bg-hover)]"
          onClick={onNewPage}
        >
          <MaterialSymbol icon="note_add" size={14} />
          New page
        </button>
      )}
    </div>
  );
};
