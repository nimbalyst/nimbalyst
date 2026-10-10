/**
 * The table view: rows through RevoGrid, columns through the shared registry.
 *
 * Kept deliberately thin. `TrackerGridView` on desktop is a thousand lines
 * because it also owns an undo stack, a range-edit clipboard, a row context
 * menu, and a bulk-archive path -- none of which are what makes a tracker
 * readable in a browser tab, and all of which would have to be re-proved against
 * a different mutation path. What is shared is the part that must never fork:
 * `buildGridColumns` / `buildGridSource`, which decide what a cell contains and
 * how it compares, and the gesture that separates opening a row from editing a
 * cell (`handleCellFocus`) -- a table where click means something different in
 * the browser than on the desktop is worse than either answer alone.
 *
 * RevoGrid is a Stencil web component and its custom elements register
 * globally, so the host page owns exactly one copy (externalized peer,
 * `optimizeDeps.exclude`). A second copy under a different Vite `?v=` hash does
 * not throw -- it renders a blank grid with a clean console (NIM-2165). If this
 * surface is empty and the row count is not, look there first.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { RevoGrid, type RevoGridCustomEvent } from '@revolist/react-datagrid';
import type {
  AfterEditEvent,
  BeforeSaveDataDetails,
  ColumnRegular,
  FocusAfterRenderEvent,
} from '@revolist/revogrid';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import {
  getDefaultColumnConfig,
  getFieldForColumn,
  resolveColumnFieldName,
  resolveColumnsForType,
  type TrackerColumnDef,
  type TypeColumnConfig,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerColumns';
import { coerceCellValue } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerCellEditors';
import {
  clausesForField,
  hasActiveFilters,
  withFieldClauses,
  type TrackerFilterSet,
  type TrackerRelationshipLabelResolver,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  buildGridSource,
  ROW_ITEM_ID,
  type SortColumn,
  type SortDirection,
} from '@nimbalyst/collab-client/trackers';
import { TrackerSurfaceMessage } from '../primitives/TrackerSurfaceMessage';
import { useTrackersUITeamMembers } from '../TrackersUIProvider';
import { buildDerivedGridColumn, buildGridActionsColumn, buildGridColumns } from './trackerGridColumns';
import { LazyTrackerColumnFilterPopover } from './LazyTrackerColumnFilterPopover';
import { useGridKeyOriginGuard } from './gridKeyOrigin';
import './trackerGrid.css';
import { useGridViewSettings, type GridViewSettings } from './useGridViewSettings';

export interface TrackerGridSurfaceProps extends GridViewSettings {
  rows: TrackerRecord[];
  /** `'all'` for a mixed-type grid; a tracker type resolves one schema. */
  trackerType: string;
  columnConfig?: TypeColumnConfig | null;
  sortBy?: SortColumn;
  sortDirection?: SortDirection;
  columnFilters?: TrackerFilterSet | null;
  onColumnFiltersChange?: (filters: TrackerFilterSet) => void;
  /** Names a relationship target from the live record rather than the link snapshot. */
  resolveRelationshipLabel?: TrackerRelationshipLabelResolver;
  /** Omit to render a read-only grid; a permission state, not a milestone. */
  isRowEditable?: (itemId: string) => boolean;
  /** One callback for one cell or a whole pasted range; hosts can batch it. */
  onItemsUpdate?: (
    entries: readonly TrackerGridUpdateEntry[]
  ) => Promise<unknown> | unknown;
  /** The row the detail pane is showing; highlighted here so the table agrees. */
  selectedItemId?: string | null;
  /** Opens a row into the host's detail. See `handleCellFocus` for the gesture. */
  onOpenItem?: (itemId: string) => void;
  /**
   * Right-click on a row, and the click on its overflow button.
   *
   * Supplying this is what adds the pinned trailing overflow column: that cell
   * dispatches a synthetic `contextmenu` for a host row menu to catch, so a
   * host without a menu would get an inert button and a permanently empty
   * column at the right edge of every row. It used to be a separate
   * `rowActions` boolean and the two could disagree -- the column shipped
   * switched off precisely because nothing was listening. Now the listener *is*
   * the switch.
   *
   * `itemIds` is the right-clicked row, or the whole selected range when that
   * row is inside one, so a host can offer an action over several items.
   */
  onRowContextMenu?: (payload: {
    itemIds: string[];
    point: { x: number; y: number };
  }) => void;
  /** False until the first snapshot resolves. */
  loaded: boolean;
  /** Read-only columns the host computes per row (a type page's Where), after the field columns unless placed with `after`. */
  derivedColumns?: readonly TrackerGridDerivedColumn[];
}

export interface TrackerGridDerivedColumn {
  /** Row key; must not collide with a field column id. */
  id: string;
  label: string;
  width?: number;
  /** Field column id to sit right after; appended when that column is not shown. */
  after?: string;
  value: (row: TrackerRecord) => string;
}

function placeDerivedColumns(
  fieldColumns: ColumnRegular[],
  derived: readonly TrackerGridDerivedColumn[],
): ColumnRegular[] {
  const placed = [...fieldColumns];
  const trailing: ColumnRegular[] = [];
  for (const column of derived) {
    const anchor = column.after ? placed.findIndex((candidate) => candidate.prop === column.after) : -1;
    if (anchor >= 0) placed.splice(anchor + 1, 0, buildDerivedGridColumn(column));
    else trailing.push(buildDerivedGridColumn(column));
  }
  return [...placed, ...trailing];
}

export interface TrackerGridUpdateEntry {
  itemId: string;
  updates: Record<string, unknown>;
}

const NEVER_EDITABLE = () => false;

/**
 * Row key RevoGrid reads for a per-row class, and the class it carries.
 *
 * A class on the row model rather than a DOM write, because rows are
 * virtualized and re-rendered on scroll, and because the row's grid index moves
 * under RevoGrid's own sort model -- neither of which an imperative
 * `classList.add` survives.
 */
const ROW_CLASS_KEY = '__trackerRowClass';
const ROW_SELECTED_CLASS = 'tracker-grid-row-selected';

export function TrackerGridSurface({
  rows,
  trackerType,
  columnConfig,
  sortBy,
  sortDirection = 'desc',
  sortColumns,
  onSortChange,
  onWidthsChange,
  columnFilters,
  onColumnFiltersChange,
  resolveRelationshipLabel,
  isRowEditable = NEVER_EDITABLE,
  onItemsUpdate,
  selectedItemId,
  onOpenItem,
  onRowContextMenu,
  loaded,
  derivedColumns,
}: TrackerGridSurfaceProps) {
  const [filterTarget, setFilterTarget] = useState<{
    columnId: string;
    rect: DOMRect;
  } | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const gridCanvasRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<
    | (HTMLElement & {
        getVisibleSource?: (
          type: 'rgRow'
        ) => Promise<Array<Record<string, unknown>>>;
        getFocused?: () => Promise<{
          cell: { x: number; y: number };
          column?: { prop?: string | number };
          rowType?: string;
        } | null>;
        setCellEdit?: (
          row: number,
          prop: string | number,
          rowType?: string
        ) => Promise<void>;
        getSelectedRange?: () => Promise<{ y?: number; y1?: number } | null>;
      })
    | null
  >(null);
  // 'keyboard' only between the keydown that will move focus and the resulting
  // `afterfocus`; everything else is a pointer.
  const schemaType = trackerType === 'all' ? '' : trackerType;
  const allColumnDefs = useMemo(
    () => resolveColumnsForType(schemaType),
    [schemaType]
  );
  const effectiveConfig = useMemo(
    () => columnConfig ?? getDefaultColumnConfig(schemaType),
    [columnConfig, schemaType]
  );
  const visibleColumnDefs = useMemo(
    () =>
      effectiveConfig.visibleColumns
        .map((id) => allColumnDefs.find((column) => column.id === id))
        .filter((column): column is TrackerColumnDef => column !== undefined),
    [effectiveConfig.visibleColumns, allColumnDefs]
  );

  const filteredColumnIds = useMemo(
    () => new Set((columnFilters?.clauses ?? []).map((clause) => clause.field)),
    [columnFilters]
  );

  // Read when a cell opens, so the directory arriving late does not rebuild the columns.
  const teamMembers = useTrackersUITeamMembers();
  const teamMembersRef = useRef(teamMembers);
  teamMembersRef.current = teamMembers;
  const editorContext = useMemo(() => ({ teamMembers: () => teamMembersRef.current }), []);

  const gridColumns = useMemo(
    () => [
      ...placeDerivedColumns(buildGridColumns(visibleColumnDefs, {
        trackerType: schemaType,
        sortingEnabled: !!onSortChange,
        columnWidths: effectiveConfig.columnWidths,
        isRowEditable,
        editorContext,
        filteredColumnIds,
        onOpenFilter: onColumnFiltersChange
          ? (columnId, rect) => setFilterTarget({ columnId, rect })
          : undefined,
        // The favorite star is a personal-lane affordance; a host that has one
        // renders it through its own grid. Not reconstructed here.
        rowActions: false,
        keyLink: onOpenItem ? { onOpenDetail: onOpenItem } : undefined,
        resolveRelationshipLabel,
      }), derivedColumns ?? []),
      ...(onRowContextMenu ? [buildGridActionsColumn()] : []),
    ],
    [
      visibleColumnDefs,
      onSortChange,
      schemaType,
      effectiveConfig.columnWidths,
      isRowEditable,
      editorContext,
      filteredColumnIds,
      onColumnFiltersChange,
      onOpenItem,
      resolveRelationshipLabel,
      derivedColumns,
      onRowContextMenu,
    ]
  );

  const gridSource = useMemo(() => {
    const source = buildGridSource(rows, visibleColumnDefs);
    if (!derivedColumns?.length) return source;
    // `buildGridSource` keeps one entry per row, in order.
    return source.map((entry, index) => {
      const next = { ...entry };
      for (const column of derivedColumns) next[column.id] = column.value(rows[index]!);
      return next;
    });
  }, [rows, visibleColumnDefs, derivedColumns]);

  const markedGridSource = useMemo(
    () =>
      selectedItemId
        ? gridSource.map((row) =>
            row[ROW_ITEM_ID] === selectedItemId
              ? { ...row, [ROW_CLASS_KEY]: ROW_SELECTED_CLASS }
              : row
          )
        : gridSource,
    [gridSource, selectedItemId]
  );

  const gridSorting = useGridViewSettings(gridCanvasRef, { sortBy, sortDirection, sortColumns, onSortChange, onWidthsChange }, visibleColumnDefs);

  const rowsById = useMemo(
    () => new Map(rows.map((row) => [row.id, row])),
    [rows]
  );

  const resolveGridRecord = useCallback(
    async (rowIndex: number): Promise<TrackerRecord | null> => {
      try {
        const visible = await gridRef.current?.getVisibleSource?.('rgRow');
        const itemId = visible?.[rowIndex]?.[ROW_ITEM_ID];
        if (typeof itemId === 'string') return rowsById.get(itemId) ?? null;
      } catch {
        // The custom element can still be upgrading. The unsorted source is the
        // only safe fallback and matches RevoGrid until its sort model is active.
      }
      const itemId = gridSource[rowIndex]?.[ROW_ITEM_ID];
      return typeof itemId === 'string' ? rowsById.get(itemId) ?? null : null;
    },
    [gridSource, rowsById]
  );

  const buildUpdate = useCallback(
    async (
      rowIndex: number,
      changes: Record<string, unknown>
    ): Promise<TrackerGridUpdateEntry | null> => {
      const item = await resolveGridRecord(rowIndex);
      if (!item || !isRowEditable(item.id)) return null;
      const updates: Record<string, unknown> = {};
      for (const [columnId, rawValue] of Object.entries(changes)) {
        const column = visibleColumnDefs.find(
          (candidate) => candidate.id === columnId
        );
        if (!column?.editable) continue;
        const fieldName = resolveColumnFieldName(item.primaryType, column);
        const field = getFieldForColumn(item.primaryType, fieldName);
        if (!field || field.readOnly) continue;
        const value = coerceCellValue(field, rawValue);
        if (
          JSON.stringify(item.fields[fieldName] ?? null) !==
          JSON.stringify(value ?? null)
        ) {
          updates[fieldName] = value;
        }
      }
      return Object.keys(updates).length > 0
        ? { itemId: item.id, updates }
        : null;
    },
    [isRowEditable, resolveGridRecord, visibleColumnDefs]
  );

  const handleAfterEdit = useCallback(
    async (event: RevoGridCustomEvent<AfterEditEvent>) => {
      if (!onItemsUpdate) return;
      const detail = event.detail;
      const rawEntries =
        'data' in detail && detail.data != null
          ? Object.entries(detail.data).map(([rowIndex, changes]) => ({
              rowIndex: Number(rowIndex),
              changes: changes as Record<string, unknown>,
            }))
          : [
              {
                rowIndex: (detail as BeforeSaveDataDetails).rowIndex,
                changes: {
                  [String((detail as BeforeSaveDataDetails).prop)]: (
                    detail as BeforeSaveDataDetails
                  ).val,
                },
              },
            ];
      const resolved = await Promise.all(
        rawEntries.map(({ rowIndex, changes }) =>
          buildUpdate(rowIndex, changes)
        )
      );
      const entries = resolved.filter(
        (entry): entry is TrackerGridUpdateEntry => entry !== null
      );
      if (entries.length === 0) return;
      setMutationError(null);
      try {
        await onItemsUpdate(entries);
      } catch (cause) {
        setMutationError(
          cause instanceof Error ? cause.message : String(cause)
        );
      }
    },
    [buildUpdate, onItemsUpdate]
  );

  /**
   * Moving the selection never opens a row -- the Key cell is the open button.
   * Focus only follows the selection once the detail is already open, so
   * arrowing down the grid reads as browsing the open item.
   *
   * This is the gesture desktop's `TrackerGridView` settled on, and the reason
   * it costs inline editing nothing: RevoGrid starts an edit on double-click,
   * F2, or typing, and none of those now compete with opening a row.
   */
  const handleCellFocus = useCallback(
    async (
      event: RevoGridCustomEvent<FocusAfterRenderEvent>
    ): Promise<void> => {
      const rowIndex = event.detail?.rowIndex;
      if (!onOpenItem || typeof rowIndex !== 'number') return;
      if (!selectedItemId) return;
      const item = await resolveGridRecord(rowIndex);
      if (item) onOpenItem(item.id);
    },
    [onOpenItem, resolveGridRecord, selectedItemId]
  );

  const openFocusedItem = useCallback(async (): Promise<void> => {
    const rowIndex = (await gridRef.current?.getFocused?.())?.cell?.y;
    if (typeof rowIndex !== 'number') return;
    const item = await resolveGridRecord(rowIndex);
    if (item && onOpenItem) onOpenItem(item.id);
  }, [onOpenItem, resolveGridRecord]);

  /** Enter is spent on opening the row, so keyboard editing moves to F2. */
  const editFocusedCell = useCallback(async (): Promise<void> => {
    const grid = gridRef.current;
    const focused = await grid?.getFocused?.();
    const prop = focused?.column?.prop;
    if (!grid || !focused || prop == null) return;
    await grid.setCellEdit?.(focused.cell.y, prop, focused.rowType);
  }, []);

  /**
   * Right-click, and the overflow button's synthetic `contextmenu`.
   *
   * The row is identified from RevoGrid's own `data-rgrow` attribute rather
   * than from the click coordinates: the grid is virtualized and its sort model
   * reorders rows under `gridSource`, so the index in the DOM is the only one
   * that agrees with what the reader is pointing at.
   */
  const handleContextMenu = useCallback(
    async (event: ReactMouseEvent<HTMLDivElement>): Promise<void> => {
      if (!onRowContextMenu) return;
      const cell = (event.target as HTMLElement | null)?.closest?.(
        '[data-rgrow]'
      );
      const rowAttr = cell?.getAttribute('data-rgrow');
      if (rowAttr == null) return;
      const rowIndex = Number(rowAttr);
      if (!Number.isFinite(rowIndex)) return;

      event.preventDefault();
      const point = { x: event.clientX, y: event.clientY };

      // Right-clicking inside an existing range acts on the range; right-clicking
      // outside one acts on the row alone, which is what every other table does.
      const range = await gridRef.current
        ?.getSelectedRange?.()
        .catch(() => null);
      const inRange =
        range &&
        typeof range.y === 'number' &&
        typeof range.y1 === 'number' &&
        rowIndex >= Math.min(range.y, range.y1) &&
        rowIndex <= Math.max(range.y, range.y1);
      const rowIndexes =
        inRange && range
          ? Array.from(
              { length: Math.abs(range.y1! - range.y!) + 1 },
              (_, offset) => Math.min(range.y!, range.y1!) + offset
            )
          : [rowIndex];

      const resolved = await Promise.all(
        rowIndexes.map((index) => resolveGridRecord(index))
      );
      const itemIds = resolved
        .filter((item): item is TrackerRecord => item !== null)
        .map((item) => item.id);
      if (itemIds.length === 0) return;
      onRowContextMenu({ itemIds, point });
    },
    [onRowContextMenu, resolveGridRecord]
  );

  // RevoGrid's document-level keydown listener acts on keys typed anywhere in the
  // app while a cell is selected. Decline the ones that did not start in here.
  useGridKeyOriginGuard(gridCanvasRef);

  const handleKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!onOpenItem) return;
      const key = event.key;
      const isEditing = event.nativeEvent
        .composedPath()
        .some(
          (target) =>
            target instanceof HTMLElement &&
            (target.classList.contains('tracker-grid-editor-input') ||
              target.classList.contains('tracker-grid-choice-anchor') ||
              target.classList.contains('tracker-grid-editor-checkbox'))
        );

      // RevoGrid owns editor keystrokes.
      if (isEditing) return;

      if (key === 'Enter' || key === 'F2') {
        event.preventDefault();
        event.stopPropagation();
        void (key === 'Enter' ? openFocusedItem() : editFocusedCell());
      }
    },
    [editFocusedCell, onOpenItem, openFocusedItem]
  );

  useEffect(() => {
    if (!onItemsUpdate && !onOpenItem) return undefined;
    let bound: typeof gridRef.current = null;
    const bind = (): boolean => {
      const grid = gridCanvasRef.current?.querySelector(
        'revo-grid'
      ) as typeof gridRef.current;
      if (!grid || grid === bound) return Boolean(grid);
      unbind(bound);
      bound = grid;
      gridRef.current = grid;
      if (onItemsUpdate) grid.addEventListener('afteredit', editListener);
      if (onOpenItem) grid.addEventListener('afterfocus', focusListener);
      return true;
    };
    const unbind = (grid: typeof gridRef.current) => {
      grid?.removeEventListener('afteredit', editListener);
      grid?.removeEventListener('afterfocus', focusListener);
    };
    const editListener = (event: Event) => {
      void handleAfterEdit(event as RevoGridCustomEvent<AfterEditEvent>);
    };
    const focusListener = (event: Event) => {
      void handleCellFocus(event as RevoGridCustomEvent<FocusAfterRenderEvent>);
    };
    const observer =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            if (bind()) observer?.disconnect();
          });
    if (!bind() && gridCanvasRef.current)
      observer?.observe(gridCanvasRef.current, {
        childList: true,
        subtree: true,
      });
    return () => {
      observer?.disconnect();
      unbind(bound);
      if (gridRef.current === bound) gridRef.current = null;
    };
  }, [handleAfterEdit, handleCellFocus, onItemsUpdate, onOpenItem]);

  if (!loaded) {
    return (
      <TrackerSurfaceMessage
        icon="table"
        message="Loading tracker items..."
        testId="tracker-grid-loading"
      />
    );
  }

  // With column filters active the grid keeps rendering even at zero rows: the
  // header holds the only affordance for clearing those filters, so swapping it
  // for an empty state would strand the reader with an unfilterable view.
  const columnFiltersActive = hasActiveFilters(columnFilters);
  const filterField = filterTarget
    ? visibleColumnDefs.find((column) => column.id === filterTarget.columnId)
    : undefined;

  return (
    <div
      className="tracker-grid-view relative flex h-full w-full min-h-0 flex-col bg-nim"
      data-testid="tracker-grid-view"
    >
      {mutationError ? (
        <div
          className="tracker-grid-mutation-error px-3 py-2 text-xs text-nim-error"
          role="alert"
        >
          {mutationError}
        </div>
      ) : null}
      <div
        ref={gridCanvasRef}
        className="tracker-grid-canvas relative min-h-0 flex-1 outline-none"
        tabIndex={onOpenItem ? 0 : undefined}
        onKeyDownCapture={handleKeyDownCapture}
        onContextMenu={(event) => {
          void handleContextMenu(event);
        }}
      >
        {rows.length === 0 && !columnFiltersActive ? (
          <TrackerSurfaceMessage
            icon="table"
            message="No tracker items yet."
            testId="tracker-grid-empty"
          />
        ) : (
          <RevoGrid
            key={`${schemaType}:${sortBy ?? ''}:${sortDirection}:${JSON.stringify(sortColumns)}`}
            columns={gridColumns}
            source={markedGridSource}
            rowClass={ROW_CLASS_KEY}
            sorting={gridSorting}
            theme="compact"
            hideAttribution
            resize
            range
            readonly={!onItemsUpdate}
          />
        )}

        {rows.length === 0 && columnFiltersActive ? (
          <div
            className="absolute inset-x-0 top-10 flex flex-col items-center gap-2 pt-6 text-sm text-nim-muted"
            data-testid="tracker-grid-filtered-empty"
          >
            <span>No items match these column filters.</span>
            <button
              className="text-xs underline hover:text-nim"
              onClick={() =>
                onColumnFiltersChange?.({ combinator: 'and', clauses: [] })
              }
            >
              Clear column filters
            </button>
          </div>
        ) : null}
      </div>

      {filterTarget && onColumnFiltersChange ? (
        <LazyTrackerColumnFilterPopover
          anchorRect={filterTarget.rect}
          columnId={filterTarget.columnId}
          columnLabel={filterField?.label ?? filterTarget.columnId}
          field={
            filterField
              ? getFieldForColumn(
                  schemaType,
                  resolveColumnFieldName(schemaType, filterField)
                )
              : undefined
          }
          clauses={clausesForField(columnFilters, filterTarget.columnId)}
          combinator={columnFilters?.combinator ?? 'and'}
          onApply={(clauses, combinator) => {
            onColumnFiltersChange({
              ...withFieldClauses(
                columnFilters,
                filterTarget.columnId,
                clauses
              ),
              combinator,
            });
          }}
          onClose={() => setFilterTarget(null)}
        />
      ) : null}
    </div>
  );
}
