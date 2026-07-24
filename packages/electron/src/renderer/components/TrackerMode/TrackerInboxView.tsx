/**
 * TrackerInboxView -- the keyboard-driven triage queue.
 *
 * The inbox is everything nobody has decided about yet (see `trackerInbox.ts`
 * for the predicate). This surface exists to empty it: one focused item at a
 * time, every triage act on a single key, and the item leaves the queue the
 * instant it is acted on -- because acting on it is exactly what `isUntriaged`
 * tests for.
 *
 * Writes route through `useTrackerRows`, so a triage keystroke is an ordinary
 * tracker field update with the same sync and inverse-edge behavior as editing
 * the cell by hand.
 */

import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { useFloating, offset, flip, shift, FloatingPortal, autoUpdate } from '@floating-ui/react';
import type { TrackerItemType } from '@nimbalyst/runtime/core/DocumentService';
import type { TrackerIdentity } from '@nimbalyst/runtime';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useTrackerRows, getTypeColor, getTypeIcon } from '@nimbalyst/runtime/plugins/TrackerPlugin';
import { trackerItemsByTypeAtom, trackerDataLoadedAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import {
  getRecordPriority,
  getRecordStatus,
  getRecordTitle,
  getFieldByRole,
  resolveRoleFieldName,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import {
  acceptStatusFor,
  isAgentProposal,
  isCollectionType,
  priorityOptionsFor,
  selectInboxItems,
  SNOOZE_PRESETS,
  type InboxScope,
  type InboxSignals,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  setTrackerSnoozeAtom,
  trackerSnoozedUntilByItemIdAtom,
} from '../../store/atoms/trackerPersonalState';

interface TrackerInboxViewProps {
  filterType?: TrackerItemType | 'all';
  overrideItems?: TrackerRecord[];
  onItemSelect?: (itemId: string) => void;
  selectedItemId?: string | null;
  onArchiveItems?: (itemIds: string[], archive: boolean) => void;
  onDeleteItems?: (itemIds: string[]) => void;
  onSwitchToFilesMode?: () => void;
  /** Whether the inbox spans every type or only the selected one. */
  scope: InboxScope;
  onScopeChange: (scope: InboxScope) => void;
  currentIdentity?: TrackerIdentity | null;
}

const SIGNALS: InboxSignals = {
  getStatus: getRecordStatus,
  getPriority: getRecordPriority,
  getAssignee: (record) => getFieldByRole(record, 'assignee'),
};

const PRIORITY_KEYS = ['1', '2', '3', '4'];

/** Relative age, e.g. "3d". Keeps the row narrow where a date would not. */
function ageLabel(record: TrackerRecord): string {
  const created = record.system.createdAt ? new Date(record.system.createdAt).getTime() : 0;
  if (!created || Number.isNaN(created)) return '';
  const days = Math.floor((Date.now() - created) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

export function TrackerInboxView({
  filterType = 'all',
  overrideItems,
  onItemSelect,
  selectedItemId,
  onArchiveItems,
  onDeleteItems,
  onSwitchToFilesMode,
  scope,
  onScopeChange,
  currentIdentity,
}: TrackerInboxViewProps): JSX.Element {
  const atomItems = useAtomValue(trackerItemsByTypeAtom('all'));
  const dataLoaded = useAtomValue(trackerDataLoadedAtom);
  const snoozedUntilByItemId = useAtomValue(trackerSnoozedUntilByItemIdAtom);
  const setSnooze = useSetAtom(setTrackerSnoozeAtom);
  const [collectionMenuOpen, setCollectionMenuOpen] = useState(false);

  const sourceItems = overrideItems ?? atomItems;

  const queue = useMemo(
    () => selectInboxItems(sourceItems, {
      ...SIGNALS,
      snoozedUntilByItemId,
      scope,
      selectedType: filterType,
    }),
    [sourceItems, snoozedUntilByItemId, scope, filterType],
  );

  const collectionTargets = useMemo(
    () => atomItems
      .filter((item: TrackerRecord) => !item.archived && isCollectionType(item.primaryType))
      .slice(0, 50),
    [atomItems],
  );

  const rows = useTrackerRows({
    items: queue,
    activeTypeFilter: filterType,
    onItemSelect,
    onDeleteItems,
    onArchiveItems,
    onSwitchToFilesMode,
  });
  const {
    focusedIndex,
    setFocusedIndex,
    setSelectedIds,
    containerRef,
    handleItemUpdate,
    handleRowClick,
    handleAddSelectionToCollection,
  } = rows;

  // The queue is a single-focus surface, so the hook's selection (which powers
  // "add to collection") always tracks the focused row.
  const focused = focusedIndex >= 0 ? queue[focusedIndex] : undefined;
  useEffect(() => {
    setSelectedIds(focused ? new Set([focused.id]) : new Set());
  }, [focused, setSelectedIds]);

  // Acting on an item removes it from the queue, which would leave the focus
  // ring on whatever slid into its place -- keep the index in range instead.
  useEffect(() => {
    if (queue.length === 0) {
      if (focusedIndex !== -1) setFocusedIndex(-1);
      return;
    }
    if (focusedIndex < 0) setFocusedIndex(0);
    else if (focusedIndex >= queue.length) setFocusedIndex(queue.length - 1);
  }, [queue.length, focusedIndex, setFocusedIndex]);

  const { refs, floatingStyles } = useFloating({
    open: collectionMenuOpen,
    onOpenChange: setCollectionMenuOpen,
    placement: 'top-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  const assignToMe = useCallback(async (item: TrackerRecord) => {
    const email = currentIdentity?.email;
    if (!email) return;
    await handleItemUpdate(item, { [resolveRoleFieldName(item.primaryType, 'assignee')]: email });
  }, [currentIdentity, handleItemUpdate]);

  const setPriority = useCallback(async (item: TrackerRecord, priority: string) => {
    await handleItemUpdate(item, { [resolveRoleFieldName(item.primaryType, 'priority')]: priority });
  }, [handleItemUpdate]);

  const accept = useCallback(async (item: TrackerRecord) => {
    const status = acceptStatusFor(item.primaryType);
    if (!status) return;
    await handleItemUpdate(item, { [resolveRoleFieldName(item.primaryType, 'workflowStatus')]: status });
  }, [handleItemUpdate]);

  const snooze = useCallback((item: TrackerRecord, ms: number) => {
    void setSnooze({ itemId: item.id, snoozedUntil: Date.now() + ms });
  }, [setSnooze]);

  const dismiss = useCallback((item: TrackerRecord) => {
    onArchiveItems?.([item.id], true);
  }, [onArchiveItems]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    // Cmd/Ctrl chords belong to useTrackerRows (select-all, delete).
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const item = focusedIndex >= 0 ? queue[focusedIndex] : undefined;
    if (!item) return;

    if (PRIORITY_KEYS.includes(event.key)) {
      const options = priorityOptionsFor(item.primaryType);
      const value = options[PRIORITY_KEYS.indexOf(event.key)];
      if (!value) return;
      event.preventDefault();
      void setPriority(item, value);
      return;
    }

    switch (event.key.toLowerCase()) {
      case 'j':
        event.preventDefault();
        setFocusedIndex(Math.min(focusedIndex + 1, queue.length - 1));
        break;
      case 'k':
        event.preventDefault();
        setFocusedIndex(Math.max(focusedIndex - 1, 0));
        break;
      case 'a':
        event.preventDefault();
        void assignToMe(item);
        break;
      case 'e':
        event.preventDefault();
        void accept(item);
        break;
      case 'm':
        event.preventDefault();
        setCollectionMenuOpen((open) => !open);
        break;
      case 's':
        event.preventDefault();
        snooze(item, SNOOZE_PRESETS[0].ms);
        break;
      case 'x':
        event.preventDefault();
        dismiss(item);
        break;
    }
  }, [queue, focusedIndex, setFocusedIndex, assignToMe, accept, setPriority, snooze, dismiss]);

  // Gate on the *source* set, not the queue: an empty queue over loaded items is
  // inbox zero, and showing "Loading..." for it would hide the win.
  const loading = !dataLoaded && sourceItems.length === 0;

  return (
    <div className="tracker-inbox-view h-full flex flex-col min-h-0" data-testid="tracker-inbox-view">
      <div className="flex items-center gap-3 px-3 py-2 border-b border-nim shrink-0">
        <span className="text-[12px] font-medium text-nim">
          Triage inbox
          <span className="ml-2 text-nim-faint">{queue.length}</span>
        </span>
        <div className="flex items-center rounded border border-nim overflow-hidden" role="group">
          {(['global', 'type'] as const).map((option) => (
            <button
              key={option}
              className={scope === option
                ? 'px-2 py-0.5 text-[11px] text-white bg-[var(--nim-primary)]'
                : 'px-2 py-0.5 text-[11px] text-nim-muted hover:text-nim'}
              onClick={() => onScopeChange(option)}
              data-testid={`tracker-inbox-scope-${option}`}
            >
              {option === 'global' ? 'All types' : 'This type'}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[10px] text-nim-faint select-none">
          j/k move &middot; a assign &middot; 1-4 priority &middot; e accept &middot; m milestone &middot; s snooze &middot; x dismiss
        </span>
      </div>

      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="flex-1 overflow-auto min-h-0 focus:outline-none"
        data-testid="tracker-inbox-queue"
      >
        {loading ? (
          <div className="h-full flex items-center justify-center text-sm text-nim-muted">Loading...</div>
        ) : queue.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-nim-faint">
            <MaterialSymbol icon="inbox" size={28} />
            <span className="text-sm">Inbox zero. Nothing is waiting on a decision.</span>
          </div>
        ) : (
          queue.map((item, index) => (
            <div
              key={item.id}
              className={index === focusedIndex
                ? 'flex items-center gap-2 px-3 py-2 border-b border-nim bg-nim-tertiary cursor-pointer'
                : 'flex items-center gap-2 px-3 py-2 border-b border-nim hover:bg-nim-secondary cursor-pointer'}
              onClick={(event) => handleRowClick(item, index, event)}
              onDoubleClick={() => onItemSelect?.(item.id)}
              data-testid="tracker-inbox-row"
              data-focused={index === focusedIndex ? 'true' : undefined}
              data-selected={item.id === selectedItemId ? 'true' : undefined}
            >
              <MaterialSymbol
                icon={getTypeIcon(item.primaryType)}
                size={14}
                className="shrink-0"
                style={{ color: getTypeColor(item.primaryType) }}
              />
              {item.issueKey && (
                <span className="shrink-0 text-[11px] font-mono text-nim-faint">{item.issueKey}</span>
              )}
              <span className="flex-1 truncate text-[13px] text-nim">{getRecordTitle(item)}</span>
              {isAgentProposal(item) && (
                <span
                  className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-[var(--nim-primary)] border border-[var(--nim-primary)]"
                  title="Filed by an agent -- confirm or dismiss"
                  data-testid="tracker-inbox-agent-proposal"
                >
                  <MaterialSymbol icon="smart_toy" size={11} />
                  Proposed
                </span>
              )}
              {item.source !== 'native' && (
                <span className="shrink-0 text-[10px] text-nim-faint">{item.source}</span>
              )}
              <span className="shrink-0 w-10 text-right text-[10px] text-nim-faint">{ageLabel(item)}</span>
            </div>
          ))
        )}
      </div>

      {focused && (
        <div
          className="flex items-center gap-1 px-3 py-2 border-t border-nim shrink-0"
          data-testid="tracker-inbox-actions"
        >
          <span className="mr-2 truncate text-[11px] text-nim-muted max-w-[35%]">{getRecordTitle(focused)}</span>
          <button
            className="px-2 py-1 text-[11px] text-nim-muted hover:text-nim rounded hover:bg-nim-tertiary disabled:opacity-40"
            onClick={() => void assignToMe(focused)}
            disabled={!currentIdentity?.email}
            title={currentIdentity?.email ? 'Assign to me (a)' : 'No identity configured'}
            data-testid="tracker-inbox-assign"
          >
            Assign to me
          </button>
          {priorityOptionsFor(focused.primaryType).map((priority, index) => (
            <button
              key={priority}
              className="px-2 py-1 text-[11px] text-nim-muted hover:text-nim rounded hover:bg-nim-tertiary"
              onClick={() => void setPriority(focused, priority)}
              title={`Set priority ${priority} (${index + 1})`}
              data-testid={`tracker-inbox-priority-${priority}`}
            >
              {priority}
            </button>
          ))}
          <button
            ref={refs.setReference}
            className="px-2 py-1 text-[11px] text-nim-muted hover:text-nim rounded hover:bg-nim-tertiary disabled:opacity-40"
            onClick={() => setCollectionMenuOpen((open) => !open)}
            disabled={collectionTargets.length === 0}
            title={collectionTargets.length === 0 ? 'No milestones or releases yet' : 'Add to collection (m)'}
            data-testid="tracker-inbox-collection"
          >
            Add to...
          </button>
          <button
            className="px-2 py-1 text-[11px] text-nim-muted hover:text-nim rounded hover:bg-nim-tertiary disabled:opacity-40"
            onClick={() => void accept(focused)}
            disabled={!acceptStatusFor(focused.primaryType)}
            title="Accept -- move to the working status (e)"
            data-testid="tracker-inbox-accept"
          >
            Accept
          </button>
          {SNOOZE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className="px-2 py-1 text-[11px] text-nim-muted hover:text-nim rounded hover:bg-nim-tertiary"
              onClick={() => snooze(focused, preset.ms)}
              title={`Snooze until ${preset.label.toLowerCase()}`}
              data-testid={`tracker-inbox-snooze-${preset.id}`}
            >
              {preset.label}
            </button>
          ))}
          <button
            className="ml-auto px-2 py-1 text-[11px] text-nim-muted hover:text-[#ef4444] rounded hover:bg-nim-tertiary"
            onClick={() => dismiss(focused)}
            title="Dismiss -- archive the item (x)"
            data-testid="tracker-inbox-dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

      {collectionMenuOpen && focused && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            className="z-50 min-w-[200px] max-h-[280px] overflow-auto py-1 bg-nim-secondary border border-nim rounded-md shadow-lg"
            data-testid="tracker-inbox-collection-menu"
          >
            {collectionTargets.map((collection) => (
              <button
                key={collection.id}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] text-nim-muted hover:text-nim hover:bg-nim-tertiary"
                onClick={() => {
                  setCollectionMenuOpen(false);
                  void handleAddSelectionToCollection(collection);
                }}
              >
                <MaterialSymbol
                  icon={getTypeIcon(collection.primaryType)}
                  size={13}
                  style={{ color: getTypeColor(collection.primaryType) }}
                />
                <span className="truncate">{getRecordTitle(collection)}</span>
              </button>
            ))}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}
