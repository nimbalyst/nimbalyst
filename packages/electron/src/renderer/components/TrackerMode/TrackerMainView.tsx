import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { FloatingPortal } from '@floating-ui/react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { TrackerIdentity } from '@nimbalyst/runtime';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import {
  filterTrackerRecords,
  getCellValue,
  getDefaultColumnConfig,
  getFieldForColumn,
  resolveColumnsForType,
  TrackerTable,
  TrackerTableGrid,
  SortColumn as TrackerSortColumn,
  SortDirection as TrackerSortDirection,
  type TrackerItemType,
} from '@nimbalyst/runtime/plugins/TrackerPlugin';
import {
  trackerItemsByTypeAtom,
  archivedTrackerItemsAtom,
} from '@nimbalyst/runtime/plugins/TrackerPlugin';
import {
  applyFilterSet,
  hasActiveFilters,
  type TrackerDataModel,
  type TrackerFilterSet,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { KanbanBoard } from './KanbanBoard';
import { TagBoard } from './TagBoard';
import { TrackerGridView } from './TrackerGridView';
import { TrackerInboxView } from './TrackerInboxView';
import { TrackerItemDetail } from './TrackerItemDetail';
import {
  TrackerViewHeaderControls,
  type TrackerFilterField,
} from './TrackerViewHeaderControls';
import { TrackerViewTitle } from './TrackerViewTitle';
import { TrackerActiveFilterPills } from './TrackerActiveFilterPills';
import { TrackerSyncRejectionBanner } from './TrackerSyncRejectionBanner';
import { ImportFromSourceDialog } from './ImportFromSourceDialog';
import {
  trackerModeLayoutAtom,
  setTrackerModeLayoutAtom,
  type TrackerFilterChip,
  type TypeColumnConfig,
} from '../../store/atoms/trackers';
import { activeTeamOrgIdAtom, buildTrackerDeepLink } from '../../store/atoms/collabDocuments';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { useTrackerBodyPrewarm } from '../../hooks/useTrackerBodyPrewarm';
import { setSelectedWorkstreamAtom, sessionRegistryAtom, refreshSessionListAtom, initSessionList } from '../../store/atoms/sessions';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { resolveRoleFieldName } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { workstreamStateAtom } from '../../store/atoms/workstreamState';
import { setWindowModeAtom } from '../../store/atoms/windowMode';
import { defaultAgentModelAtom, worktreesFeatureAvailableAtom } from '../../store/atoms/appSettings';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import { store } from '../../store';
import { useFloatingMenu } from '../../hooks/useFloatingMenu';
import { buildTrackerTagOptions } from './trackerTagFilterUtils';
import { filterTrackerItems, recordSourceKey, type SavedView } from './trackerSavedViews';
import { useTrackerUnread } from '../../hooks/useTrackerUnread';
import {
  createNewWorktreeSessionActionAtom,
  isGitRepoAtom,
} from '../../store/actions/sessionHistoryActions';
import { setTrackerFavoriteAtom } from '../../store/atoms/trackerPersonalState';
import { WorktreeBaseBranchPicker } from '../AgenticCoding/WorktreeBaseBranchPicker';
import {
  buildTrackerLaunchContext,
  type TrackerLaunchContext,
} from './trackerSessionLaunch';

export type ViewMode = 'list' | 'table' | 'grid' | 'kanban' | 'tag-board' | 'inbox';

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
  trackerTypes: TrackerDataModel[];
  onClearSidebarFilters: () => void;
  tagFilter: string[];
  setTagFilter: React.Dispatch<React.SetStateAction<string[]>>;
  sourceFilter: string[];
  setSourceFilter: React.Dispatch<React.SetStateAction<string[]>>;
  currentIdentity: TrackerIdentity | null;
  favoriteItemIds: ReadonlySet<string>;
  viewedAtByItemId: ReadonlyMap<string, number>;
  personalStateHydrated: boolean;
  activeSavedView: SavedView | null;
  savedViewDirty: boolean;
  showSaveViewAction: boolean;
  onSaveView: (name: string) => void;
  onRenameSavedView: (name: string) => void;
  onUpdateSavedView: () => void;
}

export const TrackerMainView: React.FC<TrackerMainViewProps> = ({
  filterType,
  activeFilters,
  viewMode,
  onViewModeChange,
  onSwitchToFilesMode,
  workspacePath,
  trackerTypes,
  onClearSidebarFilters,
  tagFilter,
  setTagFilter,
  sourceFilter,
  setSourceFilter,
  currentIdentity,
  favoriteItemIds,
  viewedAtByItemId,
  personalStateHydrated,
  activeSavedView,
  savedViewDirty,
  showSaveViewAction,
  onSaveView,
  onRenameSavedView,
  onUpdateSavedView,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [quickAddType, setQuickAddType] = useState<string | null>(null);
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const [tagQuery, setTagQuery] = useState('');
  const [highlightedTagIndex, setHighlightedTagIndex] = useState(0);
  const [pendingWorktreeLaunch, setPendingWorktreeLaunch] = useState<TrackerLaunchContext | null>(null);
  const [openFiltersToken, setOpenFiltersToken] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // User's selected default model. Used by handleLaunchSession so the new
  // session uses the workspace's configured provider rather than always
  // falling back to claude-code (which fails for Codex-only installs).
  // See nimbalyst#176.
  const defaultModel = useAtomValue(defaultAgentModelAtom);
  const isWorktreesFeatureAvailable = useAtomValue(worktreesFeatureAvailableAtom);
  const isGitRepo = useAtomValue(isGitRepoAtom(workspacePath || ''));

  useEffect(() => {
    if (!workspacePath) return;
    void initSessionList(workspacePath);
  }, [workspacePath]);

  // Drive the per-item "unread" dots from the local read-receipt store.
  useTrackerUnread(workspacePath, currentIdentity?.email ?? null);

  // Selected item for detail panel
  const modeLayout = useAtomValue(trackerModeLayoutAtom);
  const setModeLayout = useSetAtom(setTrackerModeLayoutAtom);
  const setFavorite = useSetAtom(setTrackerFavoriteAtom);
  const selectedItemId = modeLayout.selectedItemId;
  const inboxScope = modeLayout.inboxScope;
  const detailPanelWidth = modeLayout.detailPanelWidth;
  const sortBy = modeLayout.sortBy as TrackerSortColumn;
  const sortDirection = modeLayout.sortDirection as TrackerSortDirection;

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

  const handleColumnConfigChange = useCallback((config: TypeColumnConfig) => {
    setModeLayout({
      typeColumnConfigs: {
        ...modeLayout.typeColumnConfigs,
        [columnConfigKey]: config,
      },
    });
  }, [setModeLayout, modeLayout.typeColumnConfigs, columnConfigKey]);

  // Per-column filters, persisted per-type alongside the column layout.
  const columnFilters = modeLayout.typeColumnFilters[columnConfigKey] ?? null;

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

  const filterFields = useMemo<TrackerFilterField[]>(() => {
    const roleOrder = new Map<string, number>([
      ['title', 0],
      ['workflowStatus', 1],
      ['priority', 2],
      ['assignee', 3],
      ['reporter', 4],
      ['tags', 5],
      ['progress', 6],
      ['startDate', 7],
      ['dueDate', 8],
    ]);
    const structuralOrder = new Map<string, number>([
      ['type', 20],
      ['key', 21],
      ['updated', 22],
      ['created', 23],
      ['module', 24],
      ['shared', 25],
    ]);
    const orderedColumns = [...availableColumns].sort((left, right) => {
      const leftOrder = left.role
        ? (roleOrder.get(left.role) ?? 15)
        : (structuralOrder.get(left.id) ?? 10);
      const rightOrder = right.role
        ? (roleOrder.get(right.role) ?? 15)
        : (structuralOrder.get(right.id) ?? 10);
      return leftOrder - rightOrder || left.label.localeCompare(right.label);
    });

    return orderedColumns.map(column => {
      const directField = getFieldForColumn(schemaType, column.id);
      const roleFields = column.role
        ? trackerTypes
          .map(model => {
            const roleFieldName = model.roles?.[column.role!];
            return roleFieldName
              ? model.fields.find(field => field.name === roleFieldName)
              : undefined;
          })
          .filter((field): field is NonNullable<typeof field> => field !== undefined)
        : [];
      const representativeField = directField ?? roleFields[0];
      const optionMap = new Map<string, {
        label: string;
        color?: string;
        icon?: string;
      }>();
      for (const field of directField ? [directField] : roleFields) {
        for (const option of field.options ?? []) {
          optionMap.set(option.value, {
            label: option.label,
            color: option.color,
            icon: option.icon,
          });
        }
      }

      if (column.id === 'type') {
        return {
          id: column.id,
          label: column.label,
          type: 'select',
          group: 'system',
          options: trackerTypes.map(model => ({
            value: model.type,
            label: model.displayName,
          })),
        };
      }

      return {
        id: column.id,
        label: column.label,
        group: column.role
          ? 'common'
          : structuralOrder.has(column.id) ? 'system' : 'custom',
        type: representativeField?.type
          ?? (column.render === 'date' ? 'date'
            : column.render === 'tags' ? 'array'
              : optionMap.size > 0 ? 'select' : 'string'),
        options: optionMap.size > 0
          ? Array.from(optionMap, ([value, option]) => ({ value, ...option }))
          : representativeField?.options,
      };
    });
  }, [availableColumns, schemaType, trackerTypes]);

  const getViewFilterValue = useCallback((item: TrackerRecord, field: string): unknown => {
    const role = availableColumns.find(column => column.id === field)?.role;
    const resolvedField = role ? resolveRoleFieldName(item.primaryType, role) : field;
    return getCellValue(item, resolvedField);
  }, [availableColumns]);

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

  // Apply multi-select filters as intersection
  const baseFilteredItems = useMemo(() => {
    const showArchived = activeFilters.includes('archived');
    return filterTrackerItems(
      showArchived ? archivedItems : activeItems,
      { activeFilters, tagFilter: [], recentlyViewedDays: modeLayout.recentlyViewedDays },
      { identity: currentIdentity, favoriteItemIds, viewedAtByItemId },
    );
  }, [activeItems, archivedItems, activeFilters, currentIdentity, favoriteItemIds, viewedAtByItemId, modeLayout.recentlyViewedDays]);

  const allTags = useMemo(() => buildTrackerTagOptions(baseFilteredItems), [baseFilteredItems]);

  const filteredTagOptions = useMemo(() => {
    const activeSet = new Set(tagFilter);
    const query = tagQuery.toLowerCase();
    return allTags
      .filter((tag) => !activeSet.has(tag.name))
      .filter((tag) => !query || tag.name.toLowerCase().includes(query));
  }, [allTags, tagFilter, tagQuery]);

  // Source provenance: 'native' or the importer provider id (from origin).
  const sourceOptions = useMemo(() => {
    const keys = new Set<string>();
    for (const r of baseFilteredItems) keys.add(recordSourceKey(r));
    return Array.from(keys).sort((a, b) => (a === 'native' ? -1 : b === 'native' ? 1 : a.localeCompare(b)));
  }, [baseFilteredItems]);

  // Only worth showing the Source filter once imported items coexist with native ones.
  const showSourceFilter = sourceOptions.some((k) => k !== 'native');

  const filteredItems = useMemo(() => {
    const showArchived = activeFilters.includes('archived');
    return filterTrackerItems(showArchived ? archivedItems : activeItems, {
      activeFilters,
      tagFilter,
      sourceFilter,
      recentlyViewedDays: modeLayout.recentlyViewedDays,
    }, { identity: currentIdentity, favoriteItemIds, viewedAtByItemId });
  }, [activeItems, archivedItems, activeFilters, tagFilter, sourceFilter, modeLayout.recentlyViewedDays, currentIdentity, favoriteItemIds, viewedAtByItemId]);

  const headerFilterFields = useMemo<TrackerFilterField[]>(() => {
    return filterFields.map(field => {
      if (!['user', 'select', 'multiselect', 'array', 'relationship', 'reference'].includes(field.type ?? '')) {
        return field;
      }

      const options = new Map<string, {
        label: string;
        count: number;
        color?: string;
        icon?: string;
      }>();
      for (const option of field.options ?? []) {
        options.set(option.value, {
          label: option.label,
          count: 0,
          color: option.color,
          icon: option.icon,
        });
      }
      const addValue = (value: unknown): void => {
        if (value === undefined || value === null || value === '') return;
        if (Array.isArray(value)) {
          value.forEach(addValue);
          return;
        }
        if (typeof value === 'object') {
          const record = value as Record<string, unknown>;
          const optionValue = record.itemId ?? record.issueKey ?? record.url ?? record.email ?? record.title;
          const label = record.title ?? record.name ?? record.email ?? record.issueKey ?? optionValue;
          if (optionValue !== undefined) {
            const key = String(optionValue);
            const existing = options.get(key);
            options.set(key, {
              label: existing?.label ?? String(label),
              count: (existing?.count ?? 0) + 1,
              color: existing?.color,
              icon: existing?.icon,
            });
          }
          return;
        }
        const key = String(value);
        const existing = options.get(key);
        options.set(key, {
          label: existing?.label ?? key,
          count: (existing?.count ?? 0) + 1,
          color: existing?.color,
          icon: existing?.icon,
        });
      };

      for (const item of filteredItems) addValue(getViewFilterValue(item, field.id));
      return {
        ...field,
        options: (field.options?.length
          ? Array.from(options, ([value, option]) => ({ value, ...option }))
          : Array.from(options, ([value, option]) => ({ value, ...option }))
            .sort((left, right) => left.label.localeCompare(right.label)))
          .slice(0, 100),
      };
    });
  }, [filterFields, filteredItems, getViewFilterValue]);

  const viewFilteredItems = useMemo(() => {
    const searchedItems = filterTrackerRecords(filteredItems, {
      searchTerm: searchQuery,
      typeFilter: 'all',
    });
    return applyFilterSet(
      searchedItems,
      columnFilters,
      getViewFilterValue,
    );
  }, [columnFilters, filteredItems, getViewFilterValue, searchQuery]);

  // Global inbox scope must start from the all-types source. Passing the
  // selected type's already-filtered rows would make "global" silently mean
  // "the current sidebar type".
  const inboxFilteredItems = useMemo(() => {
    if (inboxScope !== 'global') return viewFilteredItems;
    const showArchived = activeFilters.includes('archived');
    const globalItems = filterTrackerItems(showArchived ? allArchivedItems : allActiveItems, {
      activeFilters,
      tagFilter,
      sourceFilter,
      recentlyViewedDays: modeLayout.recentlyViewedDays,
    }, { identity: currentIdentity, favoriteItemIds, viewedAtByItemId });
    return applyFilterSet(
      filterTrackerRecords(globalItems, { searchTerm: searchQuery, typeFilter: 'all' }),
      columnFilters,
      getViewFilterValue,
    );
  }, [
    inboxScope,
    viewFilteredItems,
    activeFilters,
    allArchivedItems,
    allActiveItems,
    tagFilter,
    sourceFilter,
    searchQuery,
    columnFilters,
    getViewFilterValue,
    modeLayout.recentlyViewedDays,
    currentIdentity,
    favoriteItemIds,
    viewedAtByItemId,
  ]);

  const personalStateRequired = activeFilters.includes('favorites') || activeFilters.includes('recently-viewed');
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
    setTagQuery('');
    setShowTagDropdown(false);
    setTagFilter([]);
    setSourceFilter([]);
    handleColumnFiltersChange({ combinator: 'and', clauses: [] });
    onClearSidebarFilters();
  }, [handleColumnFiltersChange, onClearSidebarFilters]);

  const tagMenu = useFloatingMenu({
    placement: 'bottom-start',
    open: showTagDropdown,
    onOpenChange: setShowTagDropdown,
  });

  const setSearchInputNode = useCallback((node: HTMLInputElement | null) => {
    searchInputRef.current = node;
    tagMenu.refs.setReference(node);
  }, [tagMenu.refs]);

  const addTagFilter = useCallback((tag: string) => {
    setTagFilter((current) => current.includes(tag) ? current : [...current, tag]);
    setTagQuery('');
    setShowTagDropdown(false);
    setHighlightedTagIndex(0);
  }, []);

  const removeTagFilter = useCallback((tag: string) => {
    setTagFilter((current) => current.filter((candidate) => candidate !== tag));
  }, []);

  useEffect(() => {
    if (!showTagDropdown) {
      setHighlightedTagIndex(0);
    }
  }, [showTagDropdown]);

  // Pre-warm body Y.Docs for visible team-synced items so detail-open
  // hits a warm WebSocket + Y.Doc state (phase 4a of the tracker sync
  // redesign, D5). Filter to types whose syncMode is not 'local' --
  // local-only items have no DocumentRoom and `resolveCollabConfigForUri`
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
      if (t.sync?.mode && t.sync.mode !== 'local') out.add(t.type);
    }
    return out;
  }, [trackerTypes]);

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
    setModeLayout({ selectedItemId: itemId });
  }, [setModeLayout]);

  const handleCloseDetail = useCallback(() => {
    setModeLayout({ selectedItemId: null });
  }, [setModeLayout]);

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
      await navigator.clipboard.writeText(url);
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
    setQuickAddType(type);
  }, []);

  const handleQuickAddClose = useCallback(() => {
    setQuickAddType(null);
  }, []);

  const handleQuickAddSubmit = useCallback(async (title: string, priority: string) => {
    if (!workspacePath || !quickAddType) return;

    try {
      const tracker = trackerTypes.find(t => t.type === quickAddType);
      if (tracker?.creatable === false) return;
      const prefix = tracker?.idPrefix || quickAddType.substring(0, 3);
      const timestamp = Date.now().toString(36);
      const random = Math.random().toString(36).substring(2, 8);
      const id = `${prefix}_${timestamp}${random}`;

      const statusFieldName = tracker?.roles?.workflowStatus ?? 'status';
      const statusField = tracker?.fields.find(f => f.name === statusFieldName);
      const defaultStatus = (statusField?.default as string) || 'to-do';
      const syncMode = tracker?.sync?.mode || 'local';

      const result = await window.electronAPI.documentService.createTrackerItem({
        id,
        type: quickAddType,
        title,
        status: defaultStatus,
        priority,
        workspace: workspacePath,
        syncMode,
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to create tracker item');
      }

      setQuickAddType(null);
      // Auto-select the newly created item so the detail panel opens for editing
      const createdId = result.item?.id ?? id;
      setModeLayout({ selectedItemId: createdId });
    } catch (error) {
      console.error('[TrackerMainView] Failed to create tracker item:', error);
    }
  }, [workspacePath, quickAddType, trackerTypes, setModeLayout]);

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
  const showColumnControls = viewMode === 'list'
    || viewMode === 'table'
    || viewMode === 'grid';

  return (
    <div className="tracker-main-view flex-1 flex flex-col overflow-hidden min-h-0">
      {/* Sync rejection banner -- key rotation / stale-envelope feedback */}
      <TrackerSyncRejectionBanner workspacePath={workspacePath} />
      {/* Toolbar */}
      <div className="tracker-toolbar flex items-center gap-2 px-3 py-2 border-b border-nim bg-nim shrink-0">
        {/* Title */}
        <TrackerViewTitle
          fallbackTitle={title}
          activeSavedViewName={activeSavedView?.name}
          savedViewDirty={savedViewDirty}
          showSaveViewAction={showSaveViewAction}
          onSaveView={onSaveView}
          onRenameSavedView={onRenameSavedView}
          onUpdateSavedView={onUpdateSavedView}
        />

        {/* Search */}
        <div className="relative flex-1 max-w-[360px] min-w-0">
          <MaterialSymbol
            icon="search"
            size={16}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-nim-faint pointer-events-none"
          />
          <input
            ref={setSearchInputNode}
            type="text"
            placeholder="Search or type # to filter by tag..."
            value={showTagDropdown
              ? (searchQuery ? searchQuery + ' ' : '') + '#' + tagQuery
              : searchQuery}
            onChange={(e) => {
              const value = e.target.value;
              const hashIndex = value.lastIndexOf('#');

              if (hashIndex >= 0) {
                setSearchQuery(value.slice(0, hashIndex).trim());
                setTagQuery(value.slice(hashIndex + 1));
                setShowTagDropdown(true);
                setHighlightedTagIndex(0);
                return;
              }

              setSearchQuery(value);
              setTagQuery('');
              setShowTagDropdown(false);
            }}
            onKeyDown={(e) => {
              if (showTagDropdown) {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setShowTagDropdown(false);
                  setTagQuery('');
                  return;
                }
                if (e.key === 'Backspace' && tagQuery.length === 0) {
                  e.preventDefault();
                  setShowTagDropdown(false);
                  return;
                }
                if (filteredTagOptions.length === 0) {
                  return;
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setHighlightedTagIndex((current) => Math.min(current + 1, filteredTagOptions.length - 1));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setHighlightedTagIndex((current) => Math.max(current - 1, 0));
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  addTagFilter(filteredTagOptions[highlightedTagIndex].name);
                  return;
                }
              }

              if (e.key === 'Backspace' && searchQuery.length === 0 && tagFilter.length > 0) {
                e.preventDefault();
                removeTagFilter(tagFilter[tagFilter.length - 1]);
              }
            }}
            onFocus={() => {
              if (tagQuery) {
                setShowTagDropdown(true);
              }
            }}
            className="w-full pl-7 pr-7 py-1 text-xs bg-nim-secondary border border-nim rounded text-nim placeholder:text-nim-faint focus:outline-none focus:border-[var(--nim-primary)]"
            aria-label="Search trackers or filter by tag"
          />
          {(searchQuery || tagFilter.length > 0 || showTagDropdown) && (
            <button
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-nim-faint hover:text-nim"
              onClick={() => {
                setSearchQuery('');
                setTagQuery('');
                setShowTagDropdown(false);
                setTagFilter([]);
              }}
            >
              <MaterialSymbol icon="close" size={14} />
            </button>
          )}
        </div>

        <TrackerActiveFilterPills
          fields={headerFilterFields}
          filters={columnFilters}
          onManage={() => setOpenFiltersToken(token => token + 1)}
          onRemove={removeFieldFilter}
        />

        {showTagDropdown && (
          <FloatingPortal>
            <div
              ref={tagMenu.refs.setFloating}
              style={{
                ...tagMenu.floatingStyles,
                width: searchInputRef.current?.offsetWidth,
              }}
              className="bg-nim-secondary border border-nim rounded shadow-lg z-[100] overflow-y-auto"
              data-testid="tracker-tag-dropdown"
              {...tagMenu.getFloatingProps()}
            >
              {filteredTagOptions.length > 0 ? (
                filteredTagOptions.slice(0, 15).map((tag, index) => (
                  <button
                    key={tag.name}
                    type="button"
                    className={`w-full text-left px-3 py-1.5 text-[12px] flex items-center justify-between cursor-pointer transition-colors ${
                      index === highlightedTagIndex
                        ? 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)]'
                        : 'text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-tertiary)]'
                    }`}
                    onMouseEnter={() => setHighlightedTagIndex(index)}
                    onClick={() => addTagFilter(tag.name)}
                  >
                    <span>#{tag.name}</span>
                    <span className="text-[var(--nim-text-faint)] text-[11px] tabular-nums">{tag.count}</span>
                  </button>
                ))
              ) : (
                <div className="px-3 py-2 text-[12px] text-[var(--nim-text-faint)] italic">
                  {tagQuery ? 'No matching tags' : 'No tags in these trackers yet'}
                </div>
              )}
            </div>
          </FloatingPortal>
        )}

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

        {/* Source provenance filter (appears once imported items exist) */}
        {showSourceFilter && (
          <div className="flex items-center gap-1 shrink-0" data-testid="tracker-source-filter">
            {sourceOptions.map((key) => {
              const active = sourceFilter.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleSource(key)}
                  className={
                    active
                      ? 'px-2 py-0.5 rounded-full text-[11px] border bg-[var(--nim-primary)]/15 border-[var(--nim-primary)]/40 text-nim'
                      : 'px-2 py-0.5 rounded-full text-[11px] border border-nim text-nim-muted hover:bg-nim-tertiary'
                  }
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

        <TrackerViewHeaderControls
          itemCount={displayedItemCount}
          availableColumns={availableColumns}
          columnConfig={columnConfig}
          onColumnConfigChange={handleColumnConfigChange}
          showColumnControls={showColumnControls}
          filterFields={headerFilterFields}
          filters={columnFilters}
          onFiltersChange={handleColumnFiltersChange}
          openFiltersToken={openFiltersToken}
        />

        <div className="relative" ref={importMenuRef}>
          <button
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-nim-muted border border-nim rounded hover:bg-nim-tertiary hover:text-nim transition-colors"
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
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-white bg-[var(--nim-primary)] rounded hover:opacity-90 transition-opacity"
            onClick={() => handleNewItem(filterType !== 'all' ? filterType : 'task')}
            data-testid="tracker-toolbar-new-button"
          >
            <MaterialSymbol icon="add" size={14} />
            New
          </button>
        )}
      </div>

      {/* Content area: table/kanban + optional detail panel */}
      <div className="flex-1 flex flex-row overflow-hidden min-h-0">
        {/* Table/Kanban (flex-1, shrinks when detail is open) */}
        <div className="flex-1 overflow-hidden min-h-0 min-w-0 relative">
          {personalStateRequired && !personalStateHydrated ? (
            <div className="h-full flex items-center justify-center text-sm text-nim-muted" data-testid="tracker-personal-state-loading">
              Loading personal tracker state...
            </div>
          ) : viewMode === 'list' ? (
            <TrackerTable
              filterType={filterType}
              sortBy={sortBy}
              sortDirection={sortDirection}
              hideTypeTabs={true}
              onSortChange={(column, direction) => {
                setModeLayout({ sortBy: column, sortDirection: direction });
              }}
              preserveItemOrder={recencyOrderActive}
              favoriteItemIds={favoriteItemIds}
              onToggleFavorite={handleToggleFavorite}
              onSwitchToFilesMode={onSwitchToFilesMode}
              onNewItem={handleNewItem}
              onItemSelect={handleItemSelect}
              selectedItemId={selectedItemId}
              overrideItems={viewFilteredItems}
              onArchiveItems={handleArchiveItems}
              onDeleteItems={handleDeleteItems}
              onCopyDeepLink={teamOrgId ? handleCopyDeepLink : undefined}
              searchQuery={searchQuery}
              hasExternalFilters={hasExternalTableFilters}
              onClearFilters={clearTableFilters}
              columnConfig={columnConfig}
              onColumnConfigChange={handleColumnConfigChange}
              hideToolbar
            />
          ) : viewMode === 'table' ? (
            <TrackerTableGrid
              filterType={filterType}
              sortBy={sortBy}
              sortDirection={sortDirection}
              hideTypeTabs={true}
              onSortChange={(column, direction) => {
                setModeLayout({ sortBy: column, sortDirection: direction });
              }}
              preserveItemOrder={recencyOrderActive}
              favoriteItemIds={favoriteItemIds}
              onToggleFavorite={handleToggleFavorite}
              onSwitchToFilesMode={onSwitchToFilesMode}
              onNewItem={handleNewItem}
              onItemSelect={handleItemSelect}
              selectedItemId={selectedItemId}
              overrideItems={viewFilteredItems}
              onArchiveItems={handleArchiveItems}
              onDeleteItems={handleDeleteItems}
              onCopyDeepLink={teamOrgId ? handleCopyDeepLink : undefined}
              searchQuery={searchQuery}
              hasExternalFilters={hasExternalTableFilters}
              onClearFilters={clearTableFilters}
              columnConfig={columnConfig}
              onColumnConfigChange={handleColumnConfigChange}
              hideToolbar
            />
          ) : viewMode === 'grid' ? (
            <TrackerGridView
              filterType={filterType}
              sortBy={sortBy}
              sortDirection={sortDirection}
              preserveItemOrder={recencyOrderActive}
              onSwitchToFilesMode={onSwitchToFilesMode}
              onItemSelect={handleItemSelect}
              onDetailClose={handleCloseDetail}
              selectedItemId={selectedItemId}
              overrideItems={viewFilteredItems}
              onArchiveItems={handleArchiveItems}
              onDeleteItems={handleDeleteItems}
              searchQuery={searchQuery}
              hasExternalFilters={hasExternalTableFilters}
              onClearFilters={clearTableFilters}
              columnConfig={columnConfig}
              onColumnConfigChange={handleColumnConfigChange}
              columnFilters={columnFilters}
              onColumnFiltersChange={handleColumnFiltersChange}
              filterFields={headerFilterFields}
              onSortChange={(column, direction) => {
                setModeLayout({
                  sortBy: column as TrackerSortColumn,
                  sortDirection: direction,
                });
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
          ) : viewMode === 'tag-board' ? (
            <TagBoard
              filterType={filterType}
              searchQuery={searchQuery}
              onItemSelect={handleItemSelect}
              selectedItemId={selectedItemId}
              overrideItems={viewFilteredItems}
              favoriteItemIds={favoriteItemIds}
              onToggleFavorite={handleToggleFavorite}
            />
          ) : (
            <KanbanBoard
              filterType={filterType}
              searchQuery={searchQuery}
              onSwitchToFilesMode={onSwitchToFilesMode}
              onItemSelect={handleItemSelect}
              selectedItemId={selectedItemId}
              overrideItems={viewFilteredItems}
              onArchiveItems={handleArchiveItems}
              onDeleteItems={handleDeleteItems}
              onCopyDeepLink={teamOrgId ? handleCopyDeepLink : undefined}
              favoriteItemIds={favoriteItemIds}
              onToggleFavorite={handleToggleFavorite}
            />
          )}

          {/* Quick Add overlay */}
          {quickAddType && (
            <QuickAddOverlay
              type={quickAddType}
              tracker={trackerTypes.find(t => t.type === quickAddType)}
              onSubmit={handleQuickAddSubmit}
              onClose={handleQuickAddClose}
            />
          )}
        </div>

        {/* Detail panel (right side, shown when item selected) */}
        {selectedItemId && (
          <DetailPanelResizable
            width={detailPanelWidth}
            onWidthChange={(w) => setModeLayout({ detailPanelWidth: w })}
          >
            <TrackerItemDetail
              itemId={selectedItemId}
              workspacePath={workspacePath}
              onClose={handleCloseDetail}
              onSwitchToFilesMode={onSwitchToFilesMode}
              onSwitchToAgentMode={handleSwitchToAgentMode}
              onLaunchSession={handleLaunchSession}
              onLaunchWorktree={isWorktreesFeatureAvailable && isGitRepo ? handleLaunchWorktree : undefined}
              onArchive={handleArchiveItem}
              onDelete={handleDeleteItem}
              onOpenItem={handleItemSelect}
            />
          </DetailPanelResizable>
        )}
      </div>

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
          workspacePath={workspacePath}
          initialName={pendingWorktreeLaunch.worktreeName}
          onCreate={handleCreateTrackerWorktree}
          onCancel={() => setPendingWorktreeLaunch(null)}
        />
      )}
    </div>
  );
};

/**
 * Resizable wrapper for the detail panel (right side).
 * Drag the left edge to resize.
 */
const DetailPanelResizable: React.FC<{
  width: number;
  onWidthChange: (width: number) => void;
  children: React.ReactNode;
}> = ({ width, onWidthChange, children }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [currentWidth, setCurrentWidth] = useState(width);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);
  const MIN_WIDTH = 300;
  const MAX_WIDTH = 1200;

  useEffect(() => { setCurrentWidth(width); }, [width]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    startXRef.current = e.clientX;
    startWidthRef.current = currentWidth;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, [currentWidth]);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      // Dragging left increases width, dragging right decreases
      const deltaX = startXRef.current - e.clientX;
      const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidthRef.current + deltaX));
      setCurrentWidth(newWidth);
    };
    const handleMouseUp = () => {
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      onWidthChange(currentWidth);
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, currentWidth, onWidthChange]);

  return (
    <div className="flex shrink-0" style={{ width: `${currentWidth}px` }}>
      <div
        className={`relative w-0.5 cursor-ew-resize bg-nim-border shrink-0 transition-colors duration-150 hover:bg-nim-accent ${isDragging ? 'bg-nim-accent' : ''}`}
        onMouseDown={handleMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize detail panel"
      />
      <div className="flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  );
};

/**
 * Quick Add overlay (same pattern as TrackerBottomPanel's QuickAddInline)
 */
interface QuickAddOverlayProps {
  type: string;
  tracker?: TrackerDataModel;
  onSubmit: (title: string, priority: string) => void;
  onClose: () => void;
}

const QuickAddOverlay: React.FC<QuickAddOverlayProps> = ({ type, tracker, onSubmit, onClose }) => {
  const [title, setTitle] = React.useState('');
  const [priority, setPriority] = React.useState('medium');
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (title.trim()) {
      onSubmit(title.trim(), priority);
    }
  };

  const color = tracker?.color || '#6b7280';
  const displayName = tracker?.displayName || type.charAt(0).toUpperCase() + type.slice(1);
  const icon = tracker?.icon || 'label';

  return (
    <div className="absolute top-0 left-0 right-0 bg-nim-secondary border-b border-nim shadow-sm z-20">
      <form onSubmit={handleSubmit} className="flex items-center gap-3 px-4 py-2">
        <span className="material-symbols-outlined text-lg shrink-0" style={{ color }}>
          {icon}
        </span>

        <input
          ref={inputRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            // Prevent global keyboard shortcuts from intercepting while typing
            e.stopPropagation();
          }}
          placeholder={`New ${displayName.toLowerCase()}...`}
          className="flex-1 min-w-0 px-3 py-1.5 bg-nim border border-nim rounded text-sm text-nim placeholder:text-nim-faint focus:outline-none focus:border-[var(--nim-primary)]"
          data-testid="tracker-quick-add-input"
        />

        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          className="px-2 py-1.5 bg-nim border border-nim rounded text-sm text-nim focus:outline-none focus:border-[var(--nim-primary)] shrink-0"
        >
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>

        <button
          type="submit"
          disabled={!title.trim()}
          className="px-3 py-1.5 rounded text-sm font-medium text-white border-none cursor-pointer transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 shrink-0"
          style={{ backgroundColor: color }}
        >
          Add
        </button>

        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-nim-tertiary text-nim-muted shrink-0"
          title="Cancel (Esc)"
        >
          <MaterialSymbol icon="close" size={18} />
        </button>
      </form>
    </div>
  );
};
