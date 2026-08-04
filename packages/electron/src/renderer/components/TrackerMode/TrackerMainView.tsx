import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { copyToClipboard, MaterialSymbol } from '@nimbalyst/runtime';
import type { TrackerIdentity } from '@nimbalyst/runtime';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import {
  filterTrackerRecords,
  getCellValue,
  getDefaultColumnConfig,
  getFieldForColumn,
  resolveColumnsForType,
  TrackerTable,
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
  type TrackerFilterEvaluationContext,
  type TrackerFilterSet,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { KanbanBoard } from './KanbanBoard';
import { TagBoard } from './TagBoard';
import { TrackerGridView } from './TrackerGridView';
import { TrackerInboxView } from './TrackerInboxView';
import {
  TrackerItemDetail,
  type TrackerContentMode,
} from './TrackerItemDetail';
import {
  TrackerViewHeaderControls,
  type TrackerFilterField,
} from './TrackerViewHeaderControls';
import { TrackerViewTitle } from './TrackerViewTitle';
import { TrackerActiveFilterPills } from './TrackerActiveFilterPills';
import { TrackerFilterOmnibox } from './TrackerFilterOmnibox';
import { TrackerSyncRejectionBanner } from './TrackerSyncRejectionBanner';
import { ImportFromSourceDialog } from './ImportFromSourceDialog';
import { TrackerDocumentView } from './TrackerDocumentView';
import {
  trackerModeLayoutAtom,
  setTrackerModeLayoutAtom,
  setTrackerDocumentChatSessionAtom,
  setTrackerItemViewAtom,
  trackerModeDocumentItemIdAtom,
  openTrackerItemAsDocumentAtom,
  type TrackerFilterChip,
  type TypeColumnConfig,
} from '../../store/atoms/trackers';
import { activeTeamOrgIdAtom, buildTrackerDeepLink, buildTrackerDocumentDeepLink } from '../../store/atoms/collabDocuments';
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
import { buildTrackerTagOptions } from './trackerTagFilterUtils';
import {
  filterTrackerItems,
  getTrackerFilterValue,
  normalizeTrackerGroupBy,
  recordSourceKey,
  STATUS_CHANGED_FROM_FILTER_FIELD,
  STATUS_CHANGED_TO_FILTER_FIELD,
  type SavedView,
} from './trackerSavedViews';
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
import { trackTeamAnalyticsEvent } from '../../utils/teamAnalytics';

export type ViewMode = 'list' | 'table' | 'kanban' | 'tag-board' | 'inbox';

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
  onExitSavedView: () => void;
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
  const detailPanelWidth = modeLayout.detailPanelWidth;
  const sortBy = modeLayout.sortBy as TrackerSortColumn;
  const sortDirection = modeLayout.sortDirection as TrackerSortDirection;

  // Column config for the current type (persisted per-type)
  const columnConfigKey = filterType === 'all' ? 'all' : filterType;
  const columnConfig = useMemo(() => {
    const persisted = modeLayout.typeColumnConfigs[columnConfigKey];
    // If persisted config is missing or has too few columns (stale), use fresh defaults
    if (!persisted || persisted.visibleColumns.length < 3) {
      const defaults = getDefaultColumnConfig(columnConfigKey === 'all' ? '' : columnConfigKey);
      return modeLayout.groupBy === 'none'
        ? defaults
        : { ...defaults, groupBy: modeLayout.groupBy };
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
  }, [modeLayout.groupBy, modeLayout.typeColumnConfigs, columnConfigKey]);

  // The document view's left pane is a few hundred pixels wide, so it drops the
  // badge columns and keeps grouping -- the title (plus its unread/favorite
  // affordances) is all that fits.
  const slimColumnConfig = useMemo<TypeColumnConfig>(() => ({
    visibleColumns: ['title'],
    columnWidths: {},
    groupBy: columnConfig.groupBy,
  }), [columnConfig.groupBy]);

  const handleColumnConfigChange = useCallback((config: TypeColumnConfig) => {
    setModeLayout({
      groupBy: normalizeTrackerGroupBy(config.groupBy),
      typeColumnConfigs: {
        ...modeLayout.typeColumnConfigs,
        [columnConfigKey]: config,
      },
    });
  }, [setModeLayout, modeLayout.typeColumnConfigs, columnConfigKey]);

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
    nowMs: filterClockMs,
  }), [currentIdentity, favoriteItemIds, filterClockMs, viewedAtByItemId]);
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
      ['viewed', 23],
      ['created', 24],
      ['createdBy', 25],
      ['updatedBy', 26],
      ['module', 27],
      ['shared', 28],
      ['favorite', 29],
      ['archived', 30],
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

    const fields: TrackerFilterField[] = orderedColumns.map(column => {
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
              : column.render === 'avatar' ? 'user'
              : optionMap.size > 0 ? 'select' : 'string'),
        multiValue: representativeField?.multiValue,
        options: optionMap.size > 0
          ? Array.from(optionMap, ([value, option]) => ({ value, ...option }))
          : representativeField?.options,
      };
    });
    if (!fields.some(field => field.id === 'owner' || availableColumns.some(
      column => column.id === field.id && column.role === 'assignee',
    ))) {
      fields.splice(Math.min(3, fields.length), 0, {
        id: 'owner',
        label: 'Owner',
        type: 'user',
        group: 'common',
      });
    }
    if (!fields.some(field => field.id === 'favorite')) {
      // The id stays `favorite` -- saved views and typed `favorite:` tokens
      // persist it -- while the label matches the star people actually click.
      fields.push({
        id: 'favorite',
        label: 'Starred',
        type: 'boolean',
        group: 'system',
        options: [
          { value: 'true', label: 'Yes' },
          { value: 'false', label: 'No' },
        ],
      });
    }
    if (!fields.some(field => field.id === 'archived')) {
      fields.push({ id: 'archived', label: 'Archived', type: 'boolean', group: 'system' });
    }
    const statusOptions = new Map<string, {
      value: string;
      label: string;
      color?: string;
      icon?: string;
    }>();
    for (const model of trackerTypes) {
      const statusFieldName = model.roles?.workflowStatus;
      const statusField = statusFieldName
        ? model.fields.find(field => field.name === statusFieldName)
        : undefined;
      for (const option of statusField?.options ?? []) {
        statusOptions.set(option.value, {
          value: option.value,
          label: option.label,
          color: option.color,
          icon: option.icon,
        });
      }
    }
    const transitionFields: TrackerFilterField[] = [
      {
        id: STATUS_CHANGED_TO_FILTER_FIELD,
        label: 'Status changed to',
        type: 'select',
        group: 'common',
        options: Array.from(statusOptions.values()),
      },
      {
        id: STATUS_CHANGED_FROM_FILTER_FIELD,
        label: 'Status changed from',
        type: 'select',
        group: 'common',
        options: Array.from(statusOptions.values()),
      },
    ];
    const statusIndex = fields.findIndex(field => availableColumns.some(
      column => column.id === field.id && column.role === 'workflowStatus',
    ));
    fields.splice(statusIndex >= 0 ? statusIndex + 1 : Math.min(1, fields.length), 0, ...transitionFields);
    return fields;
  }, [availableColumns, schemaType, trackerTypes]);

  const getViewFilterValue = useCallback((item: TrackerRecord, field: string): unknown => {
    const role = availableColumns.find(column => column.id === field)?.role;
    if (role) {
      const resolvedField = resolveRoleFieldName(item.primaryType, role);
      return getCellValue(item, resolvedField);
    }
    return getTrackerFilterValue(item, field, filterContext);
  }, [availableColumns, filterContext]);

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
    const filtersArchived = (columnFilters?.clauses ?? []).some(clause => clause.field === 'archived');
    const sourceItems = showArchived
      ? archivedItems
      : filtersArchived ? [...activeItems, ...archivedItems] : activeItems;
    return filterTrackerItems(
      sourceItems,
      { activeFilters, tagFilter: [], recentlyViewedDays: modeLayout.recentlyViewedDays },
      filterContext,
    );
  }, [activeFilters, activeItems, archivedItems, columnFilters, filterContext, modeLayout.recentlyViewedDays]);

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
    const showArchived = activeFilters.includes('archived');
    const filtersArchived = (columnFilters?.clauses ?? []).some(clause => clause.field === 'archived');
    const sourceItems = showArchived
      ? archivedItems
      : filtersArchived ? [...activeItems, ...archivedItems] : activeItems;
    return filterTrackerItems(sourceItems, {
      activeFilters,
      tagFilter,
      sourceFilter,
      recentlyViewedDays: modeLayout.recentlyViewedDays,
    }, filterContext);
  }, [
    activeFilters,
    activeItems,
    archivedItems,
    columnFilters,
    filterContext,
    modeLayout.recentlyViewedDays,
    sourceFilter,
    tagFilter,
  ]);

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
          const optionValue = record.itemId ?? record.issueKey ?? record.url
            ?? record.email ?? record.gitEmail ?? record.gitName ?? record.displayName ?? record.title;
          const label = record.title ?? record.name ?? record.displayName
            ?? record.email ?? record.gitEmail ?? record.gitName ?? record.issueKey ?? optionValue;
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
      filterEvaluationContext,
    );
  }, [columnFilters, filterEvaluationContext, filteredItems, getViewFilterValue, searchQuery]);

  // Global inbox scope must start from the all-types source. Passing the
  // selected type's already-filtered rows would make "global" silently mean
  // "the current sidebar type".
  const inboxFilteredItems = useMemo(() => {
    if (inboxScope !== 'global') return viewFilteredItems;
    const showArchived = activeFilters.includes('archived');
    const filtersArchived = (columnFilters?.clauses ?? []).some(clause => clause.field === 'archived');
    const sourceItems = showArchived
      ? allArchivedItems
      : filtersArchived ? [...allActiveItems, ...allArchivedItems] : allActiveItems;
    const globalItems = filterTrackerItems(sourceItems, {
      activeFilters,
      tagFilter,
      sourceFilter,
      recentlyViewedDays: modeLayout.recentlyViewedDays,
    }, filterContext);
    return applyFilterSet(
      filterTrackerRecords(globalItems, { searchTerm: searchQuery, typeFilter: 'all' }),
      columnFilters,
      getViewFilterValue,
      filterEvaluationContext,
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
    filterContext,
    filterEvaluationContext,
    getViewFilterValue,
    modeLayout.recentlyViewedDays,
  ]);

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

  const viewItemsWithPersonalFields = useMemo(() => viewFilteredItems.map(item => ({
    ...item,
    fields: {
      ...item.fields,
      viewed: viewedAtByItemId.has(item.id)
        ? new Date(viewedAtByItemId.get(item.id)!)
        : undefined,
    },
  })), [viewFilteredItems, viewedAtByItemId]);

  const removeTagFilter = useCallback((tag: string) => {
    setTagFilter((current) => current.filter((candidate) => candidate !== tag));
  }, []);

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
      onLaunchWorktree={isWorktreesFeatureAvailable && isGitRepo ? handleLaunchWorktree : undefined}
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
      hideTypeTabs
      hideToolbar
      preserveItemOrder={recencyOrderActive}
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
              hideTypeTabs={true}
              onSortChange={(column, direction) => {
                trackTableSort();
                setModeLayout({ sortBy: column, sortDirection: direction });
              }}
              preserveItemOrder={recencyOrderActive}
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
              preserveItemOrder={recencyOrderActive}
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
              onOpenDocument={handleOpenItemAsDocument}
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
              onOpenDocument={handleOpenItemAsDocument}
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
          workspacePath={workspacePath}
          initialName={pendingWorktreeLaunch.worktreeName}
          onCreate={handleCreateTrackerWorktree}
          onCancel={() => setPendingWorktreeLaunch(null)}
        />
      )}
    </>
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
