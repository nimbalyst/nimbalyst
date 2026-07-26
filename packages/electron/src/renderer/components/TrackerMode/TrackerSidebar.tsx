import React, { useEffect, useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { TrackerIdentity, TrackerItemType } from '@nimbalyst/runtime';
import { trackerDataLoadedAtom, trackerItemsArrayAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin';
import type { TrackerDataModel, TrackerFilterSet } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { generateKeyBetween } from '@nimbalyst/runtime/utils/fractionalIndex';
import type { TrackerNavigationEntry, TrackerNavigationFolder, TrackerTypePlacement } from '@nimbalyst/runtime/sync';
import type { TrackerFilterChip } from '../../store/atoms/trackers';
import type { ViewMode } from './TrackerMainView';
import type { SavedView } from './trackerSavedViews';
import { WorkspaceSummaryHeader } from '../WorkspaceSummaryHeader';
import { AlphaBadge } from '../common/AlphaBadge';
import { FloatingPortal, useFloatingMenu, virtualElement } from '../../hooks/useFloatingMenu';
import { buildTrackerNavigationTree } from './trackerNavigationTree';
import { trackerSyncConnectionAtom } from '../../store/atoms/trackerSync';
import { trackerSnoozedUntilByItemIdAtom } from '../../store/atoms/trackerPersonalState';
import { countInboxItems, type InboxSignals } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  getRecordPriority,
  getRecordStatus,
  getFieldByRole,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { countFilteredTrackerItemsByTypes } from './trackerSavedViews';

/** Same accessors the inbox view uses, so the badge and the queue can't disagree. */
const INBOX_SIGNALS: InboxSignals = {
  getStatus: getRecordStatus,
  getPriority: getRecordPriority,
  getAssignee: (record) => getFieldByRole(record, 'assignee'),
};

interface TrackerSidebarProps {
  workspacePath?: string;
  workspaceName?: string;
  trackerTypes: TrackerDataModel[];
  navigationEntries: TrackerNavigationEntry[];
  selectedType: string | 'all';
  activeFilters: TrackerFilterChip[];
  tagFilter: string[];
  sourceFilter: string[];
  currentIdentity: TrackerIdentity | null;
  favoriteItemIds: ReadonlySet<string>;
  viewedAtByItemId: ReadonlyMap<string, number>;
  personalStateHydrated: boolean;
  recentlyViewedDays: 7 | 30 | 90 | null;
  columnFilters: TrackerFilterSet | null;
  viewMode: ViewMode;
  onSelectType: (type: string | 'all') => void;
  onViewModeChange: (mode: ViewMode) => void;
  /** Saved views for this workspace (NIM-788). */
  savedViews: SavedView[];
  /** View currently represented by the main header. */
  activeSavedViewId: string | null;
  /** Apply a saved view's definition. */
  onApplyView: (view: SavedView) => void;
  /** Delete a saved view. Deleting a shared view removes it for the team. */
  onDeleteView: (view: SavedView) => void;
  /** Share the view with the team, or stop sharing it. */
  onToggleShareView: (view: SavedView) => void;
  onSaveNavigationEntry: (entry: TrackerNavigationEntry) => Promise<void>;
  onDeleteFolder: (folderId: string) => Promise<void>;
}

interface SidebarCountProps {
  activeFilters: TrackerFilterChip[];
  tagFilter: string[];
  sourceFilter: string[];
  currentIdentity: TrackerIdentity | null;
  favoriteItemIds: ReadonlySet<string>;
  viewedAtByItemId: ReadonlyMap<string, number>;
  personalStateHydrated: boolean;
  recentlyViewedDays: 7 | 30 | 90 | null;
  columnFilters: TrackerFilterSet | null;
  nowMs: number;
}

/** Small component so each sidebar row subscribes to the tracker item store. */
function SidebarTypeCount({
  type,
  activeFilters,
  tagFilter,
  sourceFilter,
  currentIdentity,
  favoriteItemIds,
  viewedAtByItemId,
  personalStateHydrated,
  recentlyViewedDays,
  columnFilters,
  nowMs,
}: SidebarCountProps & { type: TrackerItemType }) {
  const loaded = useAtomValue(trackerDataLoadedAtom);
  const items = useAtomValue(trackerItemsArrayAtom);
  const count = useMemo(() => countFilteredTrackerItemsByTypes(
    items,
    [type],
    { activeFilters, tagFilter, sourceFilter, recentlyViewedDays, columnFilters },
    { identity: currentIdentity, favoriteItemIds, viewedAtByItemId, nowMs },
  ), [items, type, activeFilters, tagFilter, sourceFilter, currentIdentity, favoriteItemIds, viewedAtByItemId, recentlyViewedDays, columnFilters, nowMs]);
  // NIM-631: before the tracker atoms finish hydrating, the count map is empty,
  // so populated types would flash "0" during a sync reconnect + renderer
  // reload. Suppress the badge until hydration completes rather than showing a
  // misleading zero.
  if (!loaded || (!personalStateHydrated && (
    activeFilters.some((filter) => filter === 'favorites' || filter === 'recently-viewed')
    || (columnFilters?.clauses ?? []).some(clause => clause.field === 'favorite' || clause.field === 'viewed')
  ))) return null;
  return <>{count}</>;
}

/**
 * Corner badge on the inbox button: how many items are waiting on a decision,
 * falling back to the alpha dot when there is nothing to triage. Subscribes to
 * the item store itself so the rest of the sidebar doesn't re-render on every
 * tracker write, and so the inbox announces work instead of waiting to be found.
 */
function InboxButtonBadge(): React.ReactElement {
  const loaded = useAtomValue(trackerDataLoadedAtom);
  const items = useAtomValue(trackerItemsArrayAtom);
  const snoozedUntilByItemId = useAtomValue(trackerSnoozedUntilByItemIdAtom);
  const count = useMemo(
    () => countInboxItems(items, { ...INBOX_SIGNALS, snoozedUntilByItemId }),
    [items, snoozedUntilByItemId],
  );
  // Suppress a "0" while the atoms hydrate -- it would read as inbox zero.
  if (!loaded || count === 0) {
    return <AlphaBadge size="dot" className="absolute -top-1 -right-1 pointer-events-none" />;
  }
  return (
    <span
      className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-[3px] flex items-center justify-center rounded-full text-[9px] font-medium text-white bg-[var(--nim-primary)] pointer-events-none"
      data-testid="tracker-inbox-count"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function SidebarFolderCount({
  types,
  activeFilters,
  tagFilter,
  sourceFilter,
  currentIdentity,
  favoriteItemIds,
  viewedAtByItemId,
  personalStateHydrated,
  recentlyViewedDays,
  columnFilters,
  nowMs,
}: SidebarCountProps & { types: string[] }) {
  const loaded = useAtomValue(trackerDataLoadedAtom);
  const items = useAtomValue(trackerItemsArrayAtom);
  const count = useMemo(() => countFilteredTrackerItemsByTypes(
    items,
    types,
    { activeFilters, tagFilter, sourceFilter, recentlyViewedDays, columnFilters },
    { identity: currentIdentity, favoriteItemIds, viewedAtByItemId, nowMs },
  ), [items, types, activeFilters, tagFilter, sourceFilter, currentIdentity, favoriteItemIds, viewedAtByItemId, recentlyViewedDays, columnFilters, nowMs]);
  if (!loaded || (!personalStateHydrated && (
    activeFilters.some((filter) => filter === 'favorites' || filter === 'recently-viewed')
    || (columnFilters?.clauses ?? []).some(clause => clause.field === 'favorite' || clause.field === 'viewed')
  ))) return null;
  return <>{count}</>;
}

export const TrackerSidebar: React.FC<TrackerSidebarProps> = ({
  workspacePath,
  workspaceName,
  trackerTypes,
  navigationEntries,
  selectedType,
  activeFilters,
  tagFilter,
  sourceFilter,
  currentIdentity,
  favoriteItemIds,
  viewedAtByItemId,
  personalStateHydrated,
  recentlyViewedDays,
  columnFilters,
  viewMode,
  onSelectType,
  onViewModeChange,
  savedViews,
  activeSavedViewId,
  onApplyView,
  onDeleteView,
  onToggleShareView,
  onSaveNavigationEntry,
  onDeleteFolder,
}) => {
  const trackerSyncConnection = useAtomValue(trackerSyncConnectionAtom);
  const isSharedLayout = !!workspacePath &&
    trackerSyncConnection?.workspacePath === workspacePath &&
    trackerSyncConnection.projectId !== null;
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [draggedEntryId, setDraggedEntryId] = useState<string | null>(null);
  const [contextFolder, setContextFolder] = useState<TrackerNavigationFolder | null>(null);
  const [contextPoint, setContextPoint] = useState({ x: 0, y: 0 });
  const hasRelativeFilters = (columnFilters?.clauses ?? []).some(clause =>
    clause.op === 'in-last' || clause.op === 'not-in-last');
  const [filterClockMs, setFilterClockMs] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRelativeFilters) return;
    setFilterClockMs(Date.now());
    const interval = window.setInterval(() => setFilterClockMs(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, [hasRelativeFilters]);
  const contextReference = useMemo(
    () => virtualElement(contextPoint.x, contextPoint.y),
    [contextPoint],
  );
  const folderMenu = useFloatingMenu({
    placement: 'right-start',
    reference: contextReference,
    open: contextFolder !== null,
    onOpenChange: (open) => { if (!open) setContextFolder(null); },
  });
  const navigationTree = useMemo(
    () => buildTrackerNavigationTree(trackerTypes, navigationEntries),
    [trackerTypes, navigationEntries],
  );

  const saveEntry = (entry: TrackerNavigationEntry) => {
    void onSaveNavigationEntry(entry).catch((error) => {
      console.error('[TrackerSidebar] Failed to save tracker navigation:', error);
    });
  };

  const commitCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    const folderId = crypto.randomUUID();
    const lastKey = navigationTree.folders.at(-1)?.folder.sortKey ?? null;
    saveEntry({
      entryId: `folder:${folderId}`,
      kind: 'folder',
      folderId,
      name,
      sortKey: generateKeyBetween(lastKey, null),
    });
    setExpandedFolders((current) => new Set(current).add(folderId));
    setNewFolderName('');
    setCreatingFolder(false);
  };

  const commitRenameFolder = (folder: TrackerNavigationFolder) => {
    const name = renameValue.trim();
    if (name && name !== folder.name) saveEntry({ ...folder, name });
    setRenamingFolderId(null);
    setRenameValue('');
  };

  const appendTypeToFolder = (placement: TrackerTypePlacement, folderId: string | null) => {
    const siblings = folderId === null
      ? navigationTree.rootTypes
      : navigationTree.folders.find((node) => node.folder.folderId === folderId)?.trackerTypes ?? [];
    const remaining = siblings.filter((row) => row.placement.entryId !== placement.entryId);
    saveEntry({
      ...placement,
      folderId,
      sortKey: generateKeyBetween(remaining.at(-1)?.placement.sortKey ?? null, null),
    });
  };

  const insertTypeBefore = (placement: TrackerTypePlacement, target: TrackerTypePlacement) => {
    const siblings = target.folderId === null
      ? navigationTree.rootTypes
      : navigationTree.folders.find((node) => node.folder.folderId === target.folderId)?.trackerTypes ?? [];
    const remaining = siblings.filter((row) => row.placement.entryId !== placement.entryId);
    const targetIndex = remaining.findIndex((row) => row.placement.entryId === target.entryId);
    const previousKey = targetIndex > 0 ? remaining[targetIndex - 1].placement.sortKey : null;
    saveEntry({
      ...placement,
      folderId: target.folderId,
      sortKey: generateKeyBetween(previousKey, target.sortKey),
    });
  };

  const insertFolderBefore = (folder: TrackerNavigationFolder, target: TrackerNavigationFolder) => {
    const remaining = navigationTree.folders.filter((node) => node.folder.entryId !== folder.entryId);
    const targetIndex = remaining.findIndex((node) => node.folder.entryId === target.entryId);
    const previousKey = targetIndex > 0 ? remaining[targetIndex - 1].folder.sortKey : null;
    saveEntry({ ...folder, sortKey: generateKeyBetween(previousKey, target.sortKey) });
  };

  const appendFolder = (folder: TrackerNavigationFolder) => {
    const remaining = navigationTree.folders.filter((node) => node.folder.entryId !== folder.entryId);
    saveEntry({
      ...folder,
      sortKey: generateKeyBetween(remaining.at(-1)?.folder.sortKey ?? null, null),
    });
  };

  const draggedEntry = draggedEntryId
    ? navigationEntries.find((entry) => entry.entryId === draggedEntryId) ?? null
    : null;

  const renderTypeRow = (
    tracker: TrackerDataModel,
    placement: TrackerTypePlacement,
    nested = false,
  ) => (
    <button
      key={tracker.type}
      draggable
      data-testid="tracker-type-button"
      data-tracker-type={tracker.type}
      className={`w-full flex items-center gap-2 pr-2 py-1.5 rounded-md text-sm transition-colors ${nested ? 'pl-7' : 'pl-2'} ${
        selectedType === tracker.type
          ? 'bg-nim-active text-nim'
          : 'text-nim-muted hover:bg-nim-tertiary hover:text-nim'
      }`}
      onClick={() => onSelectType(tracker.type)}
      onDragStart={(event) => {
        setDraggedEntryId(placement.entryId);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', placement.entryId);
      }}
      onDragEnd={() => setDraggedEntryId(null)}
      onDragOver={(event) => {
        if (draggedEntry?.kind === 'type-placement') event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (draggedEntry?.kind === 'type-placement' && draggedEntry.entryId !== placement.entryId) {
          insertTypeBefore(draggedEntry, placement);
        }
        setDraggedEntryId(null);
      }}
    >
      <span style={{ color: tracker.color }}>
        <MaterialSymbol icon={tracker.icon} size={16} />
      </span>
      <span className="flex-1 text-left truncate">{tracker.displayNamePlural}</span>
      <span className="text-[10px] font-semibold text-nim-faint min-w-[20px] text-right">
        <SidebarTypeCount
          type={tracker.type as TrackerItemType}
          activeFilters={activeFilters}
          tagFilter={tagFilter}
          sourceFilter={sourceFilter}
          currentIdentity={currentIdentity}
          favoriteItemIds={favoriteItemIds}
          viewedAtByItemId={viewedAtByItemId}
          personalStateHydrated={personalStateHydrated}
          recentlyViewedDays={recentlyViewedDays}
          columnFilters={columnFilters}
          nowMs={filterClockMs}
        />
      </span>
    </button>
  );

  return (
    <div className="tracker-sidebar w-full h-full flex flex-col bg-nim-secondary overflow-hidden" data-testid="tracker-sidebar">
      {workspacePath && (
        <WorkspaceSummaryHeader
          workspacePath={workspacePath}
          workspaceName={workspaceName}
          actions={
            <>
              <div className="flex items-center rounded border border-nim overflow-hidden">
                  <button
                    className={`flex items-center justify-center w-7 h-6 transition-colors ${
                      viewMode === 'list'
                        ? 'bg-nim-active text-nim'
                        : 'bg-nim-secondary text-nim-muted hover:text-nim'
                    }`}
                    onClick={() => onViewModeChange('list')}
                    title="List view"
                    data-testid="tracker-view-mode-list"
                  >
                    <MaterialSymbol icon="view_list" size={16} />
                  </button>
                  <button
                    className={`flex items-center justify-center w-7 h-6 border-l border-nim transition-colors ${
                      viewMode === 'table'
                        ? 'bg-nim-active text-nim'
                        : 'bg-nim-secondary text-nim-muted hover:text-nim'
                    }`}
                    onClick={() => onViewModeChange('table')}
                    title="Table view"
                    data-testid="tracker-view-mode-table"
                  >
                    <MaterialSymbol icon="table_chart" size={16} />
                  </button>
                  <button
                    className={`relative flex items-center justify-center w-7 h-6 border-l border-nim transition-colors ${
                      viewMode === 'kanban'
                        ? 'bg-nim-active text-nim'
                        : 'bg-nim-secondary text-nim-muted hover:text-nim'
                    }`}
                    onClick={() => onViewModeChange('kanban')}
                    title="Kanban view (alpha)"
                    data-testid="tracker-view-mode-kanban"
                  >
                    <MaterialSymbol icon="view_kanban" size={16} />
                    <AlphaBadge size="dot" className="absolute -top-1 -right-1 pointer-events-none" />
                  </button>
                  <button
                    className={`relative flex items-center justify-center w-7 h-6 border-l border-nim transition-colors ${
                      viewMode === 'tag-board'
                        ? 'bg-nim-active text-nim'
                        : 'bg-nim-secondary text-nim-muted hover:text-nim'
                    }`}
                    onClick={() => onViewModeChange('tag-board')}
                    title="Tag board view (alpha)"
                    data-testid="tracker-view-mode-tag-board"
                  >
                    <MaterialSymbol icon="sell" size={16} />
                    <AlphaBadge size="dot" className="absolute -top-1 -right-1 pointer-events-none" />
                  </button>
                  <button
                    className={`relative flex items-center justify-center w-7 h-6 border-l border-nim transition-colors ${
                      viewMode === 'inbox'
                        ? 'bg-nim-active text-nim'
                        : 'bg-nim-secondary text-nim-muted hover:text-nim'
                    }`}
                    onClick={() => onViewModeChange('inbox')}
                    title="Triage inbox (alpha)"
                    data-testid="tracker-view-mode-inbox"
                  >
                    <MaterialSymbol icon="inbox" size={16} />
                    <InboxButtonBadge />
                  </button>
                </div>
            </>
          }
        />
      )}
      <div className="px-3 py-1.5 border-b border-nim text-[11px] font-semibold text-nim-muted uppercase tracking-wider">
        Trackers
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Saved Views Section (NIM-788) */}
        <div className="px-2 pt-2 pb-1" data-testid="tracker-saved-views">
          <div className="flex items-center justify-between px-1 mb-1.5">
            <span className="text-[10px] font-semibold text-nim-faint uppercase tracking-wider">
              Saved Views
            </span>
          </div>

          {savedViews.length === 0 ? (
            <div className="px-1 text-[10px] text-nim-faint italic">
              Saved views will appear here.
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {savedViews.map((view) => (
                <div
                  key={view.id}
                  className={`group flex items-center gap-1 rounded-md ${
                    activeSavedViewId === view.id ? 'bg-nim-active' : 'hover:bg-nim-tertiary'
                  }`}
                  data-testid="tracker-saved-view-item"
                >
                  <button
                    className="flex-1 flex items-center gap-2 px-2 py-1.5 text-left text-[12px] text-nim-muted hover:text-nim min-w-0"
                    onClick={() => onApplyView(view)}
                    title={`Apply view: ${view.name}`}
                  >
                    <MaterialSymbol icon="bookmark" size={13} className="shrink-0" />
                    <span className="flex-1 truncate">{view.name}</span>
                    {view.shared && (
                      <MaterialSymbol
                        icon="group"
                        size={12}
                        className="shrink-0 text-nim-faint"
                        title="Shared with this team"
                      />
                    )}
                  </button>
                  {isSharedLayout && (
                    <button
                      className={view.shared
                        ? 'px-1.5 text-[var(--nim-primary)]'
                        : 'opacity-0 group-hover:opacity-100 px-1.5 text-nim-faint hover:text-nim transition-opacity'}
                      onClick={() => onToggleShareView(view)}
                      title={view.shared ? 'Stop sharing with the team' : 'Share view with the team'}
                      data-testid="tracker-saved-view-share"
                    >
                      <MaterialSymbol icon={view.shared ? 'group' : 'group_add'} size={13} />
                    </button>
                  )}
                  <button
                    className="opacity-0 group-hover:opacity-100 px-1.5 text-nim-faint hover:text-[#ef4444] transition-opacity"
                    onClick={() => onDeleteView(view)}
                    title={view.shared ? 'Delete view for the whole team' : 'Delete view'}
                    data-testid="tracker-saved-view-delete"
                  >
                    <MaterialSymbol icon="close" size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Types Section */}
        <div className="px-1.5 py-2 border-t border-nim mt-1">
          <div
            className="flex items-center justify-between px-2 mb-1"
            onDragOver={(event) => {
              if (draggedEntry?.kind === 'folder') event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (draggedEntry?.kind === 'folder') appendFolder(draggedEntry);
              setDraggedEntryId(null);
            }}
          >
            <span className="text-[10px] font-semibold text-nim-faint uppercase tracking-wider">
              Types
            </span>
            <span className="flex items-center gap-1">
              {isSharedLayout && (
                <span className="text-nim-faint" title="Folder organization is shared with this team">
                  <MaterialSymbol icon="group" size={13} />
                </span>
              )}
              <button
                className="flex items-center justify-center text-nim-faint hover:text-nim transition-colors"
                title="New tracker folder"
                data-testid="tracker-folder-add"
                onClick={() => setCreatingFolder((value) => !value)}
              >
                <MaterialSymbol icon="create_new_folder" size={14} />
              </button>
            </span>
          </div>

          {creatingFolder && (
            <div className="flex items-center gap-1 px-1 mb-1" data-testid="tracker-folder-create-row">
              <MaterialSymbol icon="folder" size={15} className="text-nim-muted" />
              <input
                autoFocus
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') commitCreateFolder();
                  if (event.key === 'Escape') {
                    setCreatingFolder(false);
                    setNewFolderName('');
                  }
                }}
                onBlur={() => {
                  setCreatingFolder(false);
                  setNewFolderName('');
                }}
                placeholder="Folder name"
                className="min-w-0 flex-1 px-2 py-1 text-xs bg-nim border border-nim rounded text-nim placeholder:text-nim-faint focus:outline-none focus:border-nim-focus"
              />
            </div>
          )}

          {/* All */}
          <button
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors ${
              selectedType === 'all'
                ? 'bg-nim-active text-nim'
                : 'text-nim-muted hover:bg-nim-tertiary hover:text-nim'
            }`}
            onClick={() => onSelectType('all')}
            onDragOver={(event) => {
              if (draggedEntry?.kind === 'type-placement') event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (draggedEntry?.kind === 'type-placement') appendTypeToFolder(draggedEntry, null);
              setDraggedEntryId(null);
            }}
          >
            <MaterialSymbol icon="checklist" size={16} />
            <span className="flex-1 text-left truncate">All</span>
          </button>

          {navigationTree.folders.map(({ folder, trackerTypes: folderTypes }) => {
            const expanded = expandedFolders.has(folder.folderId);
            const renaming = renamingFolderId === folder.folderId;
            return (
              <React.Fragment key={folder.entryId}>
                <div
                  draggable={!renaming}
                  data-testid="tracker-folder-row"
                  data-folder-id={folder.folderId}
                  className="group flex items-center gap-1 w-full px-1 py-1 rounded-md text-sm text-nim-muted hover:bg-nim-tertiary hover:text-nim"
                  onDragStart={(event) => {
                    setDraggedEntryId(folder.entryId);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', folder.entryId);
                  }}
                  onDragEnd={() => setDraggedEntryId(null)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (draggedEntry?.kind === 'type-placement') {
                      appendTypeToFolder(draggedEntry, folder.folderId);
                      setExpandedFolders((current) => new Set(current).add(folder.folderId));
                    } else if (draggedEntry?.kind === 'folder' && draggedEntry.entryId !== folder.entryId) {
                      insertFolderBefore(draggedEntry, folder);
                    }
                    setDraggedEntryId(null);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextPoint({ x: event.clientX, y: event.clientY });
                    setContextFolder(folder);
                  }}
                >
                  <button
                    className="flex items-center justify-center w-4 h-5 shrink-0"
                    title={expanded ? 'Collapse folder' : 'Expand folder'}
                    onClick={() => setExpandedFolders((current) => {
                      const next = new Set(current);
                      if (expanded) next.delete(folder.folderId);
                      else next.add(folder.folderId);
                      return next;
                    })}
                  >
                    <MaterialSymbol icon={expanded ? 'expand_more' : 'chevron_right'} size={15} />
                  </button>
                  <MaterialSymbol icon={expanded ? 'folder_open' : 'folder'} size={16} />
                  {renaming ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Enter') commitRenameFolder(folder);
                        if (event.key === 'Escape') setRenamingFolderId(null);
                      }}
                      onBlur={() => {
                        setRenamingFolderId(null);
                        setRenameValue('');
                      }}
                      className="min-w-0 flex-1 px-1 py-0.5 text-xs bg-nim border border-nim-focus rounded text-nim outline-none"
                    />
                  ) : (
                    <button
                      className="min-w-0 flex-1 text-left truncate"
                      onClick={() => setExpandedFolders((current) => {
                        const next = new Set(current);
                        if (expanded) next.delete(folder.folderId);
                        else next.add(folder.folderId);
                        return next;
                      })}
                    >
                      {folder.name}
                    </button>
                  )}
                  <span className="text-[10px] font-semibold text-nim-faint min-w-[20px] text-right">
                    <SidebarFolderCount
                      types={folderTypes.map((row) => row.tracker.type)}
                      activeFilters={activeFilters}
                      tagFilter={tagFilter}
                      sourceFilter={sourceFilter}
                      currentIdentity={currentIdentity}
                      favoriteItemIds={favoriteItemIds}
                      viewedAtByItemId={viewedAtByItemId}
                      personalStateHydrated={personalStateHydrated}
                      recentlyViewedDays={recentlyViewedDays}
                      columnFilters={columnFilters}
                      nowMs={filterClockMs}
                    />
                  </span>
                  <button
                    className="opacity-0 group-hover:opacity-100 text-nim-faint hover:text-nim"
                    title="Folder actions"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      setContextPoint({ x: rect.right, y: rect.bottom });
                      setContextFolder(folder);
                    }}
                  >
                    <MaterialSymbol icon="more_horiz" size={14} />
                  </button>
                </div>
                {expanded && folderTypes.map(({ tracker, placement }) => renderTypeRow(tracker, placement, true))}
              </React.Fragment>
            );
          })}

          {navigationTree.rootTypes.map(({ tracker, placement }) => renderTypeRow(tracker, placement))}
        </div>
      </div>

      {contextFolder && (
        <FloatingPortal>
          <div
            ref={folderMenu.refs.setFloating}
            style={folderMenu.floatingStyles}
            {...folderMenu.getFloatingProps()}
            className="tracker-folder-context-menu z-[10000] min-w-[170px] p-1 rounded-md border border-nim bg-nim shadow-lg"
          >
            <button
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-nim-muted hover:bg-nim-tertiary hover:text-nim"
              onClick={() => {
                setRenamingFolderId(contextFolder.folderId);
                setRenameValue(contextFolder.name);
                setExpandedFolders((current) => new Set(current).add(contextFolder.folderId));
                setContextFolder(null);
              }}
            >
              <MaterialSymbol icon="edit" size={14} /> Rename folder
            </button>
            <button
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-nim-error hover:bg-nim-tertiary"
              onClick={() => {
                const folder = contextFolder;
                setContextFolder(null);
                if (window.confirm(`Delete folder “${folder.name}”? Its tracker types will move to the root.`)) {
                  void onDeleteFolder(folder.folderId).catch((error) => {
                    console.error('[TrackerSidebar] Failed to delete tracker folder:', error);
                  });
                }
              }}
            >
              <MaterialSymbol icon="delete" size={14} /> Delete folder
            </button>
          </div>
        </FloatingPortal>
      )}
    </div>
  );
};
