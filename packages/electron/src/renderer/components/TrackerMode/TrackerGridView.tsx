/**
 * TrackerGridView -- the editable, virtualized tracker grid.
 *
 * Sits alongside `TrackerTableGrid` (the hand-rolled CSS grid) as the `grid`
 * view mode. Built on RevoGrid so rows are virtualized and any schema-backed
 * cell can be edited in place, with the editor chosen by the field's type.
 *
 * Every commit routes through `useTrackerRows.handleItemUpdate`, so a cell edit
 * is an ordinary single-field tracker write and inherits sync, inverse-edge
 * propagation, and the document-backed vs native write split.
 */

import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RevoGrid, type RevoGridCustomEvent } from '@revolist/react-datagrid';
import type {
  AfterEditEvent,
  BeforeSaveDataDetails,
  ColumnRegular,
  FocusAfterRenderEvent,
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
  sortTrackerRecords,
  type TrackerColumnDef,
  type TypeColumnConfig,
} from '@nimbalyst/runtime/plugins/TrackerPlugin';
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
  onSortChange?: (column: string, direction: 'asc' | 'desc') => void;
  preserveItemOrder?: boolean;
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
  onSortChange,
  preserveItemOrder = false,
}: TrackerGridViewProps): JSX.Element {
  const [filterTarget, setFilterTarget] = useState<{ columnId: string; rect: DOMRect } | null>(null);
  const activeTypeFilter = filterType;
  const schemaType = activeTypeFilter === 'all' ? '' : activeTypeFilter;

  const atomItems = useAtomValue(trackerItemsByTypeAtom(activeTypeFilter));
  const dataLoaded = useAtomValue(trackerDataLoadedAtom);
  const sourceItems = overrideItems ?? atomItems;

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
    () => applyFilterSet(
      chipFilteredItems,
      columnFilters,
      getGridFilterValue,
    ),
    [chipFilteredItems, columnFilters, getGridFilterValue],
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
  const { handleItemUpdate, isItemEditable } = rows;
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
      sortBy,
      sortDirection,
      onSort: onSortChange,
    }),
    [
      visibleColumnDefs, schemaType, effectiveColumnConfig.columnWidths,
      isRowEditable, relationshipCandidates, filteredColumnIds, onColumnFiltersChange,
      sortBy, sortDirection, onSortChange,
    ],
  );

  const gridSource = useMemo(
    () => buildGridSource(sortedItems, visibleColumnDefs),
    [sortedItems, visibleColumnDefs],
  );

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
    const item = sortedItemsRef.current[rowIndex];
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
  }, [isItemEditable, visibleColumnDefs, schemaType, handleItemUpdate]);

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
    const item = sortedItemsRef.current[rowIndex];
    if (item && onItemSelect) onItemSelect(item.id);
  }, [onItemSelect]);

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
    const item = sortedItemsRef.current[rowIndex];

    // A mouse focus opens details as before. Keyboard focus only changes the
    // row while browsing; once details are open, it keeps the panel in sync.
    if (item && onItemSelect && (!keyboardFocused || selectedItemId)) {
      onItemSelect(item.id);
    }
  }, [onItemSelect, selectedItemId]);

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
        grid.columns = gridColumns;
        grid.source = gridSource;
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
      grid.addEventListener('columndragend', persistGridOrder);
      removeGridListeners = () => {
        grid.removeEventListener('aftergridinit', hydrateGridData);
        grid.removeEventListener('afteredit', afterEdit);
        grid.removeEventListener('afterfocus', afterFocus);
        grid.removeEventListener('aftercolumnresize', afterColumnResize);
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
    handleAfterEdit,
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
        onPointerDownCapture={() => {
          focusOriginRef.current = null;
        }}
      >
        {sortedItems.length === 0 && !columnFiltersActive ? (
          <div className="tracker-grid-empty flex h-full flex-col items-center justify-center gap-2 text-sm text-nim-muted" data-testid="tracker-grid-empty">
            <span>{hasAnyFilters ? 'No items match these filters.' : 'No tracker items yet.'}</span>
            {hasAnyFilters && onClearFilters && (
              <button className="text-xs underline hover:text-nim" onClick={onClearFilters}>
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <RevoGrid
            ref={gridRef}
            columns={gridColumns}
            source={gridSource}
            theme="compact"
            resize
            range
            rowHeaders
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
          field={filterFields.find(field => field.id === filterTarget.columnId) ?? {
            id: filterTarget.columnId,
            label: visibleColumnDefs.find(c => c.id === filterTarget.columnId)?.label
              ?? filterTarget.columnId,
            type: getFieldForColumn(schemaType, filterTarget.columnId)?.type,
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
          onSelect={(value) => {
            handleApplyColumnFilter(
              filterTarget.columnId,
              [{ field: filterTarget.columnId, op: '=', value }],
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
    </div>
  );
}
