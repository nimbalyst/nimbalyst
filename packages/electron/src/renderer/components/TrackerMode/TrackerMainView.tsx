import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { activeFileRepoPathAtom } from '../../store/atoms/workspaceRepos';
import { copyToClipboard, MaterialSymbol } from '@nimbalyst/runtime';
import { TrackerUnreadDot } from '@nimbalyst/runtime/readReceipts/TrackerUnreadDot';
import type { TrackerIdentity } from '@nimbalyst/runtime';
import { trackerRadarActorKey, type RadarLaneEnrichment, type RadarPresence } from '@nimbalyst/tracker-core';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { Readiness } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerReadiness';
import type { BlockerVisibilityScope } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerBlockerVisibility';
import {
  getDefaultColumnConfig,
  resolveColumnsForType,
  TrackerTable,
  TrackerFavoriteStar,
  SortColumn as TrackerSortColumn,
  SortDirection as TrackerSortDirection,
  type TrackerItemType,
} from '@nimbalyst/runtime/plugins/TrackerPlugin';
import {
  trackerItemsByTypeAtom,
  archivedTrackerItemsAtom,
} from '@nimbalyst/runtime/plugins/TrackerPlugin';
import {
  hasActiveFilters,
  type TrackerDataModel,
  type TrackerFilterEvaluationContext,
  type TrackerFilterSet,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { KanbanBoard } from './KanbanBoard';
import { TrackerGridView } from './TrackerGridView';
import { TrackerInboxView } from './TrackerInboxView';
import {
  TrackerItemDetail,
  type TrackerContentMode,
} from './TrackerItemDetail';
import { TrackerSyncRejectionBanner } from './TrackerSyncRejectionBanner';
import { TrackerSharingMigrationBanner } from './TrackerSharingMigrationBanner';
import {
  DESKTOP_TRACKER_UI_CAPABILITIES,
  buildHeaderFilterFields,
  createTrackerFilterFields,
  getTrackerHeaderFilterValue,
  TagBoard,
  TrackerDependencyCycleBanner,
  TrackerFilterOmnibox,
  TrackerViewHeaderControls,
  TrackerRadarView,
  TrackerTimelineView,
  TrackerViewTitle,
  useTrackerViewRows,
  type TrackerFilterField,
  type TrackerViewLayoutUpdate,
} from '@nimbalyst/collab-client/trackers-ui';
import type { TrackerViewMode } from './trackerViewModes';
import { TrackerDocumentView } from './TrackerDocumentView';
import {
  trackerModeLayoutAtom,
  setTrackerModeLayoutAtom,
  trackerActiveViewSettingsAtom,
  setTrackerTypeViewSettingsAtom,
  setTrackerDocumentChatSessionAtom,
  setTrackerItemViewAtom,
  trackerModeDocumentItemIdAtom,
  openTrackerItemAsDocumentAtom,
  type TrackerFilterChip,
  type TypeColumnConfig,
} from '../../store/atoms/trackers';
import { activeTeamOrgIdAtom, buildTrackerDeepLink, buildTrackerDocumentDeepLink } from '../../store/atoms/collabDocuments';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import {
  buildTrackerCreatePayload,
  formatTrackerValidationErrors,
  globalRegistry,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { resolveTrackerWriteAccess } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerLifecycle';
import { useTrackerBodyPrewarm } from '../../hooks/useTrackerBodyPrewarm';
import { agentSessionAttentionAtom, setSelectedWorkstreamAtom, sessionRegistryAtom, refreshSessionListAtom, initSessionList } from '../../store/atoms/sessions';
import {
  trackerItemsMapAtom,
  trackerRelationshipLabelAtom,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { resolveLinkedSessions } from '../../utils/resolveLinkedSessions';
import { getRelativeTimeString } from '../../utils/dateFormatting';
import type { TrackerLinkedSessionOption } from '@nimbalyst/runtime/plugins/TrackerPlugin';
import { workstreamStateAtom } from '../../store/atoms/workstreamState';
import { setWindowModeAtom } from '../../store/atoms/windowMode';
import { defaultAgentModelAtom, worktreesFeatureAvailableAtom } from '../../store/atoms/appSettings';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import { store } from '../../store';
import { createTrackerItem, isLocalWikiRecord } from '../../services/localWikiTrackerRecords';
import { deleteLocalWikiItem, refuseLocalWikiArchive } from '../../services/localWikiTrackerWrites';
import { buildTrackerTagOptions } from './trackerTagFilterUtils';
import {
  filterTrackerItems,
  recordSourceKey,
  type SavedView,
  type SavedViewDefinition,
} from './trackerSavedViews';
import { orderTrackerItemsByLeverage, READINESS_LEVERAGE_SORT } from './trackerReadyQueue';
import { useTrackerUnread } from '../../hooks/useTrackerUnread';
import { SOURCE_FILTER_FIELD, sourceFilterField, splitSourceClause, withSourceClause } from './trackerSourceFilterClause';
import { TrackerNewMenu } from './TrackerNewMenu';
import { useGitRepoProbe } from '../../hooks/useGitRepoProbe';
import {
  createNewWorktreeSessionActionAtom,
} from '../../store/actions/sessionHistoryActions';
import { setTrackerFavoriteAtom } from '../../store/atoms/trackerPersonalState';
import { WorktreeBaseBranchPicker, type WorktreePickerCreateOptions } from '../AgenticCoding/WorktreeBaseBranchPicker';
import {
  buildTrackerLaunchContext,
  type TrackerLaunchContext,
} from './trackerSessionLaunch';
import { trackTeamAnalyticsEvent } from '../../utils/teamAnalytics';
import { TrackerQuickAddOverlay } from './TrackerQuickAddOverlay';
import { confirmTrackerItemDelete } from './confirmTrackerItemDelete';
import { orgPresenceAtomFamily } from '../../store/atoms/teamInbox';
import { gitStatusAtom } from '../../store/atoms/gitOperations';
import type { TeamMemberOption } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/TrackerFieldEditor';

export type ViewMode = TrackerViewMode;

interface TrackerMainViewProps {
  filterType: TrackerItemType | 'all';
  activeFilters: TrackerFilterChip[];
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onSwitchToFilesMode?: () => void;
  workspacePath?: string;
  /** Organization backing team presence for this workspace. */
  teamPresenceOrgId?: string;
  /** Team that owns this workspace's shared trackers, when there is one. */
  teamName?: string | null;
  teamMembers?: TeamMemberOption[];
  trackerTypes: TrackerDataModel[];
  onClearSidebarFilters: () => void;
  tagFilter: string[];
  setTagFilter: React.Dispatch<React.SetStateAction<string[]>>;
  sourceFilter: string[];
  setSourceFilter: React.Dispatch<React.SetStateAction<string[]>>;
  currentIdentity: TrackerIdentity | null;
  favoriteItemIds: ReadonlySet<string>;
  viewedAtByItemId: ReadonlyMap<string, number>;
  readinessByItemId: ReadonlyMap<string, Readiness>;
  personalStateHydrated: boolean;
  activeSavedView: SavedView | null;
  savedViewDirty: boolean;
  /** False for a built-in view, whose name and definition come from code. */
  savedViewEditable?: boolean;
  showSaveViewAction: boolean;
  onSaveView: (name: string) => void;
  onRenameSavedView: (name: string) => void;
  onUpdateSavedView: () => void;
  onExitSavedView: () => void;
}

export const TrackerMainView: React.FC<TrackerMainViewProps> = ({
  filterType,
  activeFilters,
  viewMode,
  onViewModeChange,
  onSwitchToFilesMode,
  workspacePath,
  teamPresenceOrgId,
  teamName,
  teamMembers = [],
  trackerTypes,
  onClearSidebarFilters,
  tagFilter,
  setTagFilter,
  sourceFilter,
  setSourceFilter,
  currentIdentity,
  favoriteItemIds,
  viewedAtByItemId,
  readinessByItemId,
  personalStateHydrated,
  activeSavedView,
  savedViewDirty,
  savedViewEditable = true,
  showSaveViewAction,
  onSaveView,
  onRenameSavedView,
  onUpdateSavedView,
  onExitSavedView,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [quickAddType, setQuickAddType] = useState<string | null>(null);
  const [pendingWorktreeLaunch, setPendingWorktreeLaunch] = useState<TrackerLaunchContext | null>(null);
  const [openFiltersToken, setOpenFiltersToken] = useState(0);

  // User's selected default model. Used by handleLaunchSession so the new
  // session uses the workspace's configured provider rather than always
  // falling back to claude-code (which fails for Codex-only installs).
  // See nimbalyst#176.
  const defaultModel = useAtomValue(defaultAgentModelAtom);
  const isWorktreesFeatureAvailable = useAtomValue(worktreesFeatureAvailableAtom);
  // Branch from the repo the worktree will actually be created in -- in a
  // multi-root workspace that is not necessarily the primary root.
  const activeFileRepoPath = useAtomValue(activeFileRepoPathAtom);
  const worktreeSourceRepoPath = activeFileRepoPath ?? workspacePath ?? '';
  const isGitRepo = useGitRepoProbe(workspacePath);
  const presenceByMemberId = useAtomValue(orgPresenceAtomFamily(teamPresenceOrgId ?? ''));
  const agentAttention = useAtomValue(agentSessionAttentionAtom);
  const gitStatus = useAtomValue(gitStatusAtom);

  const radarPresenceByActorKey = useMemo<Readonly<Record<string, RadarPresence>> | undefined>(() => {
    if (!presenceByMemberId) return undefined;
    const mapped: Record<string, RadarPresence> = {};
    for (const member of teamMembers) {
      if (!member.memberId) continue;
      const presence = presenceByMemberId[member.memberId];
      if (!presence) continue;
      const actorKey = trackerRadarActorKey({
        email: member.email,
        displayName: member.name ?? member.email,
        gitName: null,
        gitEmail: null,
      });
      mapped[actorKey] = {
        status: presence.status,
        lastHeartbeatAt: presence.lastHeartbeatAt,
      };
    }
    return Object.keys(mapped).length > 0 ? mapped : undefined;
  }, [presenceByMemberId, teamMembers]);

  const currentRadarActorKey = currentIdentity ? trackerRadarActorKey(currentIdentity) : null;
  const radarLastSeenAt = currentRadarActorKey
    ? radarPresenceByActorKey?.[currentRadarActorKey]?.lastHeartbeatAt
    : undefined;
  const radarEnrichmentByActorKey = useMemo<Readonly<Record<string, RadarLaneEnrichment>> | undefined>(() => {
    if (!currentRadarActorKey) return undefined;
    const liveSessions = agentAttention.running.length;
    const unpushedCommits = gitStatus?.ahead ?? 0;
    const behind = gitStatus?.behind ?? 0;
    if (liveSessions === 0 && unpushedCommits === 0 && behind === 0) return undefined;
    return {
      [currentRadarActorKey]: {
        liveSessions: liveSessions || undefined,
        unpushedCommits: unpushedCommits || undefined,
        divergence: behind > 0 ? `${behind} behind` : undefined,
      },
    };
  }, [agentAttention.running.length, currentRadarActorKey, gitStatus?.ahead, gitStatus?.behind]);

  useEffect(() => {
    if (!workspacePath) return;
    void initSessionList(workspacePath);
  }, [workspacePath]);

  // Drive the per-item "unread" dots from the local read-receipt store.
  useTrackerUnread(workspacePath, currentIdentity?.email ?? null);

  // Selected item for detail panel
  const modeLayout = useAtomValue(trackerModeLayoutAtom);
  const resolveRelationshipLabel = useAtomValue(trackerRelationshipLabelAtom);
  const setModeLayout = useSetAtom(setTrackerModeLayoutAtom);
  // Display Settings for the selected type; the root layout fields are only the
  // fallback behind these, so nothing here reads them directly.
  const viewSettings = useAtomValue(trackerActiveViewSettingsAtom);
  const setTypeViewSettings = useSetAtom(setTrackerTypeViewSettingsAtom);
  const setDocumentChatSession = useSetAtom(setTrackerDocumentChatSessionAtom);
  const setFavorite = useSetAtom(setTrackerFavoriteAtom);
  // Non-null only while the selected item is presented as a document.
  const documentItemId = useAtomValue(trackerModeDocumentItemIdAtom);
  // How the detail is editing the body, reported by TrackerItemDetail: the
  // focused header hosts the collab chrome only for collaborative bodies.
  const [detailContentMode, setDetailContentMode] = useState<TrackerContentMode>('file-backed');
  // The body's Lexical editor, published by the detail once it mounts. State
  // rather than a ref: the document header bar's table of contents and
  // editor-backed actions only appear once there is an editor to read.
  const [bodyEditor, setBodyEditor] = useState<unknown>(null);
  const setItemView = useSetAtom(setTrackerItemViewAtom);
  const openItemAsDocument = useSetAtom(openTrackerItemAsDocumentAtom);
  const selectedItemId = modeLayout.selectedItemId;
  const inboxScope = modeLayout.inboxScope;
  const statusScope = modeLayout.statusScope;
  const detailPanelWidth = modeLayout.detailPanelWidth;
  const sortBy = viewSettings.sortBy as TrackerSortColumn;
  const sortDirection = viewSettings.sortDirection as TrackerSortDirection;

  // Column config for the current type (persisted per-type)
  const columnConfigKey = filterType === 'all' ? 'all' : filterType;
  const columnConfig = useMemo(() => {
    const persisted = modeLayout.typeColumnConfigs[columnConfigKey];
    // If persisted config is missing or has too few columns (stale), use fresh defaults
    if (!persisted || persisted.visibleColumns.length < 3) {
      return getDefaultColumnConfig(columnConfigKey === 'all' ? '' : columnConfigKey);
    }
    // Silent migration: inject the structural 'key' column (issue key)
    // right after 'type' for users who saved configs before this column
    // existed. Without this, the issueKey would be invisible since the
    // title cell no longer renders it inline.
    if (!persisted.visibleColumns.includes('key')) {
      const typeIdx = persisted.visibleColumns.indexOf('type');
      const insertAt = typeIdx >= 0 ? typeIdx + 1 : 0;
      const visibleColumns = [...persisted.visibleColumns];
      visibleColumns.splice(insertAt, 0, 'key');
      return { ...persisted, visibleColumns };
    }
    return persisted;
  }, [modeLayout.typeColumnConfigs, columnConfigKey]);

  // The document view's left pane is a few hundred pixels wide, so it drops the
  // badge columns -- the title (plus its unread/favorite affordances) is all
  // that fits.
  const slimColumnConfig = useMemo<TypeColumnConfig>(() => ({
    visibleColumns: ['title'],
    columnWidths: {},
  }), []);

  const handleColumnConfigChange = useCallback((config: TypeColumnConfig) => {
    setModeLayout({
      typeColumnConfigs: {
        ...modeLayout.typeColumnConfigs,
        [columnConfigKey]: config,
      },
    });
  }, [setModeLayout, modeLayout.typeColumnConfigs, columnConfigKey]);

  // Display Settings are persisted per-type on the same key as the columns, so
  // grouping a bug list by status leaves the plan list alone (#1412).
  const handleViewLayoutChange = useCallback((updates: TrackerViewLayoutUpdate) => {
    setTypeViewSettings({ typeKey: columnConfigKey, ...updates });
  }, [setTypeViewSettings, columnConfigKey]);

  const handleSortChange = useCallback((sortBy: string, sortDirection: TrackerSortDirection) => {
    setTypeViewSettings({ typeKey: columnConfigKey, sortBy, sortDirection });
  }, [setTypeViewSettings, columnConfigKey]);

  // Per-column filters, persisted per-type alongside the column layout.
  const columnFilters = modeLayout.typeColumnFilters[columnConfigKey] ?? null;
  const hasRelativeFilters = (columnFilters?.clauses ?? []).some(clause =>
    clause.op === 'in-last' || clause.op === 'not-in-last');
  const [filterClockMs, setFilterClockMs] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRelativeFilters) return;
    setFilterClockMs(Date.now());
    const interval = window.setInterval(() => setFilterClockMs(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, [hasRelativeFilters]);
  const filterContext = useMemo(() => ({
    identity: currentIdentity,
    favoriteItemIds,
    viewedAtByItemId,
    readinessByItemId,
    nowMs: filterClockMs,
  }), [currentIdentity, favoriteItemIds, filterClockMs, readinessByItemId, viewedAtByItemId]);
  const filterEvaluationContext = useMemo<TrackerFilterEvaluationContext>(() => ({
    currentUser: currentIdentity,
    nowMs: filterClockMs,
  }), [currentIdentity, filterClockMs]);

  const handleColumnFiltersChange = useCallback((filters: TrackerFilterSet) => {
    setModeLayout({
      typeColumnFilters: {
        ...modeLayout.typeColumnFilters,
        [columnConfigKey]: filters,
      },
    });
  }, [setModeLayout, modeLayout.typeColumnFilters, columnConfigKey]);

  const schemaType = columnConfigKey === 'all' ? '' : columnConfigKey;
  const availableColumns = useMemo(
    () => resolveColumnsForType(schemaType),
    [schemaType],
  );

  const filterFields = useMemo<TrackerFilterField[]>(
    () => createTrackerFilterFields(availableColumns, schemaType, trackerTypes),
    [availableColumns, schemaType, trackerTypes],
  );
  const getViewFilterValue = useCallback(
    (item: TrackerRecord, field: string): unknown => getTrackerHeaderFilterValue(
      item,
      field,
      availableColumns,
      filterContext,
    ),
    [availableColumns, filterContext],
  );

  // Navigation atoms for tracker-session linking
  const setSelectedWorkstream = useSetAtom(setSelectedWorkstreamAtom);
  const setWindowMode = useSetAtom(setWindowModeAtom);
  const refreshSessionList = useSetAtom(refreshSessionListAtom);
  const createNewWorktreeSession = useSetAtom(createNewWorktreeSessionActionAtom);

  /** Navigate to Agent mode and activate a linked session */
  const handleSwitchToAgentMode = useCallback((sessionId: string) => {
    // Determine session type for proper workstream selection
    const registry = store.get(sessionRegistryAtom);
    const sessionMeta = registry.get(sessionId);

    // If it's a child session, select the parent workstream
    if (sessionMeta?.parentSessionId) {
      const parentMeta = registry.get(sessionMeta.parentSessionId);
      if (parentMeta) {
        setSelectedWorkstream({
          workspacePath: workspacePath || '',
          selection: { type: 'workstream', id: sessionMeta.parentSessionId },
        });
        setWindowMode('agent');
        return;
      }
    }

    // Root session -- determine type from workstream state
    const state = store.get(workstreamStateAtom(sessionId));
    const type = state.type === 'worktree' ? 'worktree'
      : state.type === 'workstream' ? 'workstream'
      : 'session';

    setSelectedWorkstream({
      workspacePath: workspacePath || '',
      selection: { type, id: sessionId },
    });
    setWindowMode('agent');
  }, [workspacePath, setSelectedWorkstream, setWindowMode]);

  /**
   * Sessions linked to one item, shaped for the row/card context menus.
   *
   * Reads the registry through `store` rather than subscribing: the registry
   * churns on every streaming token, and these menus only need a snapshot taken
   * at the moment they open.
   */
  const getLinkedSessionOptions = useCallback((itemId: string): TrackerLinkedSessionOption[] => {
    const item = store.get(trackerItemsMapAtom).get(itemId);
    if (!item) return [];
    return resolveLinkedSessions(item, store.get(sessionRegistryAtom)).map(session => ({
      id: session.id,
      title: session.title || 'Untitled session',
      provider: session.provider,
      timeLabel: getRelativeTimeString(session.updatedAt),
    }));
  }, []);

  /** Launch a new AI session linked to a tracker item */
  const handleLaunchSession = useCallback(async (trackerItemId: string) => {
    try {
      const itemsMap = store.get(trackerItemsMapAtom);
      const trackerContext = buildTrackerLaunchContext(
        trackerItemId,
        itemsMap.get(trackerItemId),
      );

      // Derive provider from the user's default model rather than hardcoding
      // 'claude-code'. Mirrors AgentMode.createNewSession so a Codex-only
      // workspace launches a Codex session, not a failed claude-code one.
      // See nimbalyst#176.
      const sessionId = crypto.randomUUID();
      const parsedModel = defaultModel ? ModelIdentifier.tryParse(defaultModel) : null;
      const provider = parsedModel?.provider || 'claude-code';
      const result = await window.electronAPI.invoke('sessions:create', {
        session: {
          id: sessionId,
          provider,
          model: defaultModel,
          title: 'New Session',
        },
        workspaceId: workspacePath,
      });
      if (result?.success && result?.id) {
        await window.electronAPI.invoke('tracker:link-session', {
          trackerId: trackerContext.trackerLinkId,
          sessionId: result.id,
        });
        await window.electronAPI.invoke(
          'ai:saveDraftInput',
          result.id,
          trackerContext.draftInput,
          workspacePath,
        );

        // Refresh session list to pick up the new session, then navigate
        await refreshSessionList();
        setSelectedWorkstream({
          workspacePath: workspacePath || '',
          selection: { type: 'session', id: result.id },
        });
        setWindowMode('agent');
      }
    } catch (err) {
      console.error('[TrackerMainView] Failed to launch session:', err);
    }
  }, [workspacePath, refreshSessionList, setSelectedWorkstream, setWindowMode, defaultModel]);

  /** Launch a new isolated worktree session linked to a tracker item. */
  const handleLaunchWorktree = useCallback((trackerItemId: string) => {
    const itemsMap = store.get(trackerItemsMapAtom);
    setPendingWorktreeLaunch(buildTrackerLaunchContext(
      trackerItemId,
      itemsMap.get(trackerItemId),
    ));
  }, []);

  const handleCreateTrackerWorktree = useCallback(async (
    options: WorktreePickerCreateOptions,
  ) => {
    if (!pendingWorktreeLaunch) return;

    try {
      const sessionId = await createNewWorktreeSession({
        ...options,
        initialDraft: pendingWorktreeLaunch.draftInput,
      });
      if (!sessionId) throw new Error('Worktree session was not created');

      await window.electronAPI.invoke('tracker:link-session', {
        trackerId: pendingWorktreeLaunch.trackerLinkId,
        sessionId,
      });
      await refreshSessionList();
      handleSwitchToAgentMode(sessionId);
      setPendingWorktreeLaunch(null);
    } catch (err) {
      console.error('[TrackerMainView] Failed to launch worktree:', err);
      throw err;
    }
  }, [createNewWorktreeSession, handleSwitchToAgentMode, pendingWorktreeLaunch, refreshSessionList]);

  // Base item sets from atoms
  const activeItems = useAtomValue(trackerItemsByTypeAtom(filterType));
  const archivedItems = useAtomValue(archivedTrackerItemsAtom(filterType));
  const allActiveItems = useAtomValue(trackerItemsByTypeAtom('all'));
  const allArchivedItems = useAtomValue(archivedTrackerItemsAtom('all'));
  const filtersArchived = (columnFilters?.clauses ?? []).some(clause => clause.field === 'archived');
  const showArchived = activeFilters.includes('archived');
  const viewSourceItems = useMemo(
    () => showArchived
      ? archivedItems
      : filtersArchived ? [...activeItems, ...archivedItems] : activeItems,
    [activeItems, archivedItems, filtersArchived, showArchived],
  );
  const globalViewSourceItems = useMemo(
    () => showArchived
      ? allArchivedItems
      : filtersArchived ? [...allActiveItems, ...allArchivedItems] : allActiveItems,
    [allActiveItems, allArchivedItems, filtersArchived, showArchived],
  );
  const sourceFilteredViewItems = useMemo(() => {
    if (sourceFilter.length === 0) return viewSourceItems;
    const allowed = new Set(sourceFilter);
    return viewSourceItems.filter(item => allowed.has(recordSourceKey(item)));
  }, [sourceFilter, viewSourceItems]);
  const sourceFilteredGlobalViewItems = useMemo(() => {
    if (sourceFilter.length === 0) return globalViewSourceItems;
    const allowed = new Set(sourceFilter);
    return globalViewSourceItems.filter(item => allowed.has(recordSourceKey(item)));
  }, [globalViewSourceItems, sourceFilter]);

  // Apply multi-select filters as intersection
  const baseFilteredItems = useMemo(() => {
    return filterTrackerItems(
      viewSourceItems,
      {
        activeFilters,
        tagFilter: [],
        recentlyViewedDays: modeLayout.recentlyViewedDays,
        statusScope,
      },
      filterContext,
    );
  }, [activeFilters, filterContext, modeLayout.recentlyViewedDays, statusScope, viewSourceItems]);

  const allTags = useMemo(() => buildTrackerTagOptions(baseFilteredItems), [baseFilteredItems]);

  // The omnibox narrows these against what the user is typing; all this owes it
  // is the set of tags not already applied.
  const availableTagOptions = useMemo(() => {
    const activeSet = new Set(tagFilter);
    return allTags.filter((tag) => !activeSet.has(tag.name));
  }, [allTags, tagFilter]);

  // Source provenance: 'native' or the importer provider id (from origin).
  const sourceField = useMemo(() => sourceFilterField(baseFilteredItems.map(recordSourceKey)), [baseFilteredItems]);
  const sourceOptions = useMemo(() => (sourceField.options ?? []).map((option) => option.value), [sourceField]);

  // Only worth offering the Source filter once imported items coexist with native ones.
  const showSourceFilter = sourceOptions.some((k) => k !== 'native');

  const filteredItems = useMemo(() => {
    return filterTrackerItems(viewSourceItems, {
      activeFilters,
      tagFilter,
      sourceFilter,
      recentlyViewedDays: modeLayout.recentlyViewedDays,
      statusScope,
    }, filterContext);
  }, [
    activeFilters,
    filterContext,
    modeLayout.recentlyViewedDays,
    sourceFilter,
    statusScope,
    tagFilter,
    viewSourceItems,
  ]);

  const headerFilterFields = useMemo<TrackerFilterField[]>(
    () => buildHeaderFilterFields(filterFields, filteredItems, getViewFilterValue),
    [filterFields, filteredItems, getViewFilterValue],
  );

  const effectiveViewDefinition = useMemo<SavedViewDefinition>(() => ({
    selectedType: 'all',
    activeFilters,
    viewMode: viewSettings.viewMode,
    tagFilter,
    groupBy: viewSettings.groupBy,
    ordering: viewSettings.ordering,
    sortBy: viewSettings.sortBy,
    sortDirection: viewSettings.sortDirection,
    recentlyViewedDays: modeLayout.recentlyViewedDays,
    columnConfig,
    columnFilters,
    inboxScope,
    statusScope,
  }), [
    activeFilters,
    columnConfig,
    columnFilters,
    inboxScope,
    modeLayout.recentlyViewedDays,
    statusScope,
    tagFilter,
    viewSettings,
  ]);
  const viewRowOptions = useMemo(() => ({
    ...filterContext,
    capabilities: DESKTOP_TRACKER_UI_CAPABILITIES,
    searchTerm: searchQuery,
  }), [filterContext, searchQuery]);
  const { rows: viewFilteredItems } = useTrackerViewRows(
    sourceFilteredViewItems,
    effectiveViewDefinition,
    viewRowOptions,
  );
  const { rows: globalViewFilteredItems } = useTrackerViewRows(
    sourceFilteredGlobalViewItems,
    effectiveViewDefinition,
    viewRowOptions,
  );
  const unscopedViewDefinition = useMemo<SavedViewDefinition>(
    () => ({ ...effectiveViewDefinition, statusScope: 'all' }),
    [effectiveViewDefinition],
  );
  const { rows: unscopedViewFilteredItems } = useTrackerViewRows(
    sourceFilteredViewItems,
    unscopedViewDefinition,
    viewRowOptions,
  );
  const { rows: unscopedGlobalViewFilteredItems } = useTrackerViewRows(
    sourceFilteredGlobalViewItems,
    unscopedViewDefinition,
    viewRowOptions,
  );

  // Global inbox scope must start from the all-types source. Passing the
  // selected type's already-filtered rows would make "global" silently mean
  // "the current sidebar type".
  const inboxFilteredItems = inboxScope === 'global'
    ? globalViewFilteredItems
    : viewFilteredItems;

  const personalStateRequired = activeFilters.includes('favorites')
    || activeFilters.includes('recently-viewed')
    || (columnFilters?.clauses ?? []).some(clause =>
      clause.field === 'favorite' || clause.field === 'viewed');
  const recencyOrderActive = activeFilters.some((filter) => filter === 'recently-updated'
    || filter === 'recently-viewed' || filter === 'recently-edited-by-others');
  const handleToggleFavorite = useCallback((itemId: string) => {
    void setFavorite({ itemId, isFavorite: !favoriteItemIds.has(itemId) });
  }, [favoriteItemIds, setFavorite]);

  // The search box shows the source filter as one more pill beside the column filters.
  const omniboxFields = useMemo(
    () => (showSourceFilter || sourceFilter.length > 0 ? [...headerFilterFields, sourceField] : headerFilterFields),
    [headerFilterFields, showSourceFilter, sourceField, sourceFilter.length],
  );
  const omniboxFilters = useMemo(() => withSourceClause(columnFilters, sourceFilter), [columnFilters, sourceFilter]);
  const handleOmniboxFiltersChange = useCallback((filters: TrackerFilterSet) => {
    const split = splitSourceClause(filters, sourceOptions);
    setSourceFilter(split.sourceFilter);
    handleColumnFiltersChange(split.columnFilters);
  }, [handleColumnFiltersChange, setSourceFilter, sourceOptions]);
  const [filterAnchor, setFilterAnchor] = useState<HTMLDivElement | null>(null);

  const hasExternalTableFilters = activeFilters.length > 0
    || tagFilter.length > 0
    || sourceFilter.length > 0
    || hasActiveFilters(columnFilters);
  const clearTableFilters = useCallback(() => {
    setSearchQuery('');
    setTagFilter([]);
    setSourceFilter([]);
    handleColumnFiltersChange({ combinator: 'and', clauses: [] });
    onClearSidebarFilters();
  }, [handleColumnFiltersChange, onClearSidebarFilters]);

  // `unblocks` is derived from the dependency graph, not read off a record, so
  // the leverage order is applied here and the surfaces are told to preserve it
  // rather than being taught a synthetic sort column.
  const leverageOrderActive = sortBy === READINESS_LEVERAGE_SORT;
  const preserveOrder = recencyOrderActive || leverageOrderActive;

  const viewItemsWithPersonalFields = useMemo(() => {
    const ordered = leverageOrderActive
      ? orderTrackerItemsByLeverage(viewFilteredItems, readinessByItemId)
      : viewFilteredItems;
    return ordered.map(item => ({
      ...item,
      fields: {
        ...item.fields,
        viewed: viewedAtByItemId.has(item.id)
          ? new Date(viewedAtByItemId.get(item.id)!)
          : undefined,
      },
    }));
  }, [leverageOrderActive, readinessByItemId, viewFilteredItems, viewedAtByItemId]);

  // Which blockers this view is entitled to name. Readiness is derived over the
  // whole corpus and stays that way -- narrowing it here would report blocked
  // work as ready -- so what narrows is only the explanation: a blocker in a
  // type or an archive scope the user is not looking at is still counted and
  // still shows its state, but not its title or its private reference.
  //
  // Only the scoping filters belong here. Search and status narrow within a
  // scope the user is already looking at, and a blocker almost never matches
  // the same search text as its dependent.
  const blockerScope = useMemo<BlockerVisibilityScope>(() => {
    const type = filterType === 'all' ? undefined : filterType;
    const showArchived = activeFilters.includes('archived');
    const filtersArchived = (columnFilters?.clauses ?? []).some(clause => clause.field === 'archived');
    if (filtersArchived) return { type };
    const excluded = showArchived ? allActiveItems : allArchivedItems;
    return { type, excludedItemIds: new Set(excluded.map(item => item.id)) };
  }, [activeFilters, allActiveItems, allArchivedItems, columnFilters, filterType]);

  // Cycle members are open by construction, but an archived item can still be
  // open, so both sets are searched. Workspace-wide on purpose: a deadlock is a
  // property of the graph, not of whichever type is selected in the sidebar.
  const dependencyCycleItems = useMemo(() => {
    const cycleIds = new Set<string>();
    for (const [itemId, readiness] of readinessByItemId) {
      if (readiness.inCycle) cycleIds.add(itemId);
    }
    if (cycleIds.size === 0) return [];
    return [...allActiveItems, ...allArchivedItems].filter(item => cycleIds.has(item.id));
  }, [allActiveItems, allArchivedItems, readinessByItemId]);

  // Pre-warm body Y.Docs for visible team-synced items so detail-open
  // hits a warm WebSocket + Y.Doc state (phase 4a of the tracker sync
  // redesign, D5). Filter to team trackers; personal items have no DocumentRoom and `resolveCollabConfigForUri`
  // would no-op for them. We also gate on a workspace-team check to
  // avoid 50 wasted IPC round-trips for workspaces without a team.
  const [hasTeam, setHasTeam] = useState(false);
  useEffect(() => {
    if (!workspacePath) {
      setHasTeam(false);
      return;
    }
    let cancelled = false;
    window.electronAPI
      .invoke('team:find-for-workspace', workspacePath)
      .then((result: { success?: boolean; team?: { orgId?: string } }) => {
        if (cancelled) return;
        setHasTeam(!!(result?.success && result.team?.orgId));
      })
      .catch(() => {
        if (!cancelled) setHasTeam(false);
      });
    return () => { cancelled = true; };
  }, [workspacePath]);

  const teamSyncedTypes = useMemo(() => {
    const out = new Set<string>();
    for (const t of trackerTypes) {
      if (t.sharing === 'team') out.add(t.type);
    }
    return out;
  }, [trackerTypes]);

  const visibleCollaborationScope = useMemo<'personal' | 'shared' | 'mixed' | 'unknown'>(() => {
    if (filteredItems.length === 0) return 'unknown';
    let hasShared = false;
    let hasPersonal = false;
    for (const item of filteredItems) {
      if (hasTeam && teamSyncedTypes.has(item.primaryType)) hasShared = true;
      else hasPersonal = true;
      if (hasShared && hasPersonal) return 'mixed';
    }
    return hasShared ? 'shared' : 'personal';
  }, [filteredItems, hasTeam, teamSyncedTypes]);

  const prewarmItemIds = useMemo(() => {
    if (!hasTeam || teamSyncedTypes.size === 0) return [];
    return filteredItems
      .filter(r => teamSyncedTypes.has(r.primaryType))
      .map(r => r.id);
  }, [filteredItems, teamSyncedTypes, hasTeam]);

  useTrackerBodyPrewarm({
    workspacePath,
    itemIds: prewarmItemIds,
    enabled: hasTeam,
  });

  const handleItemSelect = useCallback((itemId: string) => {
    const item = filteredItems.find(candidate => candidate.id === itemId);
    trackTeamAnalyticsEvent('tracker_item_clicked', {
      surface: 'desktop',
      collaborationScope: item
        ? (hasTeam && teamSyncedTypes.has(item.primaryType) ? 'shared' : 'personal')
        : 'unknown',
    });
    setModeLayout({ selectedItemId: itemId });
  }, [filteredItems, hasTeam, setModeLayout, teamSyncedTypes]);

  const trackTableSort = useCallback(() => {
    trackTeamAnalyticsEvent('tracker_table_sort', {
      surface: 'desktop',
      collaborationScope: visibleCollaborationScope,
    });
  }, [visibleCollaborationScope]);

  const handleCloseDetail = useCallback(() => {
    setModeLayout({ selectedItemId: null });
  }, [setModeLayout]);

  /** Swap the document in place when a row in the slim list pane is clicked. */
  const handleOpenItemAsDocument = useCallback((itemId: string) => {
    openItemAsDocument(itemId);
  }, [openItemAsDocument]);

  /** Back to the ordinary list + detail-panel presentation. */
  const handleCollapseToTracker = useCallback(() => {
    if (!documentItemId) return;
    setItemView({ itemId: documentItemId, view: 'item' });
  }, [documentItemId, setItemView]);

  const handleArchiveItem = useCallback(async (itemId: string, archive: boolean) => {
    if (refuseLocalWikiArchive([store.get(trackerItemsMapAtom).get(itemId)]).length > 0) return;
    try {
      const result = await window.electronAPI.documentService.archiveTrackerItem({ itemId, archive });
      if (!result.success) {
        console.error('[TrackerMainView] Failed to archive item:', result.error);
      }
    } catch (error) {
      console.error('[TrackerMainView] Failed to archive item:', error);
    }
  }, []);

  const handleDeleteItem = useCallback(async (itemId: string) => {
    const wikiRecord = store.get(trackerItemsMapAtom).get(itemId);
    if (wikiRecord && isLocalWikiRecord(wikiRecord)) {
      if (await deleteLocalWikiItem(wikiRecord) && selectedItemId === itemId) setModeLayout({ selectedItemId: null });
      return;
    }
    try {
      const result = await window.electronAPI.documentService.deleteTrackerItem({ itemId });
      if (result.success) {
        if (selectedItemId === itemId) {
          setModeLayout({ selectedItemId: null });
        }
      } else {
        console.error('[TrackerMainView] Failed to delete item:', result.error);
      }
    } catch (error) {
      console.error('[TrackerMainView] Failed to delete item:', error);
    }
  }, [selectedItemId, setModeLayout]);

  /** Bulk delete for multi-select context menu */
  const handleDeleteItems = useCallback(async (itemIds: string[]) => {
    for (const itemId of itemIds) {
      const wikiRecord = store.get(trackerItemsMapAtom).get(itemId);
      if (wikiRecord && isLocalWikiRecord(wikiRecord)) {
        if (await deleteLocalWikiItem(wikiRecord) && selectedItemId === itemId) setModeLayout({ selectedItemId: null });
        continue;
      }
      try {
        await window.electronAPI.documentService.deleteTrackerItem({ itemId });
        if (selectedItemId === itemId) {
          setModeLayout({ selectedItemId: null });
        }
      } catch (error) {
        console.error('[TrackerMainView] Failed to delete item:', error);
      }
    }
  }, [selectedItemId, setModeLayout]);

  const teamOrgId = useAtomValue(activeTeamOrgIdAtom);
  const handleCopyDeepLink = useCallback(async (itemId: string) => {
    if (!teamOrgId) return;
    const url = buildTrackerDeepLink(itemId, teamOrgId);
    try {
      await copyToClipboard(url);
      errorNotificationService.showInfo(
        'Link copied',
        'Paste it anywhere to open this tracker in Nimbalyst.',
        { duration: 3000 }
      );
    } catch (err) {
      console.error('[TrackerMainView] Failed to copy link:', err);
      errorNotificationService.showError(
        'Copy failed',
        'Could not write the link to the clipboard.'
      );
    }
  }, [teamOrgId]);

  /** Link that reopens the item in document view (`view=document`). */
  const handleCopyDocumentLink = useCallback(async () => {
    if (!teamOrgId || !documentItemId) return;
    const url = buildTrackerDocumentDeepLink(documentItemId, teamOrgId);
    try {
      await copyToClipboard(url);
      errorNotificationService.showInfo(
        'Document link copied',
        'Paste it anywhere to open this item as a document in Nimbalyst.',
        { duration: 3000 }
      );
    } catch (err) {
      console.error('[TrackerMainView] Failed to copy document link:', err);
      errorNotificationService.showError(
        'Copy failed',
        'Could not write the link to the clipboard.'
      );
    }
  }, [documentItemId, teamOrgId]);

  /** Bulk archive for multi-select context menu */
  const handleArchiveItems = useCallback(async (itemIds: string[], archive: boolean) => {
    const items = store.get(trackerItemsMapAtom);
    const refused = new Set(refuseLocalWikiArchive(itemIds.map((itemId) => items.get(itemId))).map((record) => record.id));
    for (const itemId of itemIds) {
      if (refused.has(itemId)) continue;
      try {
        await window.electronAPI.documentService.archiveTrackerItem({ itemId, archive });
      } catch (error) {
        console.error('[TrackerMainView] Failed to archive item:', error);
      }
    }
  }, []);

  const handleNewItem = useCallback((type: string) => {
    // An archived tracker keeps everything it has and gains nothing more.
    const writeAccess = resolveTrackerWriteAccess(globalRegistry.get(type));
    if (!writeAccess.canWrite) {
      errorNotificationService.showInfo('Archived tracker', writeAccess.readOnlyReason ?? '', { duration: 4000 });
      return;
    }
    setQuickAddType(type);
  }, []);

  const handleQuickAddClose = useCallback(() => {
    setQuickAddType(null);
  }, []);

  const handleQuickAddSubmit = useCallback(async (title: string, priority: string) => {
    if (!workspacePath || !quickAddType) return;

    try {
      const priorityField = globalRegistry.get(quickAddType)?.roles?.priority ?? 'priority';
      const built = buildTrackerCreatePayload(
        quickAddType,
        { title, fields: { [priorityField]: priority } },
        { workspacePath },
      );
      if (!built.ok) {
        throw new Error(formatTrackerValidationErrors(built.errors));
      }

      // A wiki type's item is a file in the Local wiki; any other stays in the app database.
      const result = await createTrackerItem(built.payload);

      if (!result.success) {
        throw new Error(result.error || 'Failed to create tracker item');
      }

      setQuickAddType(null);
      // Auto-select the newly created item so the detail panel opens for editing
      const createdId = result.item?.id ?? built.payload.id;
      setModeLayout({ selectedItemId: createdId });
    } catch (error) {
      console.error('[TrackerMainView] Failed to create tracker item:', error);
    }
  }, [workspacePath, quickAddType, setModeLayout]);

  // Build a composite title from the active filters + type selection
  const title = useMemo(() => {
    const activeTracker = filterType !== 'all'
      ? trackerTypes.find(t => t.type === filterType)
      : null;
    const typeName = activeTracker ? activeTracker.displayNamePlural : 'Items';

    const parts: string[] = [];
    if (activeFilters.includes('archived')) parts.push('Archived');
    if (activeFilters.includes('mine')) parts.push('My');
    if (activeFilters.includes('high-priority')) parts.push('High Priority');
    if (activeFilters.includes('recently-updated')) parts.push('Recent');

    if (parts.length === 0) {
      return activeTracker ? activeTracker.displayNamePlural : 'All Items';
    }
    return `${parts.join(' ')} ${typeName}`;
  }, [filterType, activeFilters, trackerTypes]);

  const displayedItemCount = viewMode === 'inbox'
    ? inboxFilteredItems.length
    : viewFilteredItems.length;
  const unscopedDisplayedItemCount = viewMode === 'inbox' && inboxScope === 'global'
    ? unscopedGlobalViewFilteredItems.length
    : unscopedViewFilteredItems.length;
  const hiddenByScopeCount = statusScope === 'all'
    ? 0
    : Math.max(0, unscopedDisplayedItemCount - displayedItemCount);
  const showColumnControls = viewMode === 'list'
    || viewMode === 'table';

  // ---- Document view (focused presentation of the selected item) ----

  // Document view only ever shows the selected item, so one detail element
  // serves both presentations -- and `TrackerDocumentView` keeps it at a single
  // JSX position so switching presentations never remounts the body editor.
  const detailItemId = documentItemId ?? selectedItemId;
  const detailNode = detailItemId ? (
    <TrackerItemDetail
      itemId={detailItemId}
      workspacePath={workspacePath}
      onClose={handleCloseDetail}
      onSwitchToFilesMode={onSwitchToFilesMode}
      onSwitchToAgentMode={handleSwitchToAgentMode}
      onOpenSessionInChat={(sessionId) => {
        setDocumentChatSession({ itemId: detailItemId, sessionId });
        setModeLayout({
          documentRightPanelMode: 'chat',
          documentRightPanelVisible: true,
        });
      }}
      onLaunchSession={handleLaunchSession}
      onLaunchWorktree={isWorktreesFeatureAvailable && isGitRepo !== false ? handleLaunchWorktree : undefined}
      onArchive={handleArchiveItem}
      onDelete={handleDeleteItem}
      onOpenItem={handleItemSelect}
      enableContentFocus
      contentFocus={Boolean(documentItemId)}
      onContentFocusChange={(focus) => {
        // The in-detail toggle is the same gesture as the document view: it
        // flips this item's persisted presentation rather than a local flag.
        setItemView({ itemId: detailItemId, view: focus ? 'document' : 'item' });
      }}
      // The focused header already carries the item's identity.
      hideHeader={Boolean(documentItemId)}
      onContentModeChange={setDetailContentMode}
      onBodyEditorReady={setBodyEditor}
    />
  ) : null;

  // Presence and the sync dot live in the detail's own header normally; in
  // document view that header is suppressed, so the document header bar hosts
  // them alongside the breadcrumb -- the same cluster a collaborative document
  // tab shows.

  const documentListPane = documentItemId ? (
    <TrackerTable
      filterType={filterType}
      sortBy={sortBy}
      sortDirection={sortDirection}
      groupBy={viewSettings.groupBy}
      hideTypeTabs
      hideToolbar
      preserveItemOrder={preserveOrder}
      readinessByItemId={readinessByItemId}
      blockerScope={blockerScope}
      favoriteItemIds={favoriteItemIds}
      onToggleFavorite={handleToggleFavorite}
      onItemSelect={handleOpenItemAsDocument}
      onOpenDocument={handleOpenItemAsDocument}
      selectedItemId={documentItemId}
      overrideItems={viewItemsWithPersonalFields}
      onArchiveItems={handleArchiveItems}
      onDeleteItems={handleDeleteItems}
      confirmDelete={confirmTrackerItemDelete}
      onCopyDeepLink={teamOrgId ? handleCopyDeepLink : undefined}
      searchQuery={searchQuery}
      hasExternalFilters={hasExternalTableFilters}
      onClearFilters={clearTableFilters}
      columnConfig={slimColumnConfig}
    />
  ) : null;

  // Document view hides the toolbar, so the list pane carries the search box --
  // the same `searchQuery` and the same persisted column filters, plus a typed
  // filter grammar so the whole dropdown is reachable from the keyboard.
  const documentListPaneSearch = documentItemId ? (
    <TrackerFilterOmnibox
      className="shrink-0 border-b border-nim px-2 py-1.5"
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      fields={headerFilterFields}
      filters={columnFilters}
      onFiltersChange={handleColumnFiltersChange}
      tagOptions={availableTagOptions}
      tagFilter={tagFilter}
      onTagFilterChange={setTagFilter}
    />
  ) : null;

  const itemChrome = (
    <>
      {/* Sync rejection banner -- key rotation / stale-envelope feedback */}
      <TrackerSyncRejectionBanner workspacePath={workspacePath} />
      {/* One-time summary of what the sharing-model upgrade moved (PRD D6) */}
      <TrackerSharingMigrationBanner workspacePath={workspacePath} teamName={teamName} />
      {/* Dependency deadlock: items that can never reach the ready queue */}
      <TrackerDependencyCycleBanner
        items={dependencyCycleItems}
        onOpenItem={handleItemSelect}
      />
      {/* Toolbar */}
      <div className="tracker-toolbar flex items-center gap-2 px-3 py-2 border-b border-nim bg-nim shrink-0">
        {/* Title */}
        <TrackerViewTitle
          fallbackTitle={title}
          activeSavedViewName={activeSavedView?.name}
          savedViewDirty={savedViewDirty}
          savedViewEditable={savedViewEditable}
          showSaveViewAction={showSaveViewAction && (tagFilter.length > 0 || hasActiveFilters(columnFilters))}
          onSaveView={onSaveView}
          onRenameSavedView={onRenameSavedView}
          onUpdateSavedView={onUpdateSavedView}
          onExitSavedView={onExitSavedView}
        />

        {/* Search + filter omnibox -- the same control the document-view list
            pane uses. Every filter (fields, #tags, source) is a pill inside the
            box, its x clears them all, and its filter icon opens the column
            filter builder under the box. */}
        <div ref={setFilterAnchor} className="tracker-toolbar-search min-w-[200px] flex-1 max-w-[560px]">
          <TrackerFilterOmnibox
            className="w-full"
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            fields={omniboxFields}
            filters={omniboxFilters}
            onFiltersChange={handleOmniboxFiltersChange}
            tagOptions={availableTagOptions}
            tagFilter={tagFilter}
            onTagFilterChange={setTagFilter}
            inlinePills
            onPillClick={(_index, clause) => {
              // Source is not a column, so the builder cannot edit it; it goes back into the text.
              if (clause.field === SOURCE_FILTER_FIELD) return false;
              setOpenFiltersToken(token => token + 1);
              return true;
            }}
            trailing={
              <button
                type="button"
                className="tracker-toolbar-filter-button inline-flex shrink-0 items-center rounded p-0.5 text-nim-faint hover:bg-nim-tertiary hover:text-nim"
                onClick={() => setOpenFiltersToken(token => token + 1)}
                title="Filter by field"
                aria-label="Filter by field"
                data-testid="tracker-view-filter-button"
              >
                <MaterialSymbol icon="filter_list" size={14} />
              </button>
            }
          />
        </div>

        <div className="flex-1" />

        <TrackerViewHeaderControls
          itemCount={displayedItemCount}
          unscopedItemCount={displayedItemCount + hiddenByScopeCount}
          availableColumns={availableColumns}
          columnConfig={columnConfig}
          onColumnConfigChange={handleColumnConfigChange}
          showColumnControls={showColumnControls}
          filterFields={headerFilterFields}
          filters={columnFilters}
          onFiltersChange={handleColumnFiltersChange}
          openFiltersToken={openFiltersToken}
          filterAnchor={filterAnchor}
          statusScope={statusScope}
          onStatusScopeChange={scope => setModeLayout({ statusScope: scope })}
          viewMode={viewSettings.viewMode}
          groupBy={viewSettings.groupBy}
          ordering={viewSettings.ordering}
          onLayoutChange={handleViewLayoutChange}
        />

        <TrackerNewMenu
          workspacePath={workspacePath}
          // Non-creatable types (e.g. automations) keep the import menu but not New.
          canCreate={trackerTypes.find(t => t.type === (filterType !== 'all' ? filterType : 'task'))?.creatable !== false}
          onNewItem={() => handleNewItem(filterType !== 'all' ? filterType : 'task')}
        />
      </div>
    </>
  );

  const itemListPane = (
    <>
      {personalStateRequired && !personalStateHydrated ? (
            <div className="h-full flex items-center justify-center text-sm text-nim-muted" data-testid="tracker-personal-state-loading">
              Loading personal tracker state...
            </div>
          ) : viewMode === 'list' ? (
            <TrackerTable
              filterType={filterType}
              sortBy={sortBy}
              sortDirection={sortDirection}
              groupBy={viewSettings.groupBy}
              hideTypeTabs={true}
              onSortChange={(column, direction) => {
                trackTableSort();
                handleSortChange(column, direction);
              }}
              preserveItemOrder={preserveOrder}
              readinessByItemId={readinessByItemId}
              blockerScope={blockerScope}
              favoriteItemIds={favoriteItemIds}
              onToggleFavorite={handleToggleFavorite}
              onSwitchToFilesMode={onSwitchToFilesMode}
              onNewItem={handleNewItem}
              onItemSelect={handleItemSelect}
              selectedItemId={selectedItemId}
              overrideItems={viewItemsWithPersonalFields}
              onArchiveItems={handleArchiveItems}
              onDeleteItems={handleDeleteItems}
              confirmDelete={confirmTrackerItemDelete}
              onCopyDeepLink={teamOrgId ? handleCopyDeepLink : undefined}
              onOpenDocument={handleOpenItemAsDocument}
              searchQuery={searchQuery}
              hasExternalFilters={hasExternalTableFilters}
              onClearFilters={clearTableFilters}
              columnConfig={columnConfig}
              onColumnConfigChange={handleColumnConfigChange}
              hideToolbar
            />
          ) : viewMode === 'table' ? (
            <TrackerGridView
              filterType={filterType}
              sortBy={sortBy}
              sortDirection={sortDirection}
              groupBy={viewSettings.groupBy}
              preserveItemOrder={preserveOrder}
              onSwitchToFilesMode={onSwitchToFilesMode}
              onNewItem={handleNewItem}
              onItemSelect={handleItemSelect}
              onDetailClose={handleCloseDetail}
              selectedItemId={selectedItemId}
              overrideItems={viewItemsWithPersonalFields}
              onArchiveItems={handleArchiveItems}
              onDeleteItems={handleDeleteItems}
              onCopyDeepLink={teamOrgId ? handleCopyDeepLink : undefined}
              onOpenDocument={handleOpenItemAsDocument}
              getLinkedSessions={getLinkedSessionOptions}
              onOpenSession={handleSwitchToAgentMode}
              onLaunchSession={handleLaunchSession}
              onLaunchWorktree={isWorktreesFeatureAvailable && isGitRepo !== false ? handleLaunchWorktree : undefined}
              favoriteItemIds={favoriteItemIds}
              onToggleFavorite={handleToggleFavorite}
              searchQuery={searchQuery}
              hasExternalFilters={hasExternalTableFilters}
              onClearFilters={clearTableFilters}
              columnConfig={columnConfig}
              onColumnConfigChange={handleColumnConfigChange}
              columnFilters={columnFilters}
              onColumnFiltersChange={handleColumnFiltersChange}
              filterFields={headerFilterFields}
              filterEvaluationContext={filterEvaluationContext}
              onSortChange={(column, direction) => {
                trackTableSort();
                handleSortChange(column, direction);
              }}
            />
          ) : viewMode === 'inbox' ? (
            <TrackerInboxView
              filterType={filterType}
              overrideItems={inboxFilteredItems}
              onItemSelect={handleItemSelect}
              selectedItemId={selectedItemId}
              onArchiveItems={handleArchiveItems}
              onDeleteItems={handleDeleteItems}
              onSwitchToFilesMode={onSwitchToFilesMode}
              scope={inboxScope}
              onScopeChange={(scope) => setModeLayout({ inboxScope: scope })}
              currentIdentity={currentIdentity}
            />
          ) : viewMode === 'radar' ? (
            <TrackerRadarView
              items={viewFilteredItems}
              currentIdentity={currentIdentity}
              lastSeenAt={radarLastSeenAt}
              presenceByActorKey={radarPresenceByActorKey}
              enrichmentByActorKey={radarEnrichmentByActorKey}
              selectedItemId={selectedItemId}
              onItemSelect={handleItemSelect}
              onOpenDocument={handleOpenItemAsDocument}
            />
          ) : viewMode === 'timeline' ? (
            <TrackerTimelineView
              items={viewFilteredItems}
              groupBy={viewSettings.groupBy}
              ordering={viewSettings.ordering}
              onItemSelect={handleItemSelect}
              onOpenDocument={handleOpenItemAsDocument}
              selectedItemId={selectedItemId}
              resolveRelationshipLabel={resolveRelationshipLabel}
            />
          ) : viewMode === 'tag-board' ? (
            <TagBoard
              items={viewFilteredItems}
              onItemSelect={handleItemSelect}
              selectedItemId={selectedItemId}
              onOpenDocument={handleOpenItemAsDocument}
              renderUnreadSlot={(itemId) => <TrackerUnreadDot itemId={itemId} className="mt-1" />}
              renderFavoriteSlot={(itemId) => (
                <TrackerFavoriteStar
                  itemId={itemId}
                  isFavorite={favoriteItemIds.has(itemId)}
                  onToggle={handleToggleFavorite}
                />
              )}
            />
          ) : (
            <KanbanBoard
              filterType={filterType}
              groupBy={viewSettings.groupBy}
              ordering={viewSettings.ordering}
              searchQuery={searchQuery}
              onSwitchToFilesMode={onSwitchToFilesMode}
              onItemSelect={handleItemSelect}
              selectedItemId={selectedItemId}
              overrideItems={viewFilteredItems}
              onArchiveItems={handleArchiveItems}
              onDeleteItems={handleDeleteItems}
              onCopyDeepLink={teamOrgId ? handleCopyDeepLink : undefined}
              onOpenDocument={handleOpenItemAsDocument}
              getLinkedSessions={getLinkedSessionOptions}
              onOpenSession={handleSwitchToAgentMode}
              onLaunchSession={handleLaunchSession}
              onLaunchWorktree={isWorktreesFeatureAvailable && isGitRepo !== false ? handleLaunchWorktree : undefined}
              favoriteItemIds={favoriteItemIds}
              onToggleFavorite={handleToggleFavorite}
              currentIdentity={currentIdentity}
            />
          )}

          {/*
            Says what the scope is withholding. Silent truncation is the failure
            mode a default-on filter has to avoid: without this line, "where is
            the bug I closed yesterday?" has no answer on screen.
          */}
          {hiddenByScopeCount > 0 && (
            <div
              className="flex shrink-0 items-center gap-1.5 border-t border-nim px-3 py-1.5 text-[11px] text-nim-faint"
              data-testid="tracker-hidden-by-scope"
            >
              <span>
                {hiddenByScopeCount} closed item{hiddenByScopeCount === 1 ? '' : 's'} hidden
              </span>
              <button
                type="button"
                className="font-semibold text-[var(--nim-primary)] hover:underline"
                onClick={() => setModeLayout({ statusScope: 'all' })}
                data-testid="tracker-hidden-by-scope-show-all"
              >
                Show all
              </button>
            </div>
          )}

          {/* Quick Add overlay */}
          {quickAddType && (
            <TrackerQuickAddOverlay
              type={quickAddType}
              tracker={trackerTypes.find(t => t.type === quickAddType)}
              onSubmit={handleQuickAddSubmit}
              onClose={handleQuickAddClose}
            />
          )}
    </>
  );

  return (
    <>
      <TrackerDocumentView
        presentation={documentItemId ? 'document' : 'item'}
        documentItemId={documentItemId}
        workspacePath={workspacePath}
        itemChrome={itemChrome}
        listPane={documentItemId ? documentListPane : itemListPane}
        listPaneSearch={documentListPaneSearch}
        detail={detailNode}
        contentMode={detailContentMode}
        bodyEditor={bodyEditor}
        detailPanelWidth={detailPanelWidth}
        onDetailPanelWidthChange={(w) => setModeLayout({ detailPanelWidth: w })}
        onCopyDocumentLink={teamOrgId && documentItemId ? handleCopyDocumentLink : undefined}
        onCollapseToTracker={handleCollapseToTracker}
        onOpenItem={handleItemSelect}
        onSwitchToAgentMode={(sessionId) => {
          if (sessionId) handleSwitchToAgentMode(sessionId);
        }}
      />

      {workspacePath && pendingWorktreeLaunch && (
        <WorktreeBaseBranchPicker
          isOpen
          repoPath={worktreeSourceRepoPath}
          initialName={pendingWorktreeLaunch.worktreeName}
          onCreate={handleCreateTrackerWorktree}
          onCancel={() => setPendingWorktreeLaunch(null)}
        />
      )}
    </>
  );
};
