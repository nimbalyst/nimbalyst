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
  TrackerActiveFilterPills,
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
import { ImportFromSourceDialog } from './ImportFromSourceDialog';
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
import { buildTrackerTagOptions } from './trackerTagFilterUtils';
import {
  filterTrackerItems,
  recordSourceKey,
  type SavedView,
  type SavedViewDefinition,
} from './trackerSavedViews';
import { orderTrackerItemsByLeverage, READINESS_LEVERAGE_SORT } from './trackerReadyQueue';
import { useTrackerUnread } from '../../hooks/useTrackerUnread';
import { useGitRepoProbe } from '../../hooks/useGitRepoProbe';
import {
  createNewWorktreeSessionActionAtom,
} from '../../store/actions/sessionHistoryActions';
import { setTrackerFavoriteAtom } from '../../store/atoms/trackerPersonalState';
import { WorktreeBaseBranchPicker } from '../AgenticCoding/WorktreeBaseBranchPicker';
import {
  buildTrackerLaunchContext,
  type TrackerLaunchContext,
} from './trackerSessionLaunch';
import { trackTeamAnalyticsEvent } from '../../utils/teamAnalytics';
import { TrackerQuickAddOverlay } from './TrackerQuickAddOverlay';
import { orgPresenceAtomFamily } from '../../store/atoms/teamInbox';
import { gitStatusAtom } from '../../store/atoms/gitOperations';
import type { TeamMemberOption } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/TrackerFieldEditor';

export type ViewMode = TrackerViewMode;

/** Human label for a source key without probing the importer (avoids backend start). */
function sourceKeyLabel(key: string): string {
  if (key === 'native') return 'Native';
  // Map known provider ids; otherwise title-case the id.
  const known: Record<string, string> = {
    'github-issues': 'GitHub',
    linear: 'Linear',
  };
  if (known[key]) return known[key];
  return key
    .split(/[-_]/)
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join(' ');
}

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

  const removeFieldFilter = useCallback((clauseIndex: number) => {
    handleColumnFiltersChange({
      combinator: columnFilters?.combinator ?? 'and',
      clauses: (columnFilters?.clauses ?? []).filter((_, index) => index !== clauseIndex),
    });
  }, [columnFilters, handleColumnFiltersChange]);

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
    options: { baseBranch: string; name?: string },
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
  const sourceOptions = useMemo(() => {
    const keys = new Set<string>();
    for (const r of baseFilteredItems) keys.add(recordSourceKey(r));
    return Array.from(keys).sort((a, b) => (a === 'native' ? -1 : b === 'native' ? 1 : a.localeCompare(b)));
  }, [baseFilteredItems]);

  // Only worth showing the Source filter once imported items coexist with native ones.
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

  const toggleSource = useCallback((key: string) => {
    setSourceFilter((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  }, []);

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

  const removeTagFilter = useCallback((tag: string) => {
    setTagFilter((current) => current.filter((candidate) => candidate !== tag));
  }, []);

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
    for (const itemId of itemIds) {
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

      const result = await window.electronAPI.documentService.createTrackerItem(built.payload);

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

  // Import state
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const importMenuRef = useRef<HTMLDivElement>(null);

  // External-source importers (GitHub, ...) discovered from installed extensions.
  const [externalImporters, setExternalImporters] = useState<
    Array<{ id: string; displayName: string; icon: string; importsAs?: string[] }>
  >([]);
  const [sourceDialog, setSourceDialog] = useState<
    { providerId: string; providerLabel: string; importsAs?: string[] } | null
  >(null);

  // Close import menu on outside click
  useEffect(() => {
    if (!importMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (importMenuRef.current && !importMenuRef.current.contains(e.target as Node)) {
        setImportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [importMenuOpen]);

  // Load external importers when the import menu opens.
  useEffect(() => {
    if (!importMenuOpen || !workspacePath) return;
    let cancelled = false;
    window.electronAPI
      .invoke('tracker:importer:list', workspacePath)
      .then((list: unknown) => {
        if (!cancelled && Array.isArray(list)) {
          setExternalImporters(list as typeof externalImporters);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [importMenuOpen, workspacePath]);

  const handleBulkImport = useCallback(async (directory: string) => {
    setImportMenuOpen(false);
    setImportStatus('Importing...');
    try {
      const result = await window.electronAPI.documentService.bulkImportTrackerItems({
        directory,
        skipDuplicates: true,
        recursive: true,
      });
      if (result.success) {
        const parts: string[] = [];
        if (result.imported) parts.push(`${result.imported} imported`);
        if (result.skipped) parts.push(`${result.skipped} skipped`);
        if (result.errors?.length) parts.push(`${result.errors.length} errors`);
        setImportStatus(parts.join(', ') || 'No items found');
      } else {
        setImportStatus(`Failed: ${result.error}`);
      }
    } catch (error) {
      setImportStatus('Import failed');
      console.error('[TrackerMainView] Bulk import failed:', error);
    }
    // Clear status after 4 seconds
    setTimeout(() => setImportStatus(null), 4000);
  }, []);

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
          showSaveViewAction={showSaveViewAction}
          onSaveView={onSaveView}
          onRenameSavedView={onRenameSavedView}
          onUpdateSavedView={onUpdateSavedView}
          onExitSavedView={onExitSavedView}
        />

        {/* Search + filter omnibox -- the same control the document-view list
            pane uses. Pills stand down here: the toolbar renders its own
            horizontal pill row (and tag chips) beside the box. */}
        <TrackerFilterOmnibox
          className="flex-1 max-w-[420px]"
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          fields={headerFilterFields}
          filters={columnFilters}
          onFiltersChange={handleColumnFiltersChange}
          tagOptions={availableTagOptions}
          tagFilter={tagFilter}
          onTagFilterChange={setTagFilter}
          showPills={false}
        />

        <TrackerActiveFilterPills
          fields={headerFilterFields}
          filters={columnFilters}
          onManage={() => setOpenFiltersToken(token => token + 1)}
          onRemove={removeFieldFilter}
        />

        {tagFilter.length > 0 && (
          <div className="flex flex-wrap gap-1 shrink-0" data-testid="tracker-tag-chips">
            {tagFilter.map((tag) => (
              <button
                key={tag}
                type="button"
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border cursor-pointer bg-blue-400/[0.12] border-blue-400/30 text-blue-400 hover:bg-blue-400/[0.18]"
                onClick={() => removeTagFilter(tag)}
                title={`Remove #${tag} filter`}
                data-testid={`tracker-tag-chip-${tag}`}
              >
                #{tag}
                <MaterialSymbol icon="close" size={12} />
              </button>
            ))}
          </div>
        )}

        {/* Source provenance filter (appears once imported items exist).
            A segmented control -- visually distinct from the removable, pill-
            shaped column-filter chips so it doesn't read as "a filter I forgot
            to close". */}
        {showSourceFilter && (
          <div
            className="flex h-7 shrink-0 items-center overflow-hidden rounded border border-nim bg-nim-secondary"
            role="group"
            aria-label="Filter by source"
            data-testid="tracker-source-filter"
          >
            {sourceOptions.map((key, index) => {
              const active = sourceFilter.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleSource(key)}
                  className={`h-full px-2 text-[11px] font-medium transition-colors ${
                    index > 0 ? 'border-l border-nim' : ''
                  } ${
                    active
                      ? 'bg-[var(--nim-primary)]/15 text-nim'
                      : 'text-nim-muted hover:bg-nim-tertiary hover:text-nim'
                  }`}
                  aria-pressed={active}
                  title={`Filter by ${sourceKeyLabel(key)}`}
                  data-testid={`tracker-source-filter-${key}`}
                >
                  {sourceKeyLabel(key)}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex-1" />

        {hasExternalTableFilters && (
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded border border-nim bg-nim-secondary px-2 text-[11px] font-medium text-nim-muted transition-colors hover:bg-nim-tertiary hover:text-nim"
            onClick={clearTableFilters}
            title="Clear all filters"
            data-testid="tracker-clear-filters"
          >
            <MaterialSymbol icon="filter_alt_off" size={14} />
            Clear
          </button>
        )}

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
          statusScope={statusScope}
          onStatusScopeChange={scope => setModeLayout({ statusScope: scope })}
          viewMode={viewSettings.viewMode}
          groupBy={viewSettings.groupBy}
          ordering={viewSettings.ordering}
          onLayoutChange={handleViewLayoutChange}
        />

        <div className="relative" ref={importMenuRef}>
          <button
            className="inline-flex h-7 items-center gap-1 rounded border border-nim px-2 text-[11px] font-medium text-nim-muted transition-colors hover:bg-nim-tertiary hover:text-nim"
            onClick={() => setImportMenuOpen(!importMenuOpen)}
            title="Import from files"
          >
            <MaterialSymbol icon="upload_file" size={14} />
            Import
          </button>
          {importMenuOpen && (
            <div className="absolute right-0 top-full mt-1 w-[220px] bg-nim border border-nim rounded-md shadow-lg z-50 py-1">
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-nim-muted hover:bg-nim-tertiary hover:text-nim text-left"
                onClick={() => handleBulkImport('nimbalyst-local/plans')}
              >
                <MaterialSymbol icon="folder_open" size={14} />
                Import from nimbalyst-local/plans
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-nim-muted hover:bg-nim-tertiary hover:text-nim text-left"
                onClick={() => handleBulkImport('plans')}
              >
                <MaterialSymbol icon="folder_open" size={14} />
                Import from plans/
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-nim-muted hover:bg-nim-tertiary hover:text-nim text-left"
                onClick={() => handleBulkImport('design')}
              >
                <MaterialSymbol icon="folder_open" size={14} />
                Import from design/
              </button>
              {externalImporters.length > 0 && (
                <div className="my-1 border-t border-nim" />
              )}
              {externalImporters.map((imp) => (
                <button
                  key={imp.id}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-nim-muted hover:bg-nim-tertiary hover:text-nim text-left"
                  onClick={() => {
                    setImportMenuOpen(false);
                    setSourceDialog({
                      providerId: imp.id,
                      providerLabel: imp.displayName,
                      importsAs: imp.importsAs,
                    });
                  }}
                  data-testid={`tracker-import-source-${imp.id}`}
                >
                  <MaterialSymbol icon={imp.icon || 'cloud_download'} size={14} />
                  Import from {imp.displayName}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Import status toast */}
        {importStatus && (
          <span className="text-[11px] text-nim-muted bg-nim-secondary px-2 py-0.5 rounded">
            {importStatus}
          </span>
        )}

        {/* Hide New button for non-creatable types (e.g. automations) */}
        {(() => {
          const targetType = filterType !== 'all' ? filterType : 'task';
          const model = trackerTypes.find(t => t.type === targetType);
          return model?.creatable !== false;
        })() && (
          <button
            className="inline-flex h-7 items-center gap-1 rounded bg-[var(--nim-primary)] px-2.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
            onClick={() => handleNewItem(filterType !== 'all' ? filterType : 'task')}
            data-testid="tracker-toolbar-new-button"
          >
            <MaterialSymbol icon="add" size={14} />
            New
          </button>
        )}
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

      {/* External-source import picker */}
      {sourceDialog && workspacePath && (
        <ImportFromSourceDialog
          providerId={sourceDialog.providerId}
          providerLabel={sourceDialog.providerLabel}
          importsAs={sourceDialog.importsAs}
          workspacePath={workspacePath}
          onClose={() => setSourceDialog(null)}
          onImported={(count) => {
            if (count > 0) {
              setImportStatus(`Imported ${count} item${count === 1 ? '' : 's'}`);
              setTimeout(() => setImportStatus(null), 4000);
            }
          }}
        />
      )}
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
