/**
 * TrackerRowContextMenu -- the right-click menu shared by every tracker row
 * surface (the list view and the RevoGrid table).
 *
 * Selection and the bulk write handlers live in `useTrackerRows`; this component
 * only renders the menu for whatever that hook currently has selected, so the
 * two surfaces can never drift on which bulk actions exist.
 */

import type { JSX } from 'react';
import React, { useEffect, useRef, useState } from 'react';
import { useFloating, offset, flip, shift, FloatingPortal } from '@floating-ui/react';
import type { TrackerItemType } from '../../../core/DocumentService';
import type { TrackerRecord } from '../../../core/TrackerRecord';
import { getRecordTitle } from '../trackerRecordAccessors';
import { getStatusColor, getPriorityColor, getTypeColor, getTypeIcon } from './trackerColumns';

const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

export interface TrackerRowContextMenuProps {
  /** Anchor rect for the menu; `null` keeps it closed. */
  anchor: DOMRect | null;
  refs: ReturnType<typeof useFloating>['refs'];
  floatingStyles: React.CSSProperties;
  selectedIds: Set<string>;
  activeTypeFilter: TrackerItemType | 'all';
  /** Status options for the active type (from `useTrackerRows.statusOptionsForBulk`). */
  statusOptions: Array<string | { value: string; label: string }>;
  /** Collections the selection can be added to; omit to hide the submenu. */
  collectionTargets?: TrackerRecord[];
  onSetStatus: (status: string) => void;
  onSetPriority: (priority: string) => void;
  onAddToCollection?: (collection: TrackerRecord) => void;
  onCopyDeepLink?: (itemId: string) => void;
  /** Open the item as a document (focused document view); single selection only. */
  onOpenDocument?: (itemId: string) => void;
  onArchiveItems?: (itemIds: string[], archive: boolean) => void;
  onDeleteItems?: (itemIds: string[]) => void;
  closeContextMenu: () => void;
  clearSelection: () => void;
}

export function TrackerRowContextMenu({
  anchor,
  refs,
  floatingStyles,
  selectedIds,
  activeTypeFilter,
  statusOptions,
  collectionTargets = [],
  onSetStatus,
  onSetPriority,
  onAddToCollection,
  onCopyDeepLink,
  onOpenDocument,
  onArchiveItems,
  onDeleteItems,
  closeContextMenu,
  clearSelection,
}: TrackerRowContextMenuProps): JSX.Element | null {
  if (!anchor || selectedIds.size === 0) return null;

  const statusType = activeTypeFilter !== 'all' ? activeTypeFilter : undefined;

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        data-testid="tracker-row-context-menu"
        className="tracker-row-context-menu z-50 min-w-[180px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md shadow-lg py-1 text-[13px]"
        style={floatingStyles}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-1 text-[11px] text-[var(--nim-text-faint)] font-medium">
          {selectedIds.size} item{selectedIds.size > 1 ? 's' : ''} selected
        </div>
        <div className="border-b border-[var(--nim-border)] my-1" />

        <ContextSubmenu label="Set Status" icon="swap_horiz">
          {statusOptions.map(opt => {
            const value = typeof opt === 'string' ? opt : opt.value;
            const label = typeof opt === 'string'
              ? opt.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
              : opt.label;
            return (
              <button
                key={value}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
                onClick={() => onSetStatus(value)}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: getStatusColor(value, statusType) }}
                />
                {label}
              </button>
            );
          })}
        </ContextSubmenu>

        <ContextSubmenu label="Set Priority" icon="flag">
          {PRIORITIES.map(p => (
            <button
              key={p}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
              onClick={() => onSetPriority(p)}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: getPriorityColor(p) }}
              />
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </ContextSubmenu>

        {onAddToCollection && collectionTargets.length > 0 && (
          <ContextSubmenu label="Add to Collection" icon="inventory_2">
            {collectionTargets.map(collection => (
              <button
                key={collection.id}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
                onClick={() => onAddToCollection(collection)}
              >
                <span
                  className="material-symbols-outlined text-sm shrink-0"
                  style={{ color: getTypeColor(collection.primaryType) }}
                >
                  {getTypeIcon(collection.primaryType)}
                </span>
                <span className="truncate">{getRecordTitle(collection)}</span>
              </button>
            ))}
          </ContextSubmenu>
        )}

        <div className="border-b border-[var(--nim-border)] my-1" />

        {onOpenDocument && selectedIds.size === 1 && (
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
            data-testid="tracker-row-context-open-document"
            onClick={() => {
              const [onlyId] = selectedIds;
              closeContextMenu();
              onOpenDocument(onlyId);
            }}
          >
            <span className="material-symbols-outlined text-sm">article</span>
            Open document
          </button>
        )}

        {onCopyDeepLink && selectedIds.size === 1 && (
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
            data-testid="tracker-row-context-copy-link"
            onClick={() => {
              const [onlyId] = selectedIds;
              closeContextMenu();
              onCopyDeepLink(onlyId);
            }}
          >
            <span className="material-symbols-outlined text-sm">link</span>
            Copy Link
          </button>
        )}

        {onArchiveItems && (
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
            data-testid="tracker-row-context-archive"
            onClick={() => {
              closeContextMenu();
              onArchiveItems(Array.from(selectedIds), true);
              clearSelection();
            }}
          >
            <span className="material-symbols-outlined text-sm">archive</span>
            Archive
          </button>
        )}

        {onDeleteItems && (
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[#ef4444] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
            data-testid="tracker-row-context-delete"
            onClick={() => {
              closeContextMenu();
              const ids = Array.from(selectedIds);
              if (window.confirm(`Delete ${ids.length} item${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) {
                onDeleteItems(ids);
                clearSelection();
              }
            }}
          >
            <span className="material-symbols-outlined text-sm">delete</span>
            Delete
          </button>
        )}
      </div>
    </FloatingPortal>
  );
}

/** Context menu submenu with hover-expand. */
export const ContextSubmenu: React.FC<{
  label: string;
  icon: string;
  children: React.ReactNode;
}> = ({ label, icon, children }) => {
  const [open, setOpen] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { refs, floatingStyles } = useFloating({
    placement: 'right-start',
    middleware: [offset(2), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  const handleEnter = (): void => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setOpen(true);
  };
  const handleLeave = (): void => {
    timeoutRef.current = setTimeout(() => setOpen(false), 150);
  };

  return (
    <div
      ref={refs.setReference as React.RefCallback<HTMLDivElement>}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer">
        <span className="material-symbols-outlined text-sm">{icon}</span>
        <span className="flex-1">{label}</span>
        <span className="material-symbols-outlined text-xs text-[var(--nim-text-faint)]">chevron_right</span>
      </div>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            className="min-w-[140px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md shadow-lg py-1 z-[60]"
            style={floatingStyles}
            onMouseEnter={handleEnter}
            onMouseLeave={handleLeave}
          >
            {children}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
};
