import React, { useEffect, useMemo, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { globalRegistry, loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { TrackerSidebar } from './TrackerSidebar';
import { TrackerMainView, type ViewMode } from './TrackerMainView';
import { ResizablePanel } from '../AgenticCoding/ResizablePanel';
import type { TrackerIdentity, TrackerItemType } from '@nimbalyst/runtime';
import {
  trackerModeLayoutAtom,
  setTrackerModeLayoutAtom,
  allTrackerSavedViewsAtom,
  saveTrackerViewAtom,
  removeTrackerViewAtom,
  shareTrackerViewAtom,
  unshareTrackerViewAtom,
  type TrackerFilterChip,
} from '../../store/atoms/trackers';
import type { SavedView, SavedViewDefinition } from './trackerSavedViews';
import type { TrackerNavigationEntry } from '@nimbalyst/runtime/sync';
import {
  deleteTrackerFolderAtom,
  ensureTrackerTypePlacementsAtom,
  saveTrackerNavigationEntryAtom,
  trackerNavigationEntriesAtom,
} from '../../store/atoms/trackerNavigation';
import {
  favoriteTrackerItemIdsAtom,
  hydrateTrackerPersonalStateAtom,
  trackerPersonalStateHydratedAtom,
  trackerViewedAtByItemIdAtom,
} from '../../store/atoms/trackerPersonalState';

// Ensure built-in trackers are loaded
loadBuiltinTrackers();

interface TrackerModeProps {
  workspacePath: string | null;
  workspaceName?: string;
  isActive: boolean;
  onSwitchToFilesMode?: () => void;
}

function savedViewMatchesCurrent(
  saved: SavedViewDefinition,
  current: SavedViewDefinition,
): boolean {
  const scalarKeys = [
    'selectedType',
    'viewMode',
    'groupBy',
    'sortBy',
    'sortDirection',
    'recentlyViewedDays',
  ] as const;
  if (scalarKeys.some(key => saved[key] !== current[key])) return false;
  if (JSON.stringify(saved.activeFilters) !== JSON.stringify(current.activeFilters)) return false;
  if (JSON.stringify(saved.tagFilter) !== JSON.stringify(current.tagFilter)) return false;
  // Null marks a legacy view that did not capture the field, so applying it
  // intentionally leaves the current value alone and must not look dirty.
  if (saved.columnConfig !== null
    && JSON.stringify(saved.columnConfig) !== JSON.stringify(current.columnConfig)) return false;
  if (saved.columnFilters !== null
    && JSON.stringify(saved.columnFilters) !== JSON.stringify(current.columnFilters)) return false;
  if (saved.inboxScope !== null && saved.inboxScope !== current.inboxScope) return false;
  return true;
}

export const TrackerMode: React.FC<TrackerModeProps> = ({
  workspacePath,
  workspaceName,
  isActive,
  onSwitchToFilesMode,
}) => {
  // Track registry changes
  const [registryVersion, setRegistryVersion] = React.useState(0);
  useEffect(() => {
    return globalRegistry.onChange(() => setRegistryVersion(v => v + 1));
  }, []);

  const trackerTypes = useMemo(() => {
    return globalRegistry.getAll();
  }, [registryVersion]);

  const navigationEntries = useAtomValue(trackerNavigationEntriesAtom);
  const ensureTypePlacements = useSetAtom(ensureTrackerTypePlacementsAtom);
  const saveNavigationEntry = useSetAtom(saveTrackerNavigationEntryAtom);
  const deleteFolder = useSetAtom(deleteTrackerFolderAtom);

  useEffect(() => {
    if (!workspacePath || trackerTypes.length === 0) return;
    void ensureTypePlacements({
      workspacePath,
      trackerTypes: trackerTypes.map((tracker) => tracker.type),
    });
  }, [workspacePath, trackerTypes, ensureTypePlacements]);

  const handleSaveNavigationEntry = useCallback((entry: TrackerNavigationEntry) => {
    if (!workspacePath) return Promise.resolve();
    return saveNavigationEntry({ workspacePath, entry });
  }, [workspacePath, saveNavigationEntry]);

  const handleDeleteFolder = useCallback((folderId: string) => {
    if (!workspacePath) return Promise.resolve();
    return deleteFolder({ workspacePath, folderId });
  }, [workspacePath, deleteFolder]);

  // Persisted layout state from atoms
  const modeLayout = useAtomValue(trackerModeLayoutAtom);
  const setModeLayout = useSetAtom(setTrackerModeLayoutAtom);

  const selectedType = modeLayout.selectedType;
  const activeFilters = modeLayout.activeFilters;
  const viewMode = modeLayout.viewMode;
  const sidebarWidth = modeLayout.sidebarWidth;
  const [tagFilter, setTagFilter] = React.useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = React.useState<string[]>([]);
  const [currentIdentity, setCurrentIdentity] = React.useState<TrackerIdentity | null>(null);
  const favoriteItemIds = useAtomValue(favoriteTrackerItemIdsAtom);
  const viewedAtByItemId = useAtomValue(trackerViewedAtByItemIdAtom);
  const personalStateHydrated = useAtomValue(trackerPersonalStateHydratedAtom);
  const hydratePersonalState = useSetAtom(hydrateTrackerPersonalStateAtom);

  useEffect(() => {
    setCurrentIdentity(null);
    let cancelled = false;
    window.electronAPI.invoke('document-service:get-current-identity').then((result: any) => {
      if (!cancelled && result?.success) setCurrentIdentity(result.identity);
    });
    return () => { cancelled = true; };
  }, [workspacePath]);

  useEffect(() => {
    void hydratePersonalState({
      workspacePath: workspacePath ?? undefined,
      identityEmail: currentIdentity?.email ?? null,
    });
  }, [workspacePath, currentIdentity?.email, hydratePersonalState]);

  const handleSelectType = useCallback((type: string | 'all') => {
    setModeLayout({ selectedType: type, selectedItemId: null });
  }, [setModeLayout]);

  const handleToggleFilter = useCallback((filter: TrackerFilterChip) => {
    let current = modeLayout.activeFilters;
    const wasActive = current.includes(filter);

    // "Mine" and "Unassigned" are mutually exclusive
    if (filter === 'mine') current = current.filter(f => f !== 'unassigned');
    if (filter === 'unassigned') current = current.filter(f => f !== 'mine');
    if (filter === 'recently-updated' || filter === 'recently-viewed' || filter === 'recently-edited-by-others') {
      current = current.filter((candidate) => ![
        'recently-updated', 'recently-viewed', 'recently-edited-by-others',
      ].includes(candidate));
    }

    const next = wasActive
      ? current.filter(f => f !== filter)
      : [...current, filter];
    setModeLayout({ activeFilters: next });
  }, [modeLayout.activeFilters, setModeLayout]);

  const handleClearFilters = useCallback(() => {
    setModeLayout({ activeFilters: [] });
  }, [setModeLayout]);

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    setModeLayout({ viewMode: mode });
  }, [setModeLayout]);

  // Saved views (NIM-788)
  const savedViews = useAtomValue(allTrackerSavedViewsAtom);
  const saveView = useSetAtom(saveTrackerViewAtom);
  const removeView = useSetAtom(removeTrackerViewAtom);
  const shareView = useSetAtom(shareTrackerViewAtom);
  const unshareView = useSetAtom(unshareTrackerViewAtom);
  const [activeSavedViewId, setActiveSavedViewId] = React.useState<string | null>(null);

  React.useEffect(() => {
    setActiveSavedViewId(null);
  }, [workspacePath]);

  const currentViewDefinition = useMemo<SavedViewDefinition>(() => ({
    selectedType: modeLayout.selectedType,
    activeFilters: modeLayout.activeFilters,
    viewMode: modeLayout.viewMode,
    tagFilter,
    groupBy: modeLayout.groupBy,
    sortBy: modeLayout.sortBy,
    sortDirection: modeLayout.sortDirection,
    recentlyViewedDays: modeLayout.recentlyViewedDays,
    columnConfig: modeLayout.typeColumnConfigs[modeLayout.selectedType] ?? null,
    columnFilters: modeLayout.typeColumnFilters[modeLayout.selectedType]
      ?? { combinator: 'and', clauses: [] },
    inboxScope: modeLayout.inboxScope,
  }), [modeLayout, tagFilter]);

  const activeSavedView = useMemo(
    () => savedViews.find(view => view.id === activeSavedViewId) ?? null,
    [activeSavedViewId, savedViews],
  );
  const savedViewDirty = Boolean(
    activeSavedView
    && !savedViewMatchesCurrent(activeSavedView.definition, currentViewDefinition),
  );
  const hasUnsavedFilterChanges = modeLayout.activeFilters.length > 0
    || tagFilter.length > 0
    || (modeLayout.typeColumnFilters[modeLayout.selectedType]?.clauses.length ?? 0) > 0;

  const handleSaveView = useCallback((name: string) => {
    const view: SavedView = {
      id: crypto.randomUUID(),
      name,
      definition: currentViewDefinition,
    };
    saveView(view);
    setActiveSavedViewId(view.id);
  }, [currentViewDefinition, saveView]);

  const handleUpdateView = useCallback(() => {
    if (!activeSavedView) return;
    const updatedView = { ...activeSavedView, definition: currentViewDefinition };
    if (activeSavedView.shared) {
      void shareView(updatedView);
    } else {
      saveView(updatedView);
    }
  }, [activeSavedView, currentViewDefinition, saveView, shareView]);

  const handleRenameView = useCallback((name: string) => {
    if (!activeSavedView) return;
    const renamedView = { ...activeSavedView, name };
    if (activeSavedView.shared) {
      void shareView(renamedView);
    } else {
      saveView(renamedView);
    }
  }, [activeSavedView, saveView, shareView]);

  const handleApplyView = useCallback((view: SavedView) => {
    const def = view.definition;
    setModeLayout({
      selectedType: def.selectedType,
      activeFilters: def.activeFilters,
      viewMode: def.viewMode,
      groupBy: def.groupBy,
      sortBy: def.sortBy,
      sortDirection: def.sortDirection,
      recentlyViewedDays: def.recentlyViewedDays,
      ...(def.inboxScope ? { inboxScope: def.inboxScope } : {}),
      selectedItemId: null,
      // Only overwrite the column layout/filters when the view actually
      // captured them; older views leave the current table state alone.
      ...(def.columnConfig
        ? { typeColumnConfigs: { ...modeLayout.typeColumnConfigs, [def.selectedType]: def.columnConfig } }
        : {}),
      ...(def.columnFilters
        ? { typeColumnFilters: { ...modeLayout.typeColumnFilters, [def.selectedType]: def.columnFilters } }
        : {}),
    });
    setTagFilter(def.tagFilter);
    setActiveSavedViewId(view.id);
  }, [setModeLayout, modeLayout.typeColumnConfigs, modeLayout.typeColumnFilters]);

  const handleDeleteView = useCallback((view: SavedView) => {
    // Deleting a shared view removes it for the whole team and can't be undone,
    // so make the team-wide consequence explicit before acting.
    if (view.shared && !window.confirm(
      `Delete “${view.name}” for the whole team? This can't be undone.`,
    )) {
      return;
    }
    if (activeSavedViewId === view.id) setActiveSavedViewId(null);
    void removeView(view);
  }, [activeSavedViewId, removeView]);

  const handleToggleShareView = useCallback((view: SavedView) => {
    void (view.shared ? unshareView(view) : shareView(view));
  }, [shareView, unshareView]);

  const handleSidebarWidthChange = useCallback((width: number) => {
    setModeLayout({ sidebarWidth: width });
  }, [setModeLayout]);

  const filterType = selectedType as TrackerItemType | 'all';

  const sidebarContent = (
    <TrackerSidebar
      workspacePath={workspacePath || undefined}
      workspaceName={workspaceName}
      trackerTypes={trackerTypes}
      navigationEntries={navigationEntries}
      selectedType={selectedType}
      activeFilters={activeFilters}
      tagFilter={tagFilter}
      sourceFilter={sourceFilter}
      currentIdentity={currentIdentity}
      favoriteItemIds={favoriteItemIds}
      viewedAtByItemId={viewedAtByItemId}
      personalStateHydrated={personalStateHydrated}
      recentlyViewedDays={modeLayout.recentlyViewedDays}
      onRecentlyViewedDaysChange={(days) => setModeLayout({ recentlyViewedDays: days })}
      viewMode={viewMode}
      onSelectType={handleSelectType}
      onToggleFilter={handleToggleFilter}
      onViewModeChange={handleViewModeChange}
      savedViews={savedViews}
      activeSavedViewId={activeSavedViewId}
      onApplyView={handleApplyView}
      onDeleteView={handleDeleteView}
      onToggleShareView={handleToggleShareView}
      onSaveNavigationEntry={handleSaveNavigationEntry}
      onDeleteFolder={handleDeleteFolder}
    />
  );

  const mainContent = (
    <TrackerMainView
      filterType={filterType}
      activeFilters={activeFilters}
      viewMode={viewMode}
      onViewModeChange={handleViewModeChange}
      onSwitchToFilesMode={onSwitchToFilesMode}
      workspacePath={workspacePath || undefined}
      trackerTypes={trackerTypes}
      onClearSidebarFilters={handleClearFilters}
      tagFilter={tagFilter}
      setTagFilter={setTagFilter}
      sourceFilter={sourceFilter}
      setSourceFilter={setSourceFilter}
      currentIdentity={currentIdentity}
      favoriteItemIds={favoriteItemIds}
      viewedAtByItemId={viewedAtByItemId}
      personalStateHydrated={personalStateHydrated}
      activeSavedView={activeSavedView}
      savedViewDirty={savedViewDirty}
      showSaveViewAction={!activeSavedView && hasUnsavedFilterChanges}
      onSaveView={handleSaveView}
      onRenameSavedView={handleRenameView}
      onUpdateSavedView={handleUpdateView}
    />
  );

  return (
    <div className="tracker-mode flex-1 flex flex-row overflow-hidden min-h-0">
      <ResizablePanel
        leftPanel={sidebarContent}
        rightPanel={mainContent}
        leftWidth={sidebarWidth}
        minWidth={160}
        maxWidth={350}
        onWidthChange={handleSidebarWidthChange}
      />
    </div>
  );
};
