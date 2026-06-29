/**
 * TrackerTableGrid -- true tabular grid for tracker items.
 *
 * Companion to `TrackerTable` (the title-left / badges-right row list).
 * Uses CSS Grid so the header row can be `position: sticky` and column
 * widths are driven by a single `grid-template-columns` value updated on
 * resize.
 *
 * Row interaction (selection, keyboard nav, inline edit, context menu) is
 * shared with the list via the `useTrackerRows` hook.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FloatingPortal } from '@floating-ui/react';
import { useAtomValue } from 'jotai';
import type { TrackerItemType } from '../../../core/DocumentService';
import type { TrackerRecord } from '../../../core/TrackerRecord';
import { trackerItemsByTypeAtom, trackerDataLoadedAtom } from '../trackerDataAtoms';
import {
  getRecordTitle,
  getRecordStatus,
  getRecordPriority,
  getFieldByRole,
  resolveRoleFieldName,
} from '../trackerRecordAccessors';
import { globalRegistry } from '../models';
import {
  resolveColumnsForType,
  getDefaultColumnConfig,
  getStatusColor,
  getPriorityColor,
  getTypeColor,
  getTypeIcon,
  getCellValue,
  type TrackerColumnDef,
  type TypeColumnConfig,
} from './trackerColumns';
import { DisplayOptionsPanel } from './DisplayOptionsPanel';
import { useTrackerRows } from './useTrackerRows';
import { renderCell, ContextSubmenu, TrackerGroupHeader } from './TrackerTable';
import type { SortColumn, SortDirection } from './TrackerTable';
import { groupTrackerItems, normalizeTrackerGroupBy } from '../trackerGrouping';

interface TrackerTableGridProps {
  filterType?: TrackerItemType | 'all';
  sortBy?: SortColumn;
  sortDirection?: SortDirection;
  onSortChange?: (column: SortColumn, direction: SortDirection) => void;
  hideTypeTabs?: boolean;
  onSwitchToFilesMode?: () => void;
  onNewItem?: (type: TrackerItemType) => void;
  onItemSelect?: (itemId: string) => void;
  selectedItemId?: string | null;
  overrideItems?: TrackerRecord[];
  onArchiveItems?: (itemIds: string[], archive: boolean) => void;
  onDeleteItems?: (itemIds: string[]) => void;
  onCopyDeepLink?: (itemId: string) => void;
  searchQuery?: string;
  columnConfig?: TypeColumnConfig;
  onColumnConfigChange?: (config: TypeColumnConfig) => void;
}

/** Default minimum width for a column without an explicit minWidth. */
const DEFAULT_MIN_COLUMN_WIDTH = 60;
/** Default px width for an `auto` (title) column when no override is stored. */
const DEFAULT_AUTO_COLUMN_WIDTH = 280;

export function TrackerTableGrid({
  filterType = 'all',
  sortBy = 'lastIndexed',
  sortDirection = 'desc',
  onSortChange,
  onSwitchToFilesMode,
  onNewItem,
  onItemSelect,
  selectedItemId,
  overrideItems,
  onArchiveItems,
  onDeleteItems,
  onCopyDeepLink,
  searchQuery: externalSearchQuery,
  columnConfig: externalColumnConfig,
  onColumnConfigChange,
}: TrackerTableGridProps): JSX.Element {
  const activeTypeFilter: TrackerItemType | 'all' = filterType;
  const [showDisplayOptions, setShowDisplayOptions] = useState(false);
  const [currentSortBy, setCurrentSortBy] = useState<SortColumn>(sortBy);
  const [currentSortDirection, setCurrentSortDirection] = useState<SortDirection>(sortDirection);

  // Column configuration
  const effectiveColumnConfig = useMemo(() => {
    if (externalColumnConfig) return externalColumnConfig;
    return getDefaultColumnConfig(activeTypeFilter === 'all' ? '' : activeTypeFilter);
  }, [externalColumnConfig, activeTypeFilter]);

  const allColumns = useMemo(() => {
    return resolveColumnsForType(activeTypeFilter === 'all' ? '' : activeTypeFilter);
  }, [activeTypeFilter]);

  const visibleColumnDefs = useMemo(() => {
    return effectiveColumnConfig.visibleColumns
      .map(id => allColumns.find(c => c.id === id))
      .filter((c): c is TrackerColumnDef => c !== undefined);
  }, [effectiveColumnConfig.visibleColumns, allColumns]);

  // Source items (atom or override)
  const atomItems = useAtomValue(trackerItemsByTypeAtom(activeTypeFilter));
  const dataLoaded = useAtomValue(trackerDataLoadedAtom);
  const sourceItems = overrideItems ?? atomItems;

  const items = useMemo(() => {
    return sourceItems.map((item: TrackerRecord) => {
      const dateSource = item.system.updatedAt || item.system.createdAt;
      let actualDate: Date | null = null;
      if (dateSource) {
        const parsed = new Date(dateSource);
        if (!isNaN(parsed.getTime())) actualDate = parsed;
      }
      const lastIndexed = actualDate ? actualDate.toISOString() : (item.system.lastIndexed || new Date(0).toISOString());
      return { ...item, system: { ...item.system, lastIndexed } };
    });
  }, [sourceItems]);

  const loading = !dataLoaded && items.length === 0;
  const searchTerm = externalSearchQuery ?? '';

  // Filter
  const filteredItems = useMemo(() => {
    return items.filter(item => {
      if (searchTerm) {
        const q = searchTerm.toLowerCase();
        const matches =
          item.issueKey?.toLowerCase().includes(q) ||
          String(item.issueNumber ?? '').includes(q) ||
          getRecordTitle(item).toLowerCase().includes(q) ||
          (item.system.documentPath ?? '').toLowerCase().includes(q) ||
          (String(getFieldByRole(item, 'assignee') ?? '')).toLowerCase().includes(q) ||
          (Array.isArray(getFieldByRole(item, 'tags')) && (getFieldByRole(item, 'tags') as string[]).some((tag: string) => tag.toLowerCase().includes(q)));
        if (!matches) return false;
      }
      if (activeTypeFilter !== 'all' && item.primaryType !== activeTypeFilter) return false;
      return true;
    });
  }, [items, searchTerm, activeTypeFilter]);

  // Sort
  const sortedItems = useMemo(() => {
    const sorted = [...filteredItems].sort((a, b) => {
      let compareValue = 0;
      switch (currentSortBy) {
        case 'type':
          compareValue = a.primaryType.localeCompare(b.primaryType);
          break;
        case 'module':
          compareValue = (a.system.documentPath ?? '').localeCompare(b.system.documentPath ?? '');
          break;
        case 'lastIndexed': {
          const aTime = a.system.lastIndexed ? new Date(a.system.lastIndexed).getTime() : 0;
          const bTime = b.system.lastIndexed ? new Date(b.system.lastIndexed).getTime() : 0;
          compareValue = aTime - bTime;
          break;
        }
        default: {
          const aVal = getCellValue(a, currentSortBy);
          const bVal = getCellValue(b, currentSortBy);
          if (aVal == null && bVal == null) { compareValue = 0; break; }
          if (aVal == null) { compareValue = 1; break; }
          if (bVal == null) { compareValue = -1; break; }
          if (aVal instanceof Date && bVal instanceof Date) { compareValue = aVal.getTime() - bVal.getTime(); break; }
          if (typeof aVal === 'number' && typeof bVal === 'number') { compareValue = aVal - bVal; break; }
          compareValue = String(aVal).localeCompare(String(bVal));
          break;
        }
      }
      return currentSortDirection === 'asc' ? compareValue : -compareValue;
    });
    return sorted;
  }, [filteredItems, currentSortBy, currentSortDirection]);
  const activeGroupBy = normalizeTrackerGroupBy(effectiveColumnConfig.groupBy);
  const isGrouped = activeGroupBy !== 'none';
  const groupedItems = useMemo(
    () => groupTrackerItems(sortedItems, activeGroupBy),
    [sortedItems, activeGroupBy],
  );
  const rowIndexById = useMemo(() => {
    return new Map(sortedItems.map((item, index) => [item.id, index]));
  }, [sortedItems]);

  // Row interaction (shared with TrackerTable)
  const rows = useTrackerRows({
    items: sortedItems,
    activeTypeFilter,
    onItemSelect,
    onDeleteItems,
    onArchiveItems,
    onSwitchToFilesMode,
  });

  const {
    selectedIds,
    setSelectedIds,
    focusedIndex,
    containerRef,
    editingCell,
    setEditingCell,
    editingTitle,
    setEditingTitle,
    titleInputRef,
    handleFieldUpdate,
    isItemEditable,
    handleRowClick,
    openItemInEditor,
    contextAnchor,
    contextRefs,
    contextFloatingStyles,
    handleContextMenu,
    closeContextMenu,
    handleBulkStatusUpdate,
    handleBulkPriorityUpdate,
  } = rows;

  // Compute grid-template-columns from visible columns + persisted widths.
  // `'auto'` columns (the title) flex to fill the window via minmax(min, 1fr)
  // unless the user has dragged them to an explicit width. All other columns
  // are fixed px so the grid scrolls horizontally when content overflows.
  const gridTemplate = useMemo(() => {
    return visibleColumnDefs.map(col => {
      const override = effectiveColumnConfig.columnWidths[col.id];
      if (typeof override === 'number') return `${override}px`;
      if (typeof col.width === 'number') return `${col.width}px`;
      const min = col.minWidth ?? DEFAULT_AUTO_COLUMN_WIDTH;
      return `minmax(${min}px, 1fr)`;
    }).join(' ');
  }, [visibleColumnDefs, effectiveColumnConfig.columnWidths]);

  // Column resize state -- ref-based to avoid re-render churn during drag.
  const dragStateRef = useRef<{ colId: string; startX: number; startWidth: number } | null>(null);
  const [livePreview, setLivePreview] = useState<{ colId: string; width: number } | null>(null);

  const startResize = useCallback((col: TrackerColumnDef, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = effectiveColumnConfig.columnWidths[col.id]
      ?? (typeof col.width === 'number' ? col.width : DEFAULT_AUTO_COLUMN_WIDTH);
    dragStateRef.current = { colId: col.id, startX, startWidth };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const minWidth = col.minWidth ?? DEFAULT_MIN_COLUMN_WIDTH;

    const handleMove = (ev: MouseEvent) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const newWidth = Math.max(minWidth, drag.startWidth + (ev.clientX - drag.startX));
      setLivePreview({ colId: drag.colId, width: newWidth });
    };

    const handleUp = (ev: MouseEvent) => {
      const drag = dragStateRef.current;
      dragStateRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      setLivePreview(null);
      if (!drag) return;
      const newWidth = Math.max(minWidth, drag.startWidth + (ev.clientX - drag.startX));
      if (newWidth !== drag.startWidth && onColumnConfigChange) {
        onColumnConfigChange({
          ...effectiveColumnConfig,
          columnWidths: { ...effectiveColumnConfig.columnWidths, [drag.colId]: newWidth },
        });
      }
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  }, [effectiveColumnConfig, onColumnConfigChange]);

  // Apply live preview to the grid template during a drag
  const liveGridTemplate = useMemo(() => {
    if (!livePreview) return gridTemplate;
    return visibleColumnDefs.map(col => {
      if (col.id === livePreview.colId) return `${livePreview.width}px`;
      const override = effectiveColumnConfig.columnWidths[col.id];
      if (typeof override === 'number') return `${override}px`;
      if (typeof col.width === 'number') return `${col.width}px`;
      const min = col.minWidth ?? DEFAULT_AUTO_COLUMN_WIDTH;
      return `minmax(${min}px, 1fr)`;
    }).join(' ');
  }, [livePreview, gridTemplate, visibleColumnDefs, effectiveColumnConfig.columnWidths]);

  const handleColumnClick = useCallback((col: TrackerColumnDef) => {
    if (!col.sortable) return;
    const sortKey = (col.sortKey ?? col.id) as SortColumn;
    const newDirection = currentSortBy === sortKey && currentSortDirection === 'desc' ? 'asc' : 'desc';
    setCurrentSortBy(sortKey);
    setCurrentSortDirection(newDirection);
    onSortChange?.(sortKey, newDirection);
  }, [currentSortBy, currentSortDirection, onSortChange]);

  const getSortIndicator = useCallback((col: TrackerColumnDef): React.ReactNode => {
    const sortKey = col.sortKey ?? col.id;
    if (currentSortBy !== sortKey) return null;
    return (
      <span className="ml-1 text-[var(--nim-primary)] text-sm">
        {currentSortDirection === 'desc' ? '↓' : '↑'}
      </span>
    );
  }, [currentSortBy, currentSortDirection]);

  // Keep currentSort* in sync with prop changes (parent may reset on type switch)
  useEffect(() => { setCurrentSortBy(sortBy); }, [sortBy]);
  useEffect(() => { setCurrentSortDirection(sortDirection); }, [sortDirection]);

  if (loading && items.length === 0) {
    return (
      <div className="tracker-table-grid-loading flex flex-col items-center justify-center py-[60px] px-5 text-[var(--nim-text-muted)] text-center gap-3">
        <div className="spinner w-8 h-8 border-[3px] border-[var(--nim-border)] border-t-[var(--nim-primary)] rounded-full animate-spin"></div>
        <span>Loading tracker items...</span>
      </div>
    );
  }

  return (
    <div
      className="tracker-table-grid-wrapper flex flex-col h-full w-full bg-[var(--nim-bg)]"
      data-testid="tracker-table-grid"
    >
      {/* Display options panel */}
      {showDisplayOptions && onColumnConfigChange && (
        <div className="relative">
          <DisplayOptionsPanel
            availableColumns={allColumns}
            config={effectiveColumnConfig}
            onConfigChange={(config) => onColumnConfigChange(config)}
            onClose={() => setShowDisplayOptions(false)}
          />
        </div>
      )}

      {/* Toolbar -- mirrors the list view's tune button + count */}
      {items.length > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--nim-border)] bg-[var(--nim-bg)]">
          <div className="flex-1" />
          {onColumnConfigChange && (
            <button
              className="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-faint)] hover:text-[var(--nim-text)] transition-colors"
              onClick={() => setShowDisplayOptions(!showDisplayOptions)}
              title="Display options"
              data-testid="tracker-table-grid-tune"
            >
              <span className="material-symbols-outlined text-sm">tune</span>
            </button>
          )}
          <span className="text-[11px] text-[var(--nim-text-faint)]">
            {sortedItems.length} item{sortedItems.length !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {/* Scroll container */}
      <div
        ref={containerRef}
        tabIndex={0}
        className="tracker-table-grid-scroll flex-1 overflow-auto outline-none"
      >
        {sortedItems.length === 0 ? (
          <div className="tracker-table-grid-empty flex items-center justify-center gap-2 py-6 px-6">
            <p className="text-sm text-[var(--nim-text-muted)] m-0">No tracker items found</p>
            {activeTypeFilter !== 'all' && onNewItem && globalRegistry.get(activeTypeFilter)?.creatable !== false && (
              <button
                className="px-3 py-1.5 rounded-md text-xs font-medium text-white border-none cursor-pointer transition-all duration-150 hover:opacity-90"
                style={{ backgroundColor: getTypeColor(activeTypeFilter) }}
                onClick={() => onNewItem(activeTypeFilter as TrackerItemType)}
              >
                <span className="flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">add</span>
                  New {activeTypeFilter.charAt(0).toUpperCase() + activeTypeFilter.slice(1)}
                </span>
              </button>
            )}
          </div>
        ) : (
          // min-width: max-content lets the grid overflow horizontally when the
          // sum of fixed column widths exceeds the container.
          <div
            className="grid"
            style={{
              gridTemplateColumns: liveGridTemplate,
              minWidth: 'max-content',
            }}
          >
            {/* Sticky header row */}
            {visibleColumnDefs.map((col, idx) => {
              const isLast = idx === visibleColumnDefs.length - 1;
              const isSorted = (col.sortKey ?? col.id) === currentSortBy;
              return (
                <div
                  key={`header-${col.id}`}
                  data-testid="tracker-table-grid-header-cell"
                  data-column-id={col.id}
                  className={`tracker-table-grid-header-cell sticky top-0 z-10 flex items-center px-3 py-1.5 bg-[var(--nim-bg-secondary)] border-b border-[var(--nim-border)] text-[11px] font-semibold uppercase tracking-wider select-none ${
                    col.sortable ? 'cursor-pointer hover:bg-[var(--nim-bg-tertiary)]' : ''
                  } ${isSorted ? 'text-[var(--nim-text)]' : 'text-[var(--nim-text-muted)]'} relative`}
                  onClick={() => handleColumnClick(col)}
                >
                  <span className="truncate">{col.label}</span>
                  {getSortIndicator(col)}
                  {!isLast && (
                    <div
                      className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-[var(--nim-primary)] z-20"
                      onMouseDown={(e) => startResize(col, e)}
                      onClick={(e) => e.stopPropagation()}
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${col.label} column`}
                    />
                  )}
                </div>
              );
            })}

            {isGrouped ? (
              groupedItems.map((group) => (
                <React.Fragment key={`${activeGroupBy}:${group.key || 'empty'}`}>
                  <TrackerGroupHeader
                    label={group.label}
                    count={group.items.length}
                    style={{ gridColumn: '1 / -1' }}
                  />
                  {group.items.map((item) => (
                    <GridRow
                      key={item.id}
                      item={item}
                      rowIndex={rowIndexById.get(item.id) ?? 0}
                      columns={visibleColumnDefs}
                      selectedIds={selectedIds}
                      selectedItemId={selectedItemId}
                      focusedIndex={focusedIndex}
                      editingCell={editingCell}
                      setEditingCell={setEditingCell}
                      editingTitle={editingTitle}
                      setEditingTitle={setEditingTitle}
                      titleInputRef={titleInputRef}
                      handleFieldUpdate={handleFieldUpdate}
                      isItemEditable={isItemEditable}
                      handleRowClick={handleRowClick}
                      handleContextMenu={handleContextMenu}
                      openItemInEditor={openItemInEditor}
                    />
                  ))}
                </React.Fragment>
              ))
            ) : (
              sortedItems.map((item, rowIndex) => (
                <GridRow
                  key={item.id || rowIndex}
                  item={item}
                  rowIndex={rowIndex}
                  columns={visibleColumnDefs}
                  selectedIds={selectedIds}
                  selectedItemId={selectedItemId}
                  focusedIndex={focusedIndex}
                  editingCell={editingCell}
                  setEditingCell={setEditingCell}
                  editingTitle={editingTitle}
                  setEditingTitle={setEditingTitle}
                  titleInputRef={titleInputRef}
                  handleFieldUpdate={handleFieldUpdate}
                  isItemEditable={isItemEditable}
                  handleRowClick={handleRowClick}
                  handleContextMenu={handleContextMenu}
                  openItemInEditor={openItemInEditor}
                />
              ))
            )}
          </div>
        )}
      </div>

      {/* Context menu -- same structure as TrackerTable's */}
      {contextAnchor && selectedIds.size > 0 && (
        <FloatingPortal>
          <div
            ref={contextRefs.setFloating}
            className="z-50 min-w-[180px] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md shadow-lg py-1 text-[13px]"
            style={contextFloatingStyles}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 py-1 text-[11px] text-[var(--nim-text-faint)] font-medium">
              {selectedIds.size} item{selectedIds.size > 1 ? 's' : ''} selected
            </div>
            <div className="border-b border-[var(--nim-border)] my-1" />

            <ContextSubmenu label="Set Status" icon="swap_horiz">
              {(() => {
                const tracker = activeTypeFilter !== 'all' ? globalRegistry.get(activeTypeFilter) : null;
                const statusFieldName = activeTypeFilter !== 'all' ? resolveRoleFieldName(activeTypeFilter, 'workflowStatus') : 'status';
                const statusField = tracker?.fields.find(f => f.name === statusFieldName);
                const rawOptions: Array<string | { value: string; label: string }> = statusField?.options || [
                  { value: 'to-do', label: 'To Do' },
                  { value: 'in-progress', label: 'In Progress' },
                  { value: 'in-review', label: 'In Review' },
                  { value: 'done', label: 'Done' },
                  { value: 'blocked', label: 'Blocked' },
                ];
                return rawOptions.map(opt => {
                  const val = typeof opt === 'string' ? opt : opt.value;
                  const label = typeof opt === 'string'
                    ? opt.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
                    : opt.label;
                  return (
                    <button
                      key={val}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
                      onClick={() => handleBulkStatusUpdate(val)}
                    >
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: getStatusColor(val, activeTypeFilter !== 'all' ? activeTypeFilter : undefined) }}
                      />
                      {label}
                    </button>
                  );
                });
              })()}
            </ContextSubmenu>

            <ContextSubmenu label="Set Priority" icon="flag">
              {['critical', 'high', 'medium', 'low'].map(p => (
                <button
                  key={p}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
                  onClick={() => handleBulkPriorityUpdate(p)}
                >
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: getPriorityColor(p) }}
                  />
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </ContextSubmenu>

            <div className="border-b border-[var(--nim-border)] my-1" />

            {onCopyDeepLink && selectedIds.size === 1 && (
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
                onClick={() => {
                  const [onlyId] = selectedIds;
                  closeContextMenu();
                  onCopyDeepLink(onlyId);
                }}
              >
                <span className="material-symbols-outlined text-sm">link</span>
                Copy Link
              </button>
            )}

            {onArchiveItems && (
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
                onClick={() => {
                  closeContextMenu();
                  onArchiveItems(Array.from(selectedIds), true);
                  setSelectedIds(new Set());
                }}
              >
                <span className="material-symbols-outlined text-sm">archive</span>
                Archive
              </button>
            )}

            {onDeleteItems && (
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[#ef4444] hover:bg-[var(--nim-bg-hover)] cursor-pointer"
                onClick={() => {
                  closeContextMenu();
                  const ids = Array.from(selectedIds);
                  if (window.confirm(`Delete ${ids.length} item${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) {
                    onDeleteItems(ids);
                    setSelectedIds(new Set());
                  }
                }}
              >
                <span className="material-symbols-outlined text-sm">delete</span>
                Delete
              </button>
            )}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}

/**
 * A single body row, rendered with `display: contents` so its cells
 * participate directly in the parent grid template.
 */
interface GridRowProps {
  item: TrackerRecord;
  rowIndex: number;
  columns: TrackerColumnDef[];
  selectedIds: Set<string>;
  selectedItemId?: string | null;
  focusedIndex: number;
  editingCell: { itemId: string; field: 'status' | 'priority' | 'title' } | null;
  setEditingCell: (cell: { itemId: string; field: 'status' | 'priority' | 'title' } | null) => void;
  editingTitle: string;
  setEditingTitle: (t: string) => void;
  titleInputRef: React.RefObject<HTMLInputElement>;
  handleFieldUpdate: (item: TrackerRecord, field: string, value: string) => Promise<void>;
  isItemEditable: (item: TrackerRecord) => boolean;
  handleRowClick: (item: TrackerRecord, index: number, e: React.MouseEvent) => void;
  handleContextMenu: (e: React.MouseEvent, item: TrackerRecord, index: number) => void;
  openItemInEditor: (item: TrackerRecord) => void;
}

function GridRow({
  item,
  rowIndex,
  columns,
  selectedIds,
  selectedItemId,
  focusedIndex,
  editingCell,
  setEditingCell,
  editingTitle,
  setEditingTitle,
  titleInputRef,
  handleFieldUpdate,
  isItemEditable,
  handleRowClick,
  handleContextMenu,
  openItemInEditor,
}: GridRowProps): JSX.Element {
  const isSelected = selectedIds.has(item.id) || (!!selectedItemId && item.id === selectedItemId);
  const isFocused = focusedIndex === rowIndex;

  // Selection highlight + focus outline are rendered on every cell since
  // `display: contents` rows can't carry their own background or border.
  const baseCellClass = `tracker-table-grid-cell flex items-center px-3 py-1.5 border-b border-[var(--nim-border)] cursor-pointer transition-colors duration-100 select-none ${
    isSelected ? 'bg-[var(--nim-bg-secondary)]' : 'hover:bg-[var(--nim-bg-secondary)]'
  } ${isFocused ? 'outline outline-1 outline-[var(--nim-primary)] -outline-offset-1' : ''}`;

  return (
    <div
      role="row"
      data-testid="tracker-table-grid-row"
      data-item-id={item.id}
      data-item-title={item.fields.title as string}
      className="contents"
    >
      {columns.map(col => {
        const value = getCellValue(item, col.id);
        const rendered = col.id === 'type' ? (
          <span
            className="flex items-center justify-center w-5 h-5"
            style={{ color: getTypeColor(item.primaryType), opacity: 0.85 }}
          >
            <span
              className="material-symbols-outlined"
              style={{ fontSize: '16px', fontVariationSettings: "'wght' 300" }}
            >
              {getTypeIcon(item.primaryType)}
            </span>
          </span>
        ) : (
          renderCell(col, item, value, editingCell, isItemEditable, setEditingCell, editingTitle, setEditingTitle, titleInputRef, handleFieldUpdate)
        );
        return (
          <div
            key={`${item.id}-${col.id}`}
            data-testid="tracker-table-grid-cell"
            data-column-id={col.id}
            className={`${baseCellClass} min-w-0`}
            onClick={(e) => handleRowClick(item, rowIndex, e)}
            onDoubleClick={() => { if (item.system.documentPath) openItemInEditor(item); }}
            onContextMenu={(e) => handleContextMenu(e, item, rowIndex)}
          >
            <div className="min-w-0 w-full truncate">{rendered}</div>
          </div>
        );
      })}
    </div>
  );
}
