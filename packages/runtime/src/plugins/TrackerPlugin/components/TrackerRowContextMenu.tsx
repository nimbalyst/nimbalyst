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
import { useFloating, FloatingPortal } from '@floating-ui/react';
import { useScrollableMenuFloating } from '../../../ui/floating/useScrollableMenuFloating';
import type { TrackerItemType } from '../../../core/DocumentService';
import type { TrackerRecord } from '../../../core/TrackerRecord';
import { ProviderIcon } from '../../../ui/icons/ProviderIcons';
import { getRecordTitle } from '../trackerRecordAccessors';
import { getStatusColor, getPriorityColor, getTypeColor, getTypeIcon } from './trackerColumns';
import type { ConfirmTrackerDelete } from './useTrackerRows';

const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

/**
 * Panel chrome carried as inline style rather than Tailwind arbitrary values.
 *
 * `size()` makes the browser resolve computed style on these panels, and jsdom's
 * selector engine cannot parse a `:has()` rule against an element whose class
 * list contains `[...]` — it mangles `min-w-[140px]` into an invalid selector and
 * throws, which surfaces as an unhandled rejection in any suite that renders this
 * menu. Real browsers are fine either way; keeping these values off the class list
 * simply avoids handing jsdom something it cannot read.
 */
const MENU_PANEL_STYLE: React.CSSProperties = {
  backgroundColor: 'var(--nim-bg-secondary)',
  borderColor: 'var(--nim-border)',
};

/**
 * An AI session linked to a tracker item, shaped for menu display.
 *
 * Callers pre-resolve these: merging the two link directions and formatting the
 * timestamp both live on the Electron side, so the menu stays presentational.
 */
export interface TrackerLinkedSessionOption {
  id: string;
  title: string;
  provider?: string;
  /** Pre-formatted relative time, e.g. "2h ago". */
  timeLabel?: string;
}

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
  /** Sessions already linked to a single selected item. Omit to hide the submenu. */
  getLinkedSessions?: (itemId: string) => TrackerLinkedSessionOption[];
  /** Jump to an existing linked session. */
  onOpenSession?: (sessionId: string) => void;
  /** Start a new AI session seeded with the item's context. */
  onLaunchSession?: (itemId: string) => void;
  /** Start a new isolated worktree session for the item. */
  onLaunchWorktree?: (itemId: string) => void;
  onArchiveItems?: (itemIds: string[], archive: boolean) => void;
  onDeleteItems?: (itemIds: string[]) => void;
  /** Confirms a delete; the Delete action is hidden without it. */
  confirmDelete?: ConfirmTrackerDelete;
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
  getLinkedSessions,
  onOpenSession,
  onLaunchSession,
  onLaunchWorktree,
  onArchiveItems,
  onDeleteItems,
  confirmDelete,
  closeContextMenu,
  clearSelection,
}: TrackerRowContextMenuProps): JSX.Element | null {
  if (!anchor || selectedIds.size === 0) return null;

  const statusType = activeTypeFilter !== 'all' ? activeTypeFilter : undefined;

  // Session actions are item-scoped, so they only make sense for one row.
  const singleId = selectedIds.size === 1 ? Array.from(selectedIds)[0] : null;
  const linkedSessions = singleId && getLinkedSessions && onOpenSession
    ? getLinkedSessions(singleId)
    : [];
  const hasSessionActions = singleId != null
    && (linkedSessions.length > 0 || onLaunchSession != null || onLaunchWorktree != null);

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        data-testid="tracker-row-context-menu"
        className="tracker-row-context-menu z-50 overflow-y-auto overscroll-contain border rounded-md shadow-lg py-1"
        style={{ ...floatingStyles, ...MENU_PANEL_STYLE, minWidth: 180, fontSize: 13 }}
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

        {hasSessionActions && (
          <>
            <div className="border-b border-[var(--nim-border)] my-1" />

            {linkedSessions.length > 0 && (
              <ContextSubmenu label={`Sessions (${linkedSessions.length})`} icon="smart_toy">
                {linkedSessions.map(session => (
                  <button
                    key={session.id}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
                    data-testid="tracker-row-context-open-session"
                    title={`Open session: ${session.title}`}
                    onClick={() => {
                      closeContextMenu();
                      onOpenSession?.(session.id);
                    }}
                  >
                    <span className="shrink-0 flex items-center text-[var(--nim-text-muted)]">
                      <ProviderIcon provider={session.provider || 'claude'} size={14} />
                    </span>
                    <span className="flex-1 truncate max-w-[220px]">{session.title}</span>
                    {session.timeLabel && (
                      <span className="text-[11px] text-[var(--nim-text-faint)] shrink-0">
                        {session.timeLabel}
                      </span>
                    )}
                  </button>
                ))}
              </ContextSubmenu>
            )}

            {onLaunchSession && (
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
                data-testid="tracker-row-context-launch-session"
                onClick={() => {
                  closeContextMenu();
                  onLaunchSession(singleId!);
                }}
              >
                <span className="material-symbols-outlined text-sm">add_circle</span>
                Launch Session
              </button>
            )}

            {onLaunchWorktree && (
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
                data-testid="tracker-row-context-launch-worktree"
                onClick={() => {
                  closeContextMenu();
                  onLaunchWorktree(singleId!);
                }}
              >
                <span className="material-symbols-outlined text-sm">account_tree</span>
                Launch Worktree
              </button>
            )}
          </>
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

        {onDeleteItems && confirmDelete && (
          <button
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[#ef4444] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
            data-testid="tracker-row-context-delete"
            onClick={async () => {
              closeContextMenu();
              const ids = Array.from(selectedIds);
              if (await confirmDelete(ids.length)) {
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
  const { refs, floatingStyles } = useScrollableMenuFloating('right-start');

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
            className="tracker-context-submenu overflow-y-auto overscroll-contain border rounded-md shadow-lg py-1"
            style={{ ...floatingStyles, ...MENU_PANEL_STYLE, minWidth: 140, maxWidth: 280, zIndex: 60 }}
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
