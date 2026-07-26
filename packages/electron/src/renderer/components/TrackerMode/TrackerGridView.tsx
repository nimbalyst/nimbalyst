/**
 * TrackerGridView -- the editable, virtualized tracker table (`table` view mode).
 *
 * Built on RevoGrid so rows are virtualized and any schema-backed cell can be
 * edited in place, with the editor chosen by the field's type.
 *
 * Every commit routes through `useTrackerRows.handleItemUpdate`, so a cell edit
 * is an ordinary single-field tracker write and inherits sync, inverse-edge
 * propagation, and the document-backed vs native write split. Right-click
 * actions reuse the same `useTrackerRows` selection/bulk handlers as the list
 * view, so both surfaces offer identical bulk operations.
 */

import type { JSX, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RevoGrid, type RevoGridCustomEvent } from '@revolist/react-datagrid';
import type {
  AfterEditEvent,
  BeforeSaveDataDetails,
  ColumnRegular,
  FocusAfterRenderEvent,
  SortingConfig,
} from '@revolist/revogrid';
import { useAtomValue } from 'jotai';
import type { TrackerItemType } from '@nimbalyst/runtime/core/DocumentService';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import {
  useTrackerRows,
  resolveColumnsForType,
  getDefaultColumnConfig,
  getFieldForColumn,
  getCellValue,
  coerceCellValue,
  withEffectiveUpdated,
  filterTrackerRecords,
  getTrackerGroupLabel,
  getTypeColor,
  sortTrackerRecords,
  globalRegistry,
  TrackerRowContextMenu,
  type TrackerColumnDef,
  type TypeColumnConfig,
} from '@nimbalyst/runtime/plugins/TrackerPlugin';
import { isCollectionType } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerCollections';
import {
  trackerItemsByTypeAtom,
  trackerDataLoadedAtom,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import {
  getRecordTitle,
  resolveRoleFieldName,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import {
  applyFilterSet,
  isClauseComplete,
  withFieldClauses,
  clausesForField,
  hasActiveFilters,
  type TrackerFilterEvaluationContext,
  type TrackerFieldFilter,
  type TrackerFilterSet,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { buildGridColumns, buildGridSource, ROW_ITEM_ID } from './grid/trackerGridColumns';
import type { RelationshipCandidate } from './grid/trackerGridEditors';
import {
  TrackerFilterValueMenu,
} from './TrackerFilterValueMenu';
import type { TrackerFilterField } from './TrackerViewHeaderControls';
import './grid/trackerGrid.css';

const ROW_GROUP_LABEL = '__trackerGroupLabel';

interface BeforeSortingDetail {
  column: ColumnRegular;
  order: 'asc' | 'desc';
  additive: boolean;
}

interface TrackerGridViewProps {
  filterType?: TrackerItemType | 'all';
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
  onItemSelect?: (itemId: string) => void;
  onDetailClose?: () => void;
  selectedItemId?: string | null;
  overrideItems?: TrackerRecord[];
  onDeleteItems?: (itemIds: string[]) => void;
  onArchiveItems?: (itemIds: string[], archive: boolean) => void;
  onSwitchToFilesMode?: () => void;
  searchQuery?: string;
  hasExternalFilters?: boolean;
  onClearFilters?: () => void;
  columnConfig?: TypeColumnConfig;
  onColumnConfigChange?: (config: TypeColumnConfig) => void;
  /** Per-column filter set in the shared filter language. */
  columnFilters?: TrackerFilterSet | null;
  onColumnFiltersChange?: (filters: TrackerFilterSet) => void;
  filterFields?: TrackerFilterField[];
  filterEvaluationContext?: TrackerFilterEvaluationContext;
  onSortChange?: (column: string, direction: 'asc' | 'desc') => void;
  preserveItemOrder?: boolean;
  /** Create a new item of the active type from the empty state. */
  onNewItem?: (type: TrackerItemType) => void;
  /** Copy a shareable deep link (team workspaces only). */
  onCopyDeepLink?: (itemId: string) => void;
  favoriteItemIds?: ReadonlySet<string>;
  onToggleFavorite?: (itemId: string) => void;
}

/** A range edit (paste / fill-down) arrives as `{ data: { rowIndex: { prop: value } } }`. */
function isRangeEdit(detail: AfterEditEvent): detail is Extract<AfterEditEvent, { data: unknown }> {
  return 'data' in detail && detail.data != null;
}

export function TrackerGridView({
  filterType = 'all',
  sortBy = 'lastIndexed',
  sortDirection = 'desc',
  onItemSelect,
  onDetailClose,
  selectedItemId,
  overrideItems,
  onDeleteItems,
  onArchiveItems,
  onSwitchToFilesMode,
  searchQuery,
  hasExternalFilters = false,
  onClearFilters,
  columnConfig,
  onColumnConfigChange,
  columnFilters,
  onColumnFiltersChange,
  filterFields = [],
  filterEvaluationContext,
  onSortChange,
  preserveItemOrder = false,
  onNewItem,
  onCopyDeepLink,
  favoriteItemIds,
  onToggleFavorite,
}: TrackerGridViewProps): JSX.Element {
  const [filterTarget, setFilterTarget] = useState<{ columnId: string; rect: DOMRect } | null>(null);
  const activeTypeFilter = filterType;
  const schemaType = activeTypeFilter === 'all' ? '' : activeTypeFilter;

  const atomItems = useAtomValue(trackerItemsByTypeAtom(activeTypeFilter));
  const dataLoaded = useAtomValue(trackerDataLoadedAtom);
  const sourceItems = overrideItems ?? atomItems;

  // Collections live outside the active type filter (you add bugs to a
  // milestone), so the "Add to Collection" menu reads from the all-types atom.
  const allTypeItems = useAtomValue(trackerItemsByTypeAtom('all'));
  const collectionTargets = useMemo(
    () => allTypeItems
      .filter((item: TrackerRecord) => !item.archived && isCollectionType(item.primaryType))
      .slice(0, 50),
    [allTypeItems],
  );

  const items = useMemo(() => withEffectiveUpdated(sourceItems), [sourceItems]);
  const searchTerm = searchQuery ?? '';

  const chipFilteredItems = useMemo(
    () => filterTrackerRecords(items, { searchTerm, typeFilter: activeTypeFilter }),
    [items, searchTerm, activeTypeFilter],
  );

  const allColumnDefs = useMemo(
    () => resolveColumnsForType(schemaType),
    [schemaType],
  );

  const getGridFilterValue = useCallback((item: TrackerRecord, field: string): unknown => {
    const role = allColumnDefs.find(column => column.id === field)?.role;
    const resolvedField = role ? resolveRoleFieldName(item.primaryType, role) : field;
    return getCellValue(item, resolvedField);
  }, [allColumnDefs]);

  // Column filters apply on top of the coarse chips/search, in the shared
  // `{field, op, value}` language that saved views and agent queries also use.
  const filteredItems = useMemo(
    () => overrideItems
      ? chipFilteredItems
      : applyFilterSet(
        chipFilteredItems,
        columnFilters,
        getGridFilterValue,
        filterEvaluationContext,
      ),
    [chipFilteredItems, columnFilters, filterEvaluationContext, getGridFilterValue, overrideItems],
  );

  const filteredColumnIds = useMemo(
    () => new Set((columnFilters?.clauses ?? []).filter(isClauseComplete).map(c => c.field)),
    [columnFilters],
  );

  const handleApplyColumnFilter = useCallback((
    columnId: string,
    clauses: TrackerFieldFilter[],
    combinator: 'and' | 'or',
  ) => {
    onColumnFiltersChange?.({
      ...withFieldClauses(columnFilters, columnId, clauses),
      combinator,
    });
  }, [columnFilters, onColumnFiltersChange]);

  const sortedItems = useMemo(() => {
    if (preserveItemOrder) return filteredItems;
    return sortTrackerRecords(filteredItems, sortBy, sortDirection);
  }, [filteredItems, sortBy, sortDirection, preserveItemOrder]);

  const rows = useTrackerRows({
    items: sortedItems,
    activeTypeFilter,
    onItemSelect,
    onDeleteItems,
    onArchiveItems,
    onSwitchToFilesMode,
  });
  const {
    handleItemUpdate,
    isItemEditable,
    selectedIds,
    setSelectedIds,
    contextAnchor,
    contextRefs,
    contextFloatingStyles,
    openContextMenuForIds,
    closeContextMenu,
    handleBulkStatusUpdate,
    handleBulkPriorityUpdate,
    handleAddSelectionToCollection,
    statusOptionsForBulk,
  } = rows;
  const gridRef = useRef<HTMLRevoGridElement | null>(null);
  const gridCanvasRef = useRef<HTMLDivElement | null>(null);
  const focusOriginRef = useRef<'keyboard' | null>(null);

  // Row index -> record, kept in a ref so the edit handler never reads a stale
  // list after a re-render triggered by the write it just made.
  const sortedItemsRef = useRef<TrackerRecord[]>(sortedItems);
  sortedItemsRef.current = sortedItems;

  const itemsById = useMemo(() => {
    const map = new Map<string, TrackerRecord>();
    for (const item of sortedItems) map.set(item.id, item);
    return map;
  }, [sortedItems]);

  const isRowEditable = useCallback((itemId: string): boolean => {
    const item = itemsById.get(itemId);
    return item ? isItemEditable(item) : false;
  }, [itemsById, isItemEditable]);

  // Relationship editors pick from the loaded records rather than issuing a
  // lookup per cell -- the tracker atoms already hold every item in scope.
  const relationshipCandidates = useCallback((): RelationshipCandidate[] => {
    return items.map(item => ({
      itemId: item.id,
      issueKey: item.issueKey,
      title: getRecordTitle(item),
      trackerType: item.primaryType,
    }));
  }, [items]);

  const effectiveColumnConfig = useMemo(
    () => columnConfig ?? getDefaultColumnConfig(schemaType),
    [columnConfig, schemaType],
  );

  const visibleColumnDefs = useMemo(() => {
    return effectiveColumnConfig.visibleColumns
      .map(id => allColumnDefs.find(c => c.id === id))
      .filter((c): c is TrackerColumnDef => c !== undefined);
  }, [effectiveColumnConfig.visibleColumns, allColumnDefs]);

  const sortingEnabled = Boolean(onSortChange);
  const favorites = useMemo(
    () => (onToggleFavorite
      ? { favoriteItemIds: favoriteItemIds ?? new Set<string>(), onToggleFavorite }
      : undefined),
    [favoriteItemIds, onToggleFavorite],
  );
  const gridColumns = useMemo(
    () => buildGridColumns(visibleColumnDefs, {
      trackerType: schemaType,
      columnWidths: effectiveColumnConfig.columnWidths,
      isRowEditable,
      editorContext: { relationshipCandidates },
      filteredColumnIds,
      onOpenFilter: onColumnFiltersChange
        ? (columnId, rect) => setFilterTarget({ columnId, rect })
        : undefined,
      sortingEnabled,
      favorites,
    }),
    [
      visibleColumnDefs, schemaType, effectiveColumnConfig.columnWidths,
      isRowEditable, relationshipCandidates, filteredColumnIds, onColumnFiltersChange,
      sortingEnabled, favorites,
    ],
  );
  const gridSorting = useMemo<SortingConfig | undefined>(() => {
    if (
      !sortingEnabled
      || !visibleColumnDefs.some(column => column.id === sortBy)
    ) {
      return undefined;
    }
    return {
      columns: [{ prop: sortBy, order: sortDirection }],
    };
  }, [sortBy, sortDirection, sortingEnabled, visibleColumnDefs]);
  const gridRenderKey = `${schemaType}:${sortBy}:${sortDirection}`;

  const gridSource = useMemo(
    () => buildGridSource(sortedItems, visibleColumnDefs).map((row, index) => ({
      ...row,
      [ROW_GROUP_LABEL]: getTrackerGroupLabel(
        sortedItems[index],
        effectiveColumnConfig.groupBy,
      ),
    })),
    [effectiveColumnConfig.groupBy, sortedItems, visibleColumnDefs],
  );
  const gridGrouping = useMemo(
    () => effectiveColumnConfig.groupBy
      ? { props: [ROW_GROUP_LABEL], expandedAll: true }
      : undefined,
    [effectiveColumnConfig.groupBy],
  );

  const resolveGridRowItem = useCallback(async (rowIndex: number): Promise<TrackerRecord | null> => {
    const grid = gridRef.current;
    if (grid && typeof grid.getVisibleSource === 'function') {
      try {
        const visibleSource = await grid.getVisibleSource('rgRow');
        if (Array.isArray(visibleSource) && rowIndex < visibleSource.length) {
          const itemId = visibleSource[rowIndex]?.[ROW_ITEM_ID];
          return typeof itemId === 'string' ? (itemsById.get(itemId) ?? null) : null;
        }
      } catch {
        // The element may still be upgrading; the ungrouped source index is a safe fallback.
      }
    }
    return sortedItemsRef.current[rowIndex] ?? null;
  }, [itemsById]);

  /**
   * Right-click over a row. RevoGrid owns the selection model, so the menu
   * targets the highlighted cell range when the click lands inside it and the
   * single clicked row otherwise -- the same rule the list view applies to its
   * own multi-select.
   */
  const handleGridContextMenu = useCallback(async (
    event: ReactMouseEvent<HTMLDivElement>,
  ): Promise<void> => {
    const cell = (event.target as HTMLElement | null)?.closest?.('[data-rgrow]');
    const rowAttr = cell?.getAttribute('data-rgrow');
    if (rowAttr == null) return;
    const rowIndex = Number(rowAttr);
    if (!Number.isFinite(rowIndex)) return;

    event.preventDefault();
    const point = { x: event.clientX, y: event.clientY };

    const range = await gridRef.current?.getSelectedRange?.();
    const inRange = range
      && typeof range.y === 'number'
      && typeof range.y1 === 'number'
      && rowIndex >= Math.min(range.y, range.y1)
      && rowIndex <= Math.max(range.y, range.y1);

    const rowIndexes = inRange && range
      ? Array.from(
        { length: Math.abs(range.y1 - range.y) + 1 },
        (_, offset) => Math.min(range.y, range.y1) + offset,
      )
      : [rowIndex];

    const resolved = await Promise.all(rowIndexes.map(index => resolveGridRowItem(index)));
    const itemIds = resolved.filter((item): item is TrackerRecord => item !== null).map(item => item.id);
    if (itemIds.length === 0) return;
    openContextMenuForIds(itemIds, point);
  }, [openContextMenuForIds, resolveGridRowItem]);

  const handleColumnResize = useCallback((
    event: RevoGridCustomEvent<{ [index: number]: ColumnRegular }>,
  ) => {
    if (!onColumnConfigChange) return;
    const columnWidths = { ...effectiveColumnConfig.columnWidths };
    for (const column of Object.values(event.detail)) {
      if (typeof column.prop === 'string' && typeof column.size === 'number') {
        columnWidths[column.prop] = column.size;
      }
    }
    onColumnConfigChange({ ...effectiveColumnConfig, columnWidths });
  }, [effectiveColumnConfig, onColumnConfigChange]);

  /** Commit one or more cells from the same row as one durable item update. */
  const commitRow = useCallback(async (
    rowIndex: number,
    changes: Record<string, unknown>,
  ): Promise<void> => {
    const item = await resolveGridRowItem(rowIndex);
    if (!item || !isItemEditable(item)) return;

    const updates: Record<string, unknown> = {};
    for (const [prop, rawValue] of Object.entries(changes)) {
      const column = visibleColumnDefs.find(c => c.id === prop);
      if (!column?.editable) continue;
      const fieldName = column.role
        ? resolveRoleFieldName(item.primaryType, column.role)
        : prop;
      const field = getFieldForColumn(item.primaryType, fieldName);
      if (!field || field.readOnly) continue;
      const value = coerceCellValue(field, rawValue);
      const current = item.fields[fieldName];
      if (JSON.stringify(current ?? null) !== JSON.stringify(value ?? null)) {
        updates[fieldName] = value;
      }
    }
    if (Object.keys(updates).length > 0) {
      await handleItemUpdate(item, updates);
    }
  }, [handleItemUpdate, isItemEditable, resolveGridRowItem, visibleColumnDefs]);

  const handleAfterEdit = useCallback((event: RevoGridCustomEvent<AfterEditEvent>) => {
    const detail = event.detail;

    if (isRangeEdit(detail)) {
      // Paste / fill-down: one write per touched row, so two cells in the same
      // JSON-backed item cannot race and overwrite each other.
      const writes: Array<Promise<void>> = [];
      for (const [rowKey, changes] of Object.entries(detail.data ?? {})) {
        writes.push(commitRow(Number(rowKey), changes as Record<string, unknown>));
      }
      void Promise.all(writes);
      return;
    }

    const single = detail as BeforeSaveDataDetails;
    void commitRow(single.rowIndex, { [String(single.prop)]: single.val });
  }, [commitRow]);

  const openFocusedItem = useCallback(async (): Promise<void> => {
    const focused = await gridRef.current?.getFocused();
    const rowIndex = focused?.cell.y;
    if (typeof rowIndex !== 'number') return;
    const item = await resolveGridRowItem(rowIndex);
    if (item && onItemSelect) onItemSelect(item.id);
  }, [onItemSelect, resolveGridRowItem]);

  const editFocusedCell = useCallback(async (): Promise<void> => {
    const grid = gridRef.current;
    const focused = await grid?.getFocused();
    const prop = focused?.column?.prop;
    if (!grid || !focused || prop == null) return;
    await grid.setCellEdit(focused.cell.y, prop, focused.rowType);
  }, []);

  const handleGridKeyDownCapture = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const key = event.key;
    const path = event.nativeEvent.composedPath();
    const isEditing = path.some(target =>
      target instanceof HTMLElement
      && (
        target.classList.contains('tracker-grid-editor-input')
        || target.classList.contains('tracker-grid-editor-select')
        || target.classList.contains('tracker-grid-editor-checkbox')
      ));

    // RevoGrid owns editor keystrokes. Remember the keyboard origin so the
    // focus change after Enter/Tab does not accidentally open the detail panel.
    if (isEditing) {
      if (key === 'Enter' || key === 'Tab') focusOriginRef.current = 'keyboard';
      return;
    }

    if (
      key === 'ArrowUp'
      || key === 'ArrowDown'
      || key === 'ArrowLeft'
      || key === 'ArrowRight'
      || key === 'Tab'
    ) {
      focusOriginRef.current = 'keyboard';
      return;
    }

    if (key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void openFocusedItem();
      return;
    }

    if (key === 'F2') {
      event.preventDefault();
      event.stopPropagation();
      void editFocusedCell();
      return;
    }

    if (key === 'Escape' && selectedItemId && onDetailClose) {
      event.preventDefault();
      event.stopPropagation();
      onDetailClose();
    }
  }, [editFocusedCell, onDetailClose, openFocusedItem, selectedItemId]);

  const handleCellFocus = useCallback((
    event: RevoGridCustomEvent<FocusAfterRenderEvent>,
  ) => {
    const rowIndex = event.detail?.rowIndex;
    const keyboardFocused = focusOriginRef.current === 'keyboard';
    focusOriginRef.current = null;
    if (typeof rowIndex !== 'number') return;
    // A mouse focus opens details as before. Keyboard focus only changes the
    // row while browsing; once details are open, it keeps the panel in sync.
    if (onItemSelect && (!keyboardFocused || selectedItemId)) {
      if (!effectiveColumnConfig.groupBy) {
        const item = sortedItemsRef.current[rowIndex];
        if (item) onItemSelect(item.id);
        return;
      }
      void resolveGridRowItem(rowIndex).then(item => {
        if (item) onItemSelect(item.id);
      });
    }
  }, [effectiveColumnConfig.groupBy, onItemSelect, resolveGridRowItem, selectedItemId]);

  const handleBeforeSorting = useCallback((
    event: RevoGridCustomEvent<BeforeSortingDetail>,
  ) => {
    if (!onSortChange) return;
    // RevoGrid's in-place VDOM patch crashes when its native sort indicator
    // changes beside a custom column template. Keep its header-click contract,
    // but remount the grid for the next sort state instead of patching it.
    event.preventDefault();
    const column = String(event.detail.column.prop);
    const direction = sortBy === column && sortDirection === 'desc' ? 'asc' : 'desc';
    event.detail.order = direction;
    onSortChange(column, direction);
  }, [onSortChange, sortBy, sortDirection]);

  // @revolist/react-datagrid's forwarded ref and custom-event bridge are not
  // reliable under the renderer's React version. Resolve the upgraded element
  // from our own container, then bind complex properties and events directly.
  useEffect(() => {
    let cancelled = false;
    let boundGrid: HTMLRevoGridElement | null = null;
    let removeGridListeners = (): void => {};

    const bindGrid = (): boolean => {
      const queriedGrid = gridCanvasRef.current?.querySelector('revo-grid') as HTMLRevoGridElement | null;
      const grid = queriedGrid ?? gridRef.current;
      if (!grid || typeof grid.addEventListener !== 'function') return false;
      if (grid === boundGrid) return true;

      removeGridListeners();
      boundGrid = grid;
      gridRef.current = grid;

      const hydrateGridData = (): void => {
        if (cancelled || boundGrid !== grid) return;
        if (grid.columns !== gridColumns) grid.columns = gridColumns;
        if (grid.source !== gridSource) grid.source = gridSource;
        if (grid.grouping !== gridGrouping) grid.grouping = gridGrouping ?? {};
        if (grid.sorting !== gridSorting) grid.sorting = gridSorting;
      };
      const afterEdit = (event: Event): void => {
        handleAfterEdit(event as RevoGridCustomEvent<AfterEditEvent>);
      };
      const afterFocus = (event: Event): void => {
        handleCellFocus(event as RevoGridCustomEvent<FocusAfterRenderEvent>);
      };
      const afterColumnResize = (event: Event): void => {
        handleColumnResize(event as RevoGridCustomEvent<{ [index: number]: ColumnRegular }>);
      };
      const beforeSorting = (event: Event): void => {
        handleBeforeSorting(event as RevoGridCustomEvent<BeforeSortingDetail>);
      };
      const persistGridOrder = (): void => {
        if (!onColumnConfigChange || typeof grid.getColumnStore !== 'function') return;
        void grid.getColumnStore('rgCol').then(store => {
          if (cancelled || boundGrid !== grid) return;
          const source = store.get('source') as ColumnRegular[];
          const items = store.get('items') as number[];
          const visibleColumns = items
            .map(index => source[index]?.prop)
            .filter((prop): prop is string => typeof prop === 'string');
          if (
            visibleColumns.length === effectiveColumnConfig.visibleColumns.length
            && visibleColumns.some((id, index) => id !== effectiveColumnConfig.visibleColumns[index])
          ) {
            onColumnConfigChange({ ...effectiveColumnConfig, visibleColumns });
          }
        });
      };

      grid.addEventListener('aftergridinit', hydrateGridData);
      grid.addEventListener('afteredit', afterEdit);
      grid.addEventListener('afterfocus', afterFocus);
      grid.addEventListener('aftercolumnresize', afterColumnResize);
      grid.addEventListener('beforesorting', beforeSorting);
      grid.addEventListener('columndragend', persistGridOrder);
      removeGridListeners = () => {
        grid.removeEventListener('aftergridinit', hydrateGridData);
        grid.removeEventListener('afteredit', afterEdit);
        grid.removeEventListener('afterfocus', afterFocus);
        grid.removeEventListener('aftercolumnresize', afterColumnResize);
        grid.removeEventListener('beforesorting', beforeSorting);
        grid.removeEventListener('columndragend', persistGridOrder);
      };

      if (typeof grid.componentOnReady === 'function') {
        void grid.componentOnReady().then(hydrateGridData);
      } else if (typeof customElements !== 'undefined') {
        void customElements.whenDefined('revo-grid').then(hydrateGridData);
      } else {
        hydrateGridData();
      }
      return true;
    };

    const observer = typeof MutationObserver === 'undefined'
      ? null
      : new MutationObserver(() => {
        if (bindGrid()) observer?.disconnect();
      });

    if (!bindGrid() && gridCanvasRef.current) {
      observer?.observe(gridCanvasRef.current, { childList: true, subtree: true });
    }

    return () => {
      cancelled = true;
      observer?.disconnect();
      removeGridListeners();
      if (gridRef.current === boundGrid) gridRef.current = null;
      boundGrid = null;
    };
  }, [
    effectiveColumnConfig,
    gridColumns,
    gridSource,
    gridGrouping,
    gridSorting,
    handleAfterEdit,
    handleBeforeSorting,
    handleCellFocus,
    handleColumnResize,
    onColumnConfigChange,
  ]);

  const loading = !dataLoaded && items.length === 0;
  const hasAnyFilters = hasExternalFilters || Boolean(searchTerm.trim()) || hasActiveFilters(columnFilters);

  if (loading) {
    return (
      <div className="tracker-grid-view h-full flex items-center justify-center text-sm text-nim-muted" data-testid="tracker-grid-loading">
        Loading tracker items...
      </div>
    );
  }

  // With column filters active the grid keeps rendering even at zero rows: the
  // header holds the only affordance for clearing those filters, so swapping it
  // for an empty state would strand the user with an unfilterable view.
  const columnFiltersActive = hasActiveFilters(columnFilters);

  return (
    <div
      className="tracker-grid-view relative flex h-full w-full min-h-0 flex-col bg-nim"
      data-testid="tracker-grid-view"
      data-selected-item-id={selectedItemId ?? undefined}
    >
      <div
        ref={gridCanvasRef}
        tabIndex={0}
        className="tracker-grid-canvas relative min-h-0 flex-1 outline-none"
        onKeyDownCapture={handleGridKeyDownCapture}
        onContextMenu={(event) => { void handleGridContextMenu(event); }}
        onPointerDownCapture={() => {
          focusOriginRef.current = null;
        }}
      >
        {sortedItems.length === 0 && !columnFiltersActive ? (
          <div className="tracker-grid-empty flex h-full flex-col items-center justify-center gap-2 text-sm text-nim-muted" data-testid="tracker-grid-empty">
            <span>{hasAnyFilters ? 'No items match these filters.' : 'No tracker items yet.'}</span>
            <div className="flex items-center gap-2">
              {hasAnyFilters && onClearFilters && (
                <button className="text-xs underline hover:text-nim" onClick={onClearFilters}>
                  Clear filters
                </button>
              )}
              {activeTypeFilter !== 'all'
                && onNewItem
                && globalRegistry.get(activeTypeFilter)?.creatable !== false && (
                <button
                  className="rounded-md border-none px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
                  style={{ backgroundColor: getTypeColor(activeTypeFilter) }}
                  data-testid="tracker-grid-new-item"
                  onClick={() => onNewItem(activeTypeFilter as TrackerItemType)}
                >
                  New {activeTypeFilter.charAt(0).toUpperCase() + activeTypeFilter.slice(1)}
                </button>
              )}
            </div>
          </div>
        ) : (
          <RevoGrid
            key={`dbg-d:${gridRenderKey}`}
            ref={gridRef}
            columns={gridColumns}
            source={gridSource}
            grouping={gridGrouping}
            sorting={gridSorting}
            theme="compact"
            resize
            range
            canMoveColumns
            readonly={false}
          />
        )}

        {sortedItems.length === 0 && columnFiltersActive && (
        <div
          className="absolute inset-x-0 top-10 flex flex-col items-center gap-2 pt-6 text-sm text-nim-muted"
          data-testid="tracker-grid-filtered-empty"
        >
          <span>No items match these column filters.</span>
          <button
            className="text-xs underline hover:text-nim"
            onClick={() => onColumnFiltersChange?.({ combinator: 'and', clauses: [] })}
          >
            Clear column filters
          </button>
        </div>
        )}
      </div>

      {filterTarget && (
        <TrackerFilterValueMenu
          key={`${filterTarget.columnId}:${JSON.stringify(
            clausesForField(columnFilters, filterTarget.columnId).map(clause => clause.value),
          )}`}
          field={filterFields.find(field => field.id === filterTarget.columnId) ?? {
            id: filterTarget.columnId,
            label: visibleColumnDefs.find(c => c.id === filterTarget.columnId)?.label
              ?? filterTarget.columnId,
            type: getFieldForColumn(schemaType, filterTarget.columnId)?.type,
            multiValue: getFieldForColumn(schemaType, filterTarget.columnId)?.multiValue,
            options: getFieldForColumn(schemaType, filterTarget.columnId)?.options,
          }}
          anchorRect={filterTarget.rect}
          placement="below"
          selectedValues={new Set(
            clausesForField(columnFilters, filterTarget.columnId).flatMap(clause =>
              Array.isArray(clause.value)
                ? clause.value.map(String)
                : clause.value === undefined ? [] : [String(clause.value)]),
          )}
          onSelect={(value, op = '=') => {
            handleApplyColumnFilter(
              filterTarget.columnId,
              op === 'is-current-user' || op === 'is-not-current-user'
                ? [{ field: filterTarget.columnId, op }]
                : [{ field: filterTarget.columnId, op, value }],
              columnFilters?.combinator ?? 'and',
            );
            setFilterTarget(null);
          }}
          onClear={filteredColumnIds.has(filterTarget.columnId)
            ? () => {
              handleApplyColumnFilter(
                filterTarget.columnId,
                [],
                columnFilters?.combinator ?? 'and',
              );
              setFilterTarget(null);
            }
            : undefined}
          onClose={() => setFilterTarget(null)}
          testIdPrefix="tracker-column-filter"
        />
      )}

      <TrackerRowContextMenu
        anchor={contextAnchor}
        refs={contextRefs}
        floatingStyles={contextFloatingStyles}
        selectedIds={selectedIds}
        activeTypeFilter={activeTypeFilter}
        statusOptions={statusOptionsForBulk}
        collectionTargets={collectionTargets}
        onSetStatus={handleBulkStatusUpdate}
        onSetPriority={handleBulkPriorityUpdate}
        onAddToCollection={handleAddSelectionToCollection}
        onCopyDeepLink={onCopyDeepLink}
        onArchiveItems={onArchiveItems}
        onDeleteItems={onDeleteItems}
        closeContextMenu={closeContextMenu}
        clearSelection={() => setSelectedIds(new Set())}
      />
    </div>
  );
}
