import React, { useEffect, useMemo, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { TrackerIdentity, TrackerItemType } from '@nimbalyst/runtime';
import { trackerDataLoadedAtom, trackerItemsArrayAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin';
import type { TrackerDataModel, TrackerFilterSet } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import type { Readiness } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerReadiness';
import { generateKeyBetween } from '@nimbalyst/runtime/utils/fractionalIndex';
import type { TrackerNavigationEntry, TrackerNavigationFolder, TrackerTypePlacement } from '@nimbalyst/runtime/sync';
import {
  setTrackerModeLayoutAtom,
  trackerSidebarCollapsedSectionsAtom,
  trackerSidebarExpandedFoldersAtom,
  type TrackerFilterChip,
  type TrackerStatusScope,
} from '../../store/atoms/trackers';
import type { TrackerViewMode } from './trackerViewModes';
import type { SavedView } from './trackerSavedViews';
import { WorkspaceSummaryHeader } from '../WorkspaceSummaryHeader';
import { AlphaBadge } from '../common/AlphaBadge';
import { FloatingPortal, useFloatingMenu, virtualElement } from '../../hooks/useFloatingMenu';
import {
  buildTrackerNavigationTree,
  folderOwnershipOf,
  partitionTrackerNavigationByOwnership,
  trackerOwnershipOf,
  type TrackerNavigationTree,
  type TrackerOwnership,
} from './trackerNavigationTree';
import { toggleListEntry } from './trackerSidebarCollapse';
import type { TrackerTeam } from './useTrackerTeamMembers';
import type { OwnershipMember } from '../common/TrackerOwnershipChip';
import { TrackerOwnershipSection } from './TrackerOwnershipSection';
import {
  ALL_TRACKERS_NAV_MODEL,
  TrackerNavTypeRow,
  TrackerSavedViewsSection,
} from '@nimbalyst/collab-client/trackers-ui';
import { trackerSyncConnectionAtom } from '../../store/atoms/trackerSync';
import { requestConfirmation } from '../../dialogs/requestConfirmation';
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
  readinessByItemId: ReadonlyMap<string, Readiness>;
  personalStateHydrated: boolean;
  recentlyViewedDays: 7 | 30 | 90 | null;
  columnFilters: TrackerFilterSet | null;
  statusScope: TrackerStatusScope;
  /**
   * The chosen mode, which may be one this shortcut row has no button for
   * (`timeline`) -- Display Settings is the full control surface.
   */
  viewMode: TrackerViewMode;
  onSelectType: (type: string | 'all') => void;
  onViewModeChange: (mode: TrackerViewMode) => void;
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
  /** The workspace's team, or null for a solo user (no ownership sections at all). */
  team: TrackerTeam | null;
  teamMembers: OwnershipMember[];
}

interface SidebarCountProps {
  activeFilters: TrackerFilterChip[];
  tagFilter: string[];
  sourceFilter: string[];
  currentIdentity: TrackerIdentity | null;
  favoriteItemIds: ReadonlySet<string>;
  viewedAtByItemId: ReadonlyMap<string, number>;
  readinessByItemId: ReadonlyMap<string, Readiness>;
  personalStateHydrated: boolean;
  recentlyViewedDays: 7 | 30 | 90 | null;
  columnFilters: TrackerFilterSet | null;
  /**
   * The lifecycle scope the main view is showing. The count has to inherit it,
   * or "Bugs 128" would be counting closed bugs the list beside it is hiding.
   */
  statusScope: TrackerStatusScope;
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
  readinessByItemId,
  personalStateHydrated,
  recentlyViewedDays,
  columnFilters,
  statusScope,
  nowMs,
}: SidebarCountProps & { type: TrackerItemType }) {
  const loaded = useAtomValue(trackerDataLoadedAtom);
  const items = useAtomValue(trackerItemsArrayAtom);
  const count = useMemo(() => countFilteredTrackerItemsByTypes(
    items,
    [type],
    { activeFilters, tagFilter, sourceFilter, recentlyViewedDays, columnFilters, statusScope },
    { identity: currentIdentity, favoriteItemIds, viewedAtByItemId, readinessByItemId, nowMs },
  ), [items, type, activeFilters, tagFilter, sourceFilter, currentIdentity, favoriteItemIds, viewedAtByItemId, readinessByItemId, recentlyViewedDays, columnFilters, statusScope, nowMs]);
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
  readinessByItemId,
  personalStateHydrated,
  recentlyViewedDays,
  columnFilters,
  statusScope,
  nowMs,
}: SidebarCountProps & { types: string[] }) {
  const loaded = useAtomValue(trackerDataLoadedAtom);
  const items = useAtomValue(trackerItemsArrayAtom);
  const count = useMemo(() => countFilteredTrackerItemsByTypes(
    items,
    types,
    { activeFilters, tagFilter, sourceFilter, recentlyViewedDays, columnFilters, statusScope },
    { identity: currentIdentity, favoriteItemIds, viewedAtByItemId, readinessByItemId, nowMs },
  ), [items, types, activeFilters, tagFilter, sourceFilter, currentIdentity, favoriteItemIds, viewedAtByItemId, readinessByItemId, recentlyViewedDays, columnFilters, statusScope, nowMs]);
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
  readinessByItemId,
  personalStateHydrated,
  recentlyViewedDays,
  columnFilters,
  statusScope,
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
  team,
  teamMembers,
}) => {
  const trackerSyncConnection = useAtomValue(trackerSyncConnectionAtom);
  const isSharedLayout = !!workspacePath &&
    trackerSyncConnection?.workspacePath === workspacePath &&
    trackerSyncConnection.projectId !== null;
  // Which section is taking a folder name right now. A folder is born owned by
  // the section you created it in, so there is nothing to disambiguate later.
  const [creatingFolderIn, setCreatingFolderIn] = useState<TrackerOwnership | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  // Collapse state lives in the persisted mode layout so it survives remounts
  // and restarts (folders used to reset to all-collapsed on every remount).
  const collapsedSections = useAtomValue(trackerSidebarCollapsedSectionsAtom);
  const expandedFolderIds = useAtomValue(trackerSidebarExpandedFoldersAtom);
  const setModeLayout = useSetAtom(setTrackerModeLayoutAtom);
  const expandedFolders = useMemo(() => new Set(expandedFolderIds), [expandedFolderIds]);
  const setFolderExpanded = (folderId: string, expanded: boolean) =>
    setModeLayout({ expandedNavFolders: toggleListEntry(expandedFolderIds, folderId, expanded) });
  const toggleSectionCollapsed = (ownership: TrackerOwnership) =>
    setModeLayout({
      collapsedOwnershipSections: toggleListEntry(
        collapsedSections,
        ownership,
        !collapsedSections.includes(ownership),
      ),
    });
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
  // Ownership is legible here or nowhere: this is where you pick what to work
  // in. With no team there is nothing to distinguish, so the sections -- and
  // every word about sharing -- stay away entirely.
  const ownershipSections = useMemo(
    () => partitionTrackerNavigationByOwnership(navigationTree, { hasTeam: team !== null }),
    [navigationTree, team],
  );

  const saveEntry = (entry: TrackerNavigationEntry) => {
    void onSaveNavigationEntry(entry).catch((error) => {
      console.error('[TrackerSidebar] Failed to save tracker navigation:', error);
    });
  };

  const foldersOwnedBy = (ownership: TrackerOwnership) =>
    navigationTree.folders.filter((node) => folderOwnershipOf(node.folder) === ownership);

  const commitCreateFolder = (ownership: TrackerOwnership) => {
    const name = newFolderName.trim();
    if (!name) return;
    const folderId = crypto.randomUUID();
    const lastKey = foldersOwnedBy(ownership).at(-1)?.folder.sortKey ?? null;
    saveEntry({
      entryId: `folder:${folderId}`,
      kind: 'folder',
      folderId,
      name,
      ownership,
      sortKey: generateKeyBetween(lastKey, null),
    });
    setFolderExpanded(folderId, true);
    setNewFolderName('');
    setCreatingFolderIn(null);
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

  // Reordering happens among a folder's own section: sort keys are only ever
  // compared against same-ownership siblings, so a drag can't interleave the
  // two lists.
  const insertFolderBefore = (folder: TrackerNavigationFolder, target: TrackerNavigationFolder) => {
    const remaining = foldersOwnedBy(folderOwnershipOf(target))
      .filter((node) => node.folder.entryId !== folder.entryId);
    const targetIndex = remaining.findIndex((node) => node.folder.entryId === target.entryId);
    const previousKey = targetIndex > 0 ? remaining[targetIndex - 1].folder.sortKey : null;
    saveEntry({ ...folder, sortKey: generateKeyBetween(previousKey, target.sortKey) });
  };

  const appendFolder = (folder: TrackerNavigationFolder) => {
    const remaining = foldersOwnedBy(folderOwnershipOf(folder))
      .filter((node) => node.folder.entryId !== folder.entryId);
    saveEntry({
      ...folder,
      sortKey: generateKeyBetween(remaining.at(-1)?.folder.sortKey ?? null, null),
    });
  };

  const draggedEntry = draggedEntryId
    ? navigationEntries.find((entry) => entry.entryId === draggedEntryId) ?? null
    : null;

  /**
   * Whose the dragged row is. A tracker's owner is its `sharing`, and a drag
   * never changes that -- dropping into a folder of the other ownership is
   * simply refused (no `preventDefault`, so the cursor shows no-drop). Sharing a
   * tracker has server consequences and stays a deliberate act in the sharing
   * control.
   */
  const ownershipOfDragged = (): TrackerOwnership | null => {
    if (!draggedEntry) return null;
    if (draggedEntry.kind === 'folder') return folderOwnershipOf(draggedEntry);
    const tracker = trackerTypes.find((model) => model.type === draggedEntry.trackerType);
    return tracker ? trackerOwnershipOf(tracker) : null;
  };

  // Solo users have no second section, and a tracker left over from a former
  // team must not become undraggable.
  const acceptsDrop = (target: TrackerOwnership) =>
    ownershipSections === null || ownershipOfDragged() === target;

  const canDropTypeInFolder = (folderId: string | null) => {
    if (draggedEntry?.kind !== 'type-placement') return false;
    if (folderId === null) return true;
    const folder = navigationTree.folders.find((node) => node.folder.folderId === folderId)?.folder;
    return folder ? acceptsDrop(folderOwnershipOf(folder)) : false;
  };

  const renderTypeRow = (
    tracker: TrackerDataModel,
    placement: TrackerTypePlacement,
    nested = false,
  ) => (
    <TrackerNavTypeRow
      key={tracker.type}
      draggable
      data-testid="tracker-type-button"
      tracker={tracker}
      nested={nested}
      selected={selectedType === tracker.type}
      count={
        <SidebarTypeCount
          type={tracker.type as TrackerItemType}
          activeFilters={activeFilters}
          tagFilter={tagFilter}
          sourceFilter={sourceFilter}
          currentIdentity={currentIdentity}
          favoriteItemIds={favoriteItemIds}
          viewedAtByItemId={viewedAtByItemId}
          readinessByItemId={readinessByItemId}
          personalStateHydrated={personalStateHydrated}
          recentlyViewedDays={recentlyViewedDays}
          columnFilters={columnFilters}
          statusScope={statusScope}
          nowMs={filterClockMs}
        />
      }
      onClick={() => onSelectType(tracker.type)}
      onDragStart={(event) => {
        setDraggedEntryId(placement.entryId);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', placement.entryId);
      }}
      onDragEnd={() => setDraggedEntryId(null)}
      onDragOver={(event) => {
        if (canDropTypeInFolder(placement.folderId)) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (draggedEntry?.kind === 'type-placement'
          && draggedEntry.entryId !== placement.entryId
          && canDropTypeInFolder(placement.folderId)) {
          insertTypeBefore(draggedEntry, placement);
        }
        setDraggedEntryId(null);
      }}
    />
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
        <TrackerSavedViewsSection
          savedViews={savedViews}
          activeSavedViewId={activeSavedViewId}
          isSharedLayout={isSharedLayout}
          onApplyView={onApplyView}
          onDeleteView={onDeleteView}
          onToggleShareView={onToggleShareView}
        />

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
              {/* With sections, the button lives in each section header -- a
                  folder is born owned, so there is nothing to ask afterwards. */}
              {ownershipSections === null && renderCreateFolderButton('personal')}
            </span>
          </div>

          {ownershipSections === null && renderCreateFolderRow('personal')}

          {/* All */}
          <TrackerNavTypeRow
            tracker={ALL_TRACKERS_NAV_MODEL}
            selected={selectedType === 'all'}
            onClick={() => onSelectType('all')}
            onDragOver={(event) => {
              if (draggedEntry?.kind === 'type-placement') event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (draggedEntry?.kind === 'type-placement') appendTypeToFolder(draggedEntry, null);
              setDraggedEntryId(null);
            }}
          />

          {ownershipSections === null
            ? renderNavigationTree(navigationTree)
            : ownershipSections.map((section) => (
              <TrackerOwnershipSection
                key={section.ownership}
                ownership={section.ownership}
                teamName={team?.name}
                members={teamMembers}
                collapsed={collapsedSections.includes(section.ownership)}
                onToggleCollapsed={() => toggleSectionCollapsed(section.ownership)}
                actions={renderCreateFolderButton(section.ownership)}
              >
                {renderCreateFolderRow(section.ownership)}
                {renderNavigationTree(section.tree)}
              </TrackerOwnershipSection>
            ))}
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
                setFolderExpanded(contextFolder.folderId, true);
                setContextFolder(null);
              }}
            >
              <MaterialSymbol icon="edit" size={14} /> Rename folder
            </button>
            <button
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-nim-error hover:bg-nim-tertiary"
              onClick={async () => {
                const folder = contextFolder;
                setContextFolder(null);
                const approved = await requestConfirmation({
                  title: 'Delete folder?',
                  message: `Delete folder “${folder.name}”? Its tracker types will move to the root.`,
                  confirmLabel: 'Delete',
                  destructive: true,
                });
                if (approved) {
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

  function renderCreateFolderButton(ownership: TrackerOwnership) {
    return (
      <button
        className="flex items-center justify-center px-1 text-nim-faint hover:text-nim transition-colors"
        title="New tracker folder"
        data-testid="tracker-folder-add"
        data-ownership={ownership}
        onClick={() => {
          if (collapsedSections.includes(ownership)) {
            setModeLayout({
              collapsedOwnershipSections: toggleListEntry(collapsedSections, ownership, false),
            });
          }
          setNewFolderName('');
          setCreatingFolderIn((value) => (value === ownership ? null : ownership));
        }}
      >
        <MaterialSymbol icon="create_new_folder" size={14} />
      </button>
    );
  }

  function renderCreateFolderRow(ownership: TrackerOwnership) {
    if (creatingFolderIn !== ownership) return null;
    return (
      <div className="flex items-center gap-1 px-1 mb-1" data-testid="tracker-folder-create-row">
        <MaterialSymbol icon="folder" size={15} className="text-nim-muted" />
        <input
          autoFocus
          value={newFolderName}
          onChange={(event) => setNewFolderName(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') commitCreateFolder(ownership);
            if (event.key === 'Escape') {
              setCreatingFolderIn(null);
              setNewFolderName('');
            }
          }}
          onBlur={() => {
            setCreatingFolderIn(null);
            setNewFolderName('');
          }}
          placeholder="Folder name"
          className="min-w-0 flex-1 px-2 py-1 text-xs bg-nim border border-nim rounded text-nim placeholder:text-nim-faint focus:outline-none focus:border-nim-focus"
        />
      </div>
    );
  }

  /** Folders and their trackers, rendered the same way inside or outside a section. */
  function renderNavigationTree(tree: TrackerNavigationTree) {
    return (
      <>
        {tree.folders.map(({ folder, trackerTypes: folderTypes }) => {
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
                onDragOver={(event) => {
                  if (acceptsDrop(folderOwnershipOf(folder))) event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (!acceptsDrop(folderOwnershipOf(folder))) {
                    setDraggedEntryId(null);
                    return;
                  }
                  if (draggedEntry?.kind === 'type-placement') {
                    appendTypeToFolder(draggedEntry, folder.folderId);
                    setFolderExpanded(folder.folderId, true);
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
                  onClick={() => setFolderExpanded(folder.folderId, !expanded)}
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
                    onClick={() => setFolderExpanded(folder.folderId, !expanded)}
                  >
                    {folder.name}
                  </button>
                )}
                <span className="text-[10px] font-semibold text-nim-muted min-w-[20px] text-right tabular-nums">
                  <SidebarFolderCount
                    types={folderTypes.map((row) => row.tracker.type)}
                    activeFilters={activeFilters}
                    tagFilter={tagFilter}
                    sourceFilter={sourceFilter}
                    currentIdentity={currentIdentity}
                    favoriteItemIds={favoriteItemIds}
                    viewedAtByItemId={viewedAtByItemId}
                    readinessByItemId={readinessByItemId}
                    personalStateHydrated={personalStateHydrated}
                    recentlyViewedDays={recentlyViewedDays}
                    columnFilters={columnFilters}
                    statusScope={statusScope}
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

        {tree.rootTypes.map(({ tracker, placement }) => renderTypeRow(tracker, placement))}
      </>
    );
  }
};
