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
  trackerSavedViewsAtom,
  saveTrackerViewAtom,
  deleteTrackerViewAtom,
  type TrackerFilterChip,
} from '../../store/atoms/trackers';
import type { SavedView } from './trackerSavedViews';
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
  const savedViews = useAtomValue(trackerSavedViewsAtom);
  const saveView = useSetAtom(saveTrackerViewAtom);
  const deleteView = useSetAtom(deleteTrackerViewAtom);

  const handleSaveView = useCallback((name: string) => {
    const view: SavedView = {
      id: crypto.randomUUID(),
      name,
      definition: {
        selectedType: modeLayout.selectedType,
        activeFilters: modeLayout.activeFilters,
        viewMode: modeLayout.viewMode,
        tagFilter: [],
        groupBy: modeLayout.groupBy,
        sortBy: modeLayout.sortBy,
        sortDirection: modeLayout.sortDirection,
        recentlyViewedDays: modeLayout.recentlyViewedDays,
      },
    };
    saveView(view);
  }, [modeLayout, saveView]);

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
      selectedItemId: null,
    });
  }, [setModeLayout]);

  const handleDeleteView = useCallback((viewId: string) => {
    deleteView(viewId);
  }, [deleteView]);

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
      onApplyView={handleApplyView}
      onSaveView={handleSaveView}
      onDeleteView={handleDeleteView}
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
