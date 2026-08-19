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
  formatTrackerUndoToast,
  type TrackerUndoChange,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerUndoStack';
import {
  trackerItemsByTypeAtom,
  trackerDataLoadedAtom,
  trackerRelationshipLabelAtom,
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
  type TrackerGroupBy,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  buildGridActionsColumn,
  buildGridColumns,
  buildGridSource,
  ROW_ACTIONS,
  ROW_ITEM_ID,
} from './grid/trackerGridColumns';
import type { RelationshipCandidate } from './grid/trackerGridEditors';
import {
  TrackerFilterValueMenu,
} from './TrackerFilterValueMenu';
import type { TrackerFilterField } from './TrackerViewHeaderControls';
import { errorNotificationService } from '../../services/ErrorNotificationService';
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
  groupBy?: TrackerGroupBy;
  onItemSelect?: (itemId: string) => void;
  onDetailClose?: () => void;
  selectedItemId?: string | null;
  overrideItems?: TrackerRecord[];
  onDeleteItems?: (itemIds: string[]) => void;
  onArchiveItems?: (itemIds: string[], archive: boolean) => void | Promise<void>;
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
  /** Open a row's item as a document -- double-click and the row context menu. */
  onOpenDocument?: (itemId: string) => void;
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
  groupBy = 'none',
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
  onOpenDocument,
  favoriteItemIds,
  onToggleFavorite,
}: TrackerGridViewProps): JSX.Element {
  const [filterTarget, setFilterTarget] = useState<{ columnId: string; rect: DOMRect } | null>(null);
  const activeTypeFilter = filterType;
  const schemaType = activeTypeFilter === 'all' ? '' : activeTypeFilter;

  const atomItems = useAtomValue(trackerItemsByTypeAtom(activeTypeFilter));
  const dataLoaded = useAtomValue(trackerDataLoadedAtom);
  const relationshipLabel = useAtomValue(trackerRelationshipLabelAtom);
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

  // "Add to Collection" writes a milestone that the active type filter hides, so
  // its undo has to resolve the record from the unfiltered set.
  const allItemsById = useMemo(() => {
    const map = new Map<string, TrackerRecord>();
    for (const item of allTypeItems as TrackerRecord[]) map.set(item.id, item);
    return map;
  }, [allTypeItems]);
  const resolveRecordById = useCallback(
    (itemId: string): TrackerRecord | undefined => allItemsById.get(itemId),
    [allItemsById],
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
    return sortTrackerRecords(filteredItems, sortBy, sortDirection, allColumnDefs);
  }, [allColumnDefs, filteredItems, sortBy, sortDirection, preserveItemOrder]);

  // The archive recorder needs `recordUndoEntry`, and the hook needs the
  // recorder so an archive undo inverts through the same callback. The ref
  // breaks that cycle with a stable indirection.
  const archiveRecorderRef = useRef<
    ((itemIds: string[], archive: boolean, options?: { record?: boolean }) => Promise<void>) | null
  >(null);
  const archiveThroughRecorder = useCallback(
    (itemIds: string[], archive: boolean, options?: { record?: boolean }): Promise<void> =>
      archiveRecorderRef.current?.(itemIds, archive, options) ?? Promise.resolve(),
    [],
  );

  const rows = useTrackerRows({
    items: sortedItems,
    activeTypeFilter,
    onItemSelect,
    onDeleteItems,
    onArchiveItems: onArchiveItems ? archiveThroughRecorder : undefined,
    onSwitchToFilesMode,
    resolveRecordById,
  });
  const {
    handleItemUpdate,
    runUndoable,
    recordUndoEntry,
    captureUndoGeneration,
    undo,
    redo,
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

  /**
   * Archive through the host callback, recording the inverse. Archiving does not
   * go through `handleItemUpdate`, so the entry is pushed by hand. A replay
   * passes `record: false` -- the history already owns that change, and
   * re-recording it would push the inverse back onto the stack.
   */
  const archiveWithUndo = useCallback(async (
    itemIds: string[],
    archive: boolean,
    options?: { record?: boolean },
  ): Promise<void> => {
    if (!onArchiveItems) return;
    if (options?.record === false) {
      await onArchiveItems(itemIds, archive);
      return;
    }

    const changes: TrackerUndoChange[] = itemIds
      .map(itemId => itemsById.get(itemId))
      .filter((item): item is TrackerRecord => item !== undefined && Boolean(item.archived) !== archive)
      .map(item => ({
        kind: 'archive',
        itemId: item.id,
        previousArchived: Boolean(item.archived),
        nextArchived: archive,
      }));

    // Archiving many rows is slow enough that the user can switch tracker type
    // mid-flight, which clears the history. The generation captured here makes
    // the entry land in that history or nowhere -- never in the fresh one, where
    // Cmd+Z would unarchive rows from a view the user has left.
    const generation = captureUndoGeneration();
    await onArchiveItems(itemIds, archive);
    recordUndoEntry({
      label: `${archive ? 'Archive' : 'Unarchive'} ${changes.length} item${changes.length === 1 ? '' : 's'}`,
      changes,
    }, generation);
  }, [captureUndoGeneration, itemsById, onArchiveItems, recordUndoEntry]);
  useEffect(() => {
    archiveRecorderRef.current = archiveWithUndo;
  }, [archiveWithUndo]);

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
    () => [
      ...buildGridColumns(visibleColumnDefs, {
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
        rowActions: true,
      }),
      buildGridActionsColumn(),
    ],
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
        groupBy,
        relationshipLabel,
      ),
    })),
    [groupBy, sortedItems, visibleColumnDefs, relationshipLabel],
  );
  const gridGrouping = useMemo(
    () => groupBy !== 'none'
      ? { props: [ROW_GROUP_LABEL], expandedAll: true }
      : undefined,
    [groupBy],
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

  /**
   * Resolve the schema field a column maps to for one item, or `null` when the
   * cell cannot be edited (derived column, readonly field, or locked row). The
   * role lookup happens per item because a mixed-type view maps the same column
   * to differently named fields on each row.
   */
  const resolveEditableField = useCallback((
    item: TrackerRecord,
    prop: string,
  ): { fieldName: string; field: NonNullable<ReturnType<typeof getFieldForColumn>> } | null => {
    if (!isItemEditable(item)) return null;
    const column = visibleColumnDefs.find(c => c.id === prop);
    if (!column?.editable) return null;
    const fieldName = column.role
      ? resolveRoleFieldName(item.primaryType, column.role)
      : prop;
    const field = getFieldForColumn(item.primaryType, fieldName);
    if (!field || field.readOnly) return null;
    return { fieldName, field };
  }, [isItemEditable, visibleColumnDefs]);

  /** Commit one or more cells from the same row as one durable item update. */
  const commitRow = useCallback(async (
    rowIndex: number,
    changes: Record<string, unknown>,
  ): Promise<void> => {
    const item = await resolveGridRowItem(rowIndex);
    if (!item) return;

    const updates: Record<string, unknown> = {};
    for (const [prop, rawValue] of Object.entries(changes)) {
      const editable = resolveEditableField(item, prop);
      if (!editable) continue;
      const value = coerceCellValue(editable.field, rawValue);
      const current = item.fields[editable.fieldName];
      if (JSON.stringify(current ?? null) !== JSON.stringify(value ?? null)) {
        updates[editable.fieldName] = value;
      }
    }
    if (Object.keys(updates).length > 0) {
      await handleItemUpdate(item, updates);
    }
  }, [handleItemUpdate, resolveEditableField, resolveGridRowItem]);

  const handleAfterEdit = useCallback((event: RevoGridCustomEvent<AfterEditEvent>) => {
    const detail = event.detail;

    if (isRangeEdit(detail)) {
      // Paste / fill-down: one write per touched row, so two cells in the same
      // JSON-backed item cannot race and overwrite each other. The whole range
      // is one undo entry so a mis-landed paste takes one Cmd+Z, not one per row.
      const rowEntries = Object.entries(detail.data ?? {});
      const cellCount = rowEntries.reduce(
        (total, [, changes]) => total + Object.keys(changes as Record<string, unknown>).length,
        0,
      );
      void runUndoable(`Paste ${cellCount} cell${cellCount === 1 ? '' : 's'}`, async () => {
        await Promise.all(rowEntries.map(([rowKey, changes]) =>
          commitRow(Number(rowKey), changes as Record<string, unknown>)));
      });
      return;
    }

    const single = detail as BeforeSaveDataDetails;
    const prop = String(single.prop);
    const columnLabel = visibleColumnDefs.find(column => column.id === prop)?.label ?? prop;
    void runUndoable(`Edit ${columnLabel}`, () => commitRow(single.rowIndex, { [prop]: single.val }));
  }, [commitRow, runUndoable, visibleColumnDefs]);

  /**
   * Double-click edits an editable cell and opens the row's item as a document
   * otherwise. RevoGrid's own double-click handler already opened the inline
   * editor by the time this runs, so opening the document over an editable cell
   * would immediately throw the edit away. RevoGrid renders its own cells, so
   * the row comes from the same `data-rgrow` attribute the context menu
   * resolves against rather than a React row handler.
   */
  const handleGridDoubleClick = useCallback(async (
    event: ReactMouseEvent<HTMLDivElement>,
  ): Promise<void> => {
    if (!onOpenDocument) return;
    const cell = (event.target as HTMLElement | null)?.closest?.('[data-rgrow]');
    const rowAttr = cell?.getAttribute('data-rgrow');
    if (rowAttr == null) return;
    const rowIndex = Number(rowAttr);
    if (!Number.isFinite(rowIndex)) return;
    const item = await resolveGridRowItem(rowIndex);
    if (!item) return;

    // The pointer down that started this double-click already focused the cell,
    // so the focused column is the one under the cursor.
    const focused = await gridRef.current?.getFocused?.();
    const prop = focused?.column?.prop;
    if (
      focused?.cell?.y === rowIndex
      && prop != null
      && resolveEditableField(item, String(prop))
    ) {
      return;
    }
    onOpenDocument(item.id);
  }, [onOpenDocument, resolveEditableField, resolveGridRowItem]);

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

  /**
   * Replay the top of the stack and report it. An empty stack stays silent --
   * every other app treats Cmd+Z with nothing to undo as a no-op.
   */
  const replayUndoEntry = useCallback(async (direction: 'undo' | 'redo'): Promise<void> => {
    const result = direction === 'undo' ? await undo() : await redo();
    if (!result) return;
    const { title, body } = formatTrackerUndoToast(
      direction,
      result.label,
      result.applied,
      result.skipped,
    );
    errorNotificationService.showInfo(title, body, { duration: 2500 });
  }, [redo, undo]);

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

    // Outside a cell editor Cmd/Ctrl+Z belongs to the grid's own history. The
    // app menu's `Edit > Undo` role does not swallow the keydown, so this runs.
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'z') {
      event.preventDefault();
      event.stopPropagation();
      void replayUndoEntry(event.shiftKey ? 'redo' : 'undo');
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
  }, [editFocusedCell, onDetailClose, openFocusedItem, replayUndoEntry, selectedItemId]);

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
      if (groupBy === 'none') {
        const item = sortedItemsRef.current[rowIndex];
        if (item) onItemSelect(item.id);
        return;
      }
      void resolveGridRowItem(rowIndex).then(item => {
        if (item) onItemSelect(item.id);
      });
    }
  }, [groupBy, onItemSelect, resolveGridRowItem, selectedItemId]);

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
      // Drag-to-clone silently rewrites a whole column of tracker items with no
      // way back. `trackerGrid.css` hides the handle; cancelling here survives a
      // RevoGrid upgrade that renames the class. Clipboard paste reaches
      // `afteredit` through `rangeeditapply` instead, so it is unaffected.
      const beforeAutofill = (event: Event): void => {
        event.preventDefault();
      };
      const persistGridOrder = (): void => {
        if (!onColumnConfigChange || typeof grid.getColumnStore !== 'function') return;
        void grid.getColumnStore('rgCol').then(store => {
          if (cancelled || boundGrid !== grid) return;
          const source = store.get('source') as ColumnRegular[];
          const items = store.get('items') as number[];
          const visibleColumns = items
            .map(index => source[index]?.prop)
            .filter((prop): prop is string => typeof prop === 'string' && prop !== ROW_ACTIONS);
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
      grid.addEventListener('beforeautofill', beforeAutofill);
      grid.addEventListener('columndragend', persistGridOrder);
      removeGridListeners = () => {
        grid.removeEventListener('aftergridinit', hydrateGridData);
        grid.removeEventListener('afteredit', afterEdit);
        grid.removeEventListener('afterfocus', afterFocus);
        grid.removeEventListener('aftercolumnresize', afterColumnResize);
        grid.removeEventListener('beforesorting', beforeSorting);
        grid.removeEventListener('beforeautofill', beforeAutofill);
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
        onDoubleClick={(event) => { void handleGridDoubleClick(event); }}
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
        onOpenDocument={onOpenDocument}
        onArchiveItems={onArchiveItems ? archiveWithUndo : undefined}
        onDeleteItems={onDeleteItems}
        closeContextMenu={closeContextMenu}
        clearSelection={() => setSelectedIds(new Set())}
      />
    </div>
  );
}
