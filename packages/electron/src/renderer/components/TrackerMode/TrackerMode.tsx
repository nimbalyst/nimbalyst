import React, { useEffect, useMemo, useCallback } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { globalRegistry, loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { trackerItemsArrayAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin';
import { computeReadiness } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerReadiness';
import { getRecordStatus } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { TrackerSidebar } from './TrackerSidebar';
import { TrackerMainView } from './TrackerMainView';
import { type TrackerViewMode } from './trackerViewModes';
import { useTrackerTeamOwnership } from './useTrackerTeamMembers';
import { ResizablePanel } from '../AgenticCoding/ResizablePanel';
import type { TrackerIdentity, TrackerItemType } from '@nimbalyst/runtime';
import {
  trackerModeLayoutAtom,
  setTrackerModeLayoutAtom,
  trackerActiveViewSettingsAtom,
  setTrackerTypeViewSettingsAtom,
  trackerModeDocumentItemIdAtom,
  allTrackerSavedViewsAtom,
  saveTrackerViewAtom,
  removeTrackerViewAtom,
  shareTrackerViewAtom,
  unshareTrackerViewAtom,
} from '../../store/atoms/trackers';
import {
  legacyFilterChipsToClauses,
  hasSavableViewState,
  type SavedView,
  type SavedViewDefinition,
} from './trackerSavedViews';
import {
  applySavedViewToLayout,
  buildCurrentViewDefinition,
  savedViewMatchesCurrent,
} from './trackerViewDefinition';
import { withBuiltInSavedViews } from './trackerReadyQueue';
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
  // Display Settings for the selected type, with the workspace-wide values as
  // the fallback -- never read `modeLayout.viewMode` and friends directly.
  const viewSettings = useAtomValue(trackerActiveViewSettingsAtom);
  const setTypeViewSettings = useSetAtom(setTrackerTypeViewSettingsAtom);
  const documentItemId = useAtomValue(trackerModeDocumentItemIdAtom);
  const [activeSavedViewId, setActiveSavedViewId] = React.useState<string | null>(null);

  const selectedType = modeLayout.selectedType;
  const activeFilters = modeLayout.activeFilters;
  const viewMode = viewSettings.viewMode;
  const sidebarWidth = modeLayout.sidebarWidth;
  const [tagFilter, setTagFilter] = React.useState<string[]>([]);
  const [sourceFilter, setSourceFilter] = React.useState<string[]>([]);
  const [currentIdentity, setCurrentIdentity] = React.useState<TrackerIdentity | null>(null);
  const favoriteItemIds = useAtomValue(favoriteTrackerItemIdsAtom);
  const viewedAtByItemId = useAtomValue(trackerViewedAtByItemIdAtom);
  const trackerItems = useAtomValue(trackerItemsArrayAtom);
  const readinessByItemId = useMemo(
    () => computeReadiness(trackerItems, getRecordStatus),
    [trackerItems],
  );
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

  // NIM-2094: the left-side preset chips were removed. Translate persisted
  // layout state and older saved views into ordinary right-side clauses so no
  // active filter becomes invisible during the transition.
  useEffect(() => {
    if (modeLayout.activeFilters.length === 0) return;
    const key = modeLayout.selectedType;
    const current = modeLayout.typeColumnFilters[key] ?? { combinator: 'and' as const, clauses: [] };
    const converted = legacyFilterChipsToClauses(
      modeLayout.activeFilters,
      modeLayout.recentlyViewedDays,
    );
    const clauseKeys = new Set(current.clauses.map(clause => JSON.stringify(clause)));
    const clauses = [
      ...current.clauses,
      ...converted.filter(clause => !clauseKeys.has(JSON.stringify(clause))),
    ];
    setModeLayout({
      activeFilters: [],
      typeColumnFilters: {
        ...modeLayout.typeColumnFilters,
        [key]: { combinator: 'and', clauses },
      },
    });
  }, [
    modeLayout.activeFilters,
    modeLayout.recentlyViewedDays,
    modeLayout.selectedType,
    modeLayout.typeColumnFilters,
    setModeLayout,
  ]);

  const handleSelectType = useCallback((type: string | 'all') => {
    setActiveSavedViewId(null);
    setModeLayout({
      selectedType: type,
      selectedItemId: null,
    });
  }, [setModeLayout]);

  const handleClearFilters = useCallback(() => {
    setModeLayout({ activeFilters: [] });
  }, [setModeLayout]);

  const handleViewModeChange = useCallback((mode: TrackerViewMode) => {
    setTypeViewSettings({ typeKey: selectedType, viewMode: mode });
  }, [setTypeViewSettings, selectedType]);

  // Saved views (NIM-788)
  const persistedSavedViews = useAtomValue(allTrackerSavedViewsAtom);
  const savedViews = useMemo(
    () => withBuiltInSavedViews(persistedSavedViews),
    [persistedSavedViews],
  );
  const saveView = useSetAtom(saveTrackerViewAtom);
  const removeView = useSetAtom(removeTrackerViewAtom);
  const shareView = useSetAtom(shareTrackerViewAtom);
  const unshareView = useSetAtom(unshareTrackerViewAtom);
  React.useEffect(() => {
    setActiveSavedViewId(null);
  }, [workspacePath]);

  const currentViewDefinition = useMemo<SavedViewDefinition>(
    () => buildCurrentViewDefinition(modeLayout, viewSettings, tagFilter),
    [modeLayout, viewSettings, tagFilter],
  );

  const activeSavedView = useMemo(
    () => savedViews.find(view => view.id === activeSavedViewId) ?? null,
    [activeSavedViewId, savedViews],
  );
  // A built-in view is rebuilt from code on every load, so "Save changes" would
  // have nowhere to write; narrowing the filters simply leaves the view.
  const savedViewEditable = !activeSavedView?.builtIn;
  const savedViewDirty = Boolean(
    activeSavedView
    && savedViewEditable
    && !savedViewMatchesCurrent(activeSavedView.definition, currentViewDefinition),
  );
  const hasSavableCurrentView = hasSavableViewState(currentViewDefinition);

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
    if (!activeSavedView || activeSavedView.builtIn) return;
    const updatedView = { ...activeSavedView, definition: currentViewDefinition };
    if (activeSavedView.shared) {
      void shareView(updatedView);
    } else {
      saveView(updatedView);
    }
  }, [activeSavedView, currentViewDefinition, saveView, shareView]);

  const handleExitSavedView = useCallback(() => {
    setActiveSavedViewId(null);
  }, []);

  const handleRenameView = useCallback((name: string) => {
    if (!activeSavedView || activeSavedView.builtIn) return;
    const renamedView = { ...activeSavedView, name };
    if (activeSavedView.shared) {
      void shareView(renamedView);
    } else {
      saveView(renamedView);
    }
  }, [activeSavedView, saveView, shareView]);

  const handleApplyView = useCallback((view: SavedView) => {
    setModeLayout(applySavedViewToLayout(modeLayout, view.definition));
    setTagFilter(view.definition.tagFilter);
    setActiveSavedViewId(view.id);
  }, [setModeLayout, modeLayout]);

  const handleDeleteView = useCallback((view: SavedView) => {
    if (view.builtIn) return;
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
    if (view.builtIn) return;
    void (view.shared ? unshareView(view) : shareView(view));
  }, [shareView, unshareView]);

  const handleSidebarWidthChange = useCallback((width: number) => {
    setModeLayout({ sidebarWidth: width });
  }, [setModeLayout]);

  const filterType = selectedType as TrackerItemType | 'all';

  // One team lookup for the whole mode: the sidebar's ownership sections and the
  // migration summary both name the same team, without each fetching it.
  const { team, members: teamMembers } = useTrackerTeamOwnership(workspacePath || undefined);

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
      readinessByItemId={readinessByItemId}
      personalStateHydrated={personalStateHydrated}
      recentlyViewedDays={modeLayout.recentlyViewedDays}
      columnFilters={modeLayout.typeColumnFilters[modeLayout.selectedType] ?? null}
      statusScope={modeLayout.statusScope}
      viewMode={viewMode}
      onSelectType={handleSelectType}
      onViewModeChange={handleViewModeChange}
      savedViews={savedViews}
      activeSavedViewId={activeSavedViewId}
      onApplyView={handleApplyView}
      onDeleteView={handleDeleteView}
      onToggleShareView={handleToggleShareView}
      onSaveNavigationEntry={handleSaveNavigationEntry}
      onDeleteFolder={handleDeleteFolder}
      team={team}
      teamMembers={teamMembers}
    />
  );

  const mainContent = (
    <TrackerMainView
      filterType={filterType}
      activeFilters={activeFilters}
      // Display Settings can select `timeline` before a timeline view exists;
      // the chosen mode is what persists, the board is what renders meanwhile.
      viewMode={viewMode}
      onViewModeChange={handleViewModeChange}
      onSwitchToFilesMode={onSwitchToFilesMode}
      workspacePath={workspacePath || undefined}
      teamPresenceOrgId={team?.orgId}
      teamName={team?.name}
      teamMembers={teamMembers}
      trackerTypes={trackerTypes}
      onClearSidebarFilters={handleClearFilters}
      tagFilter={tagFilter}
      setTagFilter={setTagFilter}
      sourceFilter={sourceFilter}
      setSourceFilter={setSourceFilter}
      currentIdentity={currentIdentity}
      favoriteItemIds={favoriteItemIds}
      viewedAtByItemId={viewedAtByItemId}
      readinessByItemId={readinessByItemId}
      personalStateHydrated={personalStateHydrated}
      activeSavedView={activeSavedView}
      savedViewDirty={savedViewDirty}
      savedViewEditable={savedViewEditable}
      showSaveViewAction={!activeSavedView && hasSavableCurrentView}
      onSaveView={handleSaveView}
      onRenameSavedView={handleRenameView}
      onUpdateSavedView={handleUpdateView}
      onExitSavedView={handleExitSavedView}
    />
  );

  // Document view brings its own slim list pane, so the type/saved-view sidebar
  // stands down for it -- otherwise the focused document competes with two
  // navigation columns. Collapsing it (rather than returning a different tree)
  // keeps the main view -- and the body editor inside it -- mounted across the
  // presentation switch (plan: tracker-document-mode, checkbox 24). The user's
  // own collapse preference applies everywhere else.
  return (
    <div
      className={`tracker-mode flex-1 flex flex-row overflow-hidden min-h-0${documentItemId ? ' tracker-mode-document' : ''}`}
    >
      <ResizablePanel
        leftPanel={sidebarContent}
        rightPanel={mainContent}
        leftWidth={sidebarWidth}
        minWidth={160}
        maxWidth={350}
        onWidthChange={handleSidebarWidthChange}
        collapsed={Boolean(documentItemId) || modeLayout.sidebarCollapsed}
      />
    </div>
  );
};
