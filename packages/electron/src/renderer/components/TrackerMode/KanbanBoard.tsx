import React, { useEffect, useMemo, useCallback, useRef, useState } from 'react';
import { useFloating, offset, flip, shift, FloatingPortal } from '@floating-ui/react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { TrackerItemType } from '@nimbalyst/runtime/plugins/TrackerPlugin';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { getRecordTitle, getRecordStatus, getRecordPriority, getRecordSortOrder, getFieldByRole, buildKanbanStatusColumns, resolveRoleFieldName } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { generateKeyBetween } from '@nimbalyst/runtime/utils/fractionalIndex';
import { UserAvatar } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/UserAvatar';

// ── Module-level drag-and-drop handler ──────────────────────────────────
// Registered once on `document`, survives HMR. The component sets the
// callback ref that the handler invokes on drop.
type KanbanDropCallback = (targetStatus: string, dropIdx: number) => void;
type KanbanDragOverCallback = (colStatus: string, dropIdx: number) => void;

let _kanbanDropCb: KanbanDropCallback | null = null;
let _kanbanDragOverCb: KanbanDragOverCallback | null = null;
let _kanbanDragLeaveCb: (() => void) | null = null;
let _listenersAttached = false;

function ensureKanbanDragListeners() {
  if (_listenersAttached) return;
  _listenersAttached = true;

  document.addEventListener('dragover', (e: DragEvent) => {
    const colEl = (e.target as HTMLElement)?.closest?.('.tracker-kanban-column') as HTMLElement | null;
    if (!colEl) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

    const colStatus = colEl.dataset.columnStatus;
    if (!colStatus) return;

    const container = colEl.querySelector('.kanban-cards-container');
    if (!container) return;
    const cards = Array.from(container.querySelectorAll('.tracker-kanban-card'));
    let idx = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) { idx = i; break; }
    }

    _kanbanDragOverCb?.(colStatus, idx);
  });

  document.addEventListener('drop', (e: DragEvent) => {
    if (!(e.target as HTMLElement)?.closest?.('.tracker-kanban-board')) return;
    e.preventDefault();
    const colEl = (e.target as HTMLElement)?.closest?.('.tracker-kanban-column') as HTMLElement | null;
    const colStatus = colEl?.dataset?.columnStatus;
    // dropIdx is set by the last dragover; read from the component via callback
    _kanbanDropCb?.(colStatus || '', -1);
  });

  document.addEventListener('dragleave', (e: DragEvent) => {
    const colEl = (e.target as HTMLElement)?.closest?.('.tracker-kanban-column');
    if (colEl && !colEl.contains(e.relatedTarget as Node)) {
      _kanbanDragLeaveCb?.();
    }
  });
}

interface KanbanBoardProps {
  filterType: TrackerItemType | 'all';
  searchQuery?: string;
  onSwitchToFilesMode?: () => void;
  /** Callback when user clicks a card to select an item (opens detail panel) */
  onItemSelect?: (itemId: string) => void;
  /** Currently selected item ID for card highlighting */
  selectedItemId?: string | null;
  /** Override items instead of loading from documentService (used for filtered views) */
  overrideItems?: TrackerRecord[];
  /** Callback for bulk/single archive action */
  onArchiveItems?: (itemIds: string[], archive: boolean) => void;
  /** Callback for bulk/single delete action */
  onDeleteItems?: (itemIds: string[]) => void;
  /** Copy a shareable deep link for the given tracker item. Only shown when
   *  exactly one item is selected. Callers omit this when the workspace
   *  has no team configured. */
  onCopyDeepLink?: (itemId: string) => void;
}

const STATUS_COLORS: Record<string, string> = {
  'to-do': '#6b7280',
  'in-progress': '#eab308',
  'in-review': '#8b5cf6',
  'done': '#22c55e',
  'blocked': '#ef4444',
  "won't-fix": '#6b7280',
  'wont-fix': '#6b7280',
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#6b7280',
};

const TYPE_COLORS: Record<string, string> = {
  bug: '#dc2626',
  task: '#2563eb',
  plan: '#7c3aed',
  idea: '#ca8a04',
  decision: '#8b5cf6',
  feature: '#10b981',
};

export const KanbanBoard: React.FC<KanbanBoardProps> = ({
  filterType,
  searchQuery,
  onSwitchToFilesMode,
  onItemSelect,
  selectedItemId,
  overrideItems,
  onArchiveItems,
  onDeleteItems,
  onCopyDeepLink,
}) => {
  // Items always come from the caller (TrackerMainView passes atom-sourced items).
  // KanbanBoard no longer loads its own data -- single source of truth via Jotai atoms.
  const allItems = useMemo(() => {
    const source = overrideItems ?? [];
    if (!searchQuery) return source;
    const q = searchQuery.toLowerCase();
    return source.filter(
      record =>
        record.issueKey?.toLowerCase().includes(q) ||
        String(record.issueNumber ?? '').includes(q) ||
        getRecordTitle(record).toLowerCase().includes(q) ||
        record.system.documentPath?.toLowerCase().includes(q)
    );
  }, [searchQuery, overrideItems]);

  // Drag-and-drop state
  const [dragItemId, setDragItemId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const dragOverColumnRef = useRef<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const dragItemRef = useRef<TrackerRecord | null>(null);

  /** Update item fields via the appropriate API based on its source */
  const updateItemFields = useCallback(async (record: TrackerRecord, updates: Record<string, unknown>) => {
    try {
      // Separate kanbanSortOrder from other updates -- sort order is always
      // stored in the DB (not in source files), so it goes through updateTrackerItem.
      const { kanbanSortOrder, ...otherUpdates } = updates as Record<string, any>;

      // Update source file with non-sort-order fields (status, priority, etc.)
      if (Object.keys(otherUpdates).length > 0) {
        if (record.source === 'frontmatter' || record.source === 'import' || record.source === 'inline') {
          await window.electronAPI.documentService.updateTrackerItemInFile({
            itemId: record.id,
            updates: otherUpdates,
          });
        } else if (!record.system.documentPath || record.source === 'native') {
          const tracker = globalRegistry.get(record.primaryType);
          const syncMode = tracker?.sync?.mode || 'local';
          await window.electronAPI.documentService.updateTrackerItem({
            itemId: record.id,
            updates: otherUpdates,
            syncMode,
          });
        }
      }

      // Sort order always goes through the DB path
      if (kanbanSortOrder !== undefined) {
        const tracker = globalRegistry.get(record.primaryType);
        const syncMode = tracker?.sync?.mode || 'local';
        await window.electronAPI.documentService.updateTrackerItem({
          itemId: record.id,
          updates: { kanbanSortOrder },
          syncMode,
        });
      }
    } catch (err) {
      console.error('[KanbanBoard] Failed to update item:', err);
    }
  }, []);

  /** Convenience wrapper for status-only updates */
  const updateItemStatus = useCallback(async (record: TrackerRecord, newStatus: string) => {
    // Kanban columns are driven by workflowStatus, so writes must target the resolved field.
    const statusFieldName = resolveRoleFieldName(record.primaryType, 'workflowStatus');
    return updateItemFields(record, { [statusFieldName]: newStatus });
  }, [updateItemFields]);

  const handleDragStart = useCallback((e: React.DragEvent, item: TrackerRecord) => {
    // console.log('[KanbanBoard] dragStart:', item.id, getRecordTitle(item));
    setDragItemId(item.id);
    dragItemRef.current = item;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.id);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, columnValue: string) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDragOverColumn(columnValue);

    // Determine drop index by finding which card the cursor is above/below
    const cardsContainer = e.currentTarget.querySelector('.kanban-cards-container');
    if (!cardsContainer) { setDropIndex(null); return; }
    const cards = Array.from(cardsContainer.querySelectorAll('.tracker-kanban-card'));
    if (cards.length === 0) { setDropIndex(0); return; }

    const y = e.clientY;
    let idx = cards.length; // default: after last card
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (y < midY) {
        idx = i;
        break;
      }
    }
    dropIndexRef.current = idx;
    setDropIndex(idx);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOverColumn(null);
      setDropIndex(null);
    }
  }, []);

  const handleDragEnd = useCallback(() => {
    setDragItemId(null);
    setDragOverColumn(null);
    setDropIndex(null);
    dragItemRef.current = null;
  }, []);

  // Multi-select state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [contextAnchor, setContextAnchor] = useState<DOMRect | null>(null);
  const allItemsRef = useRef<TrackerRecord[]>([]);
  const lastClickedIdRef = useRef<string | null>(null);

  // Floating context menu
  const { refs: contextRefs, floatingStyles: contextFloatingStyles } = useFloating({
    placement: 'right-start',
    middleware: [offset(2), flip({ padding: 8 }), shift({ padding: 8 })],
  });
  useEffect(() => {
    if (contextAnchor) {
      contextRefs.setReference({ getBoundingClientRect: () => contextAnchor });
    }
  }, [contextAnchor, contextRefs]);

  // Keep ref in sync
  useEffect(() => { allItemsRef.current = allItems; }, [allItems]);

  const handleCardContextMenu = useCallback((e: React.MouseEvent, item: TrackerRecord) => {
    e.preventDefault();
    e.stopPropagation();
    // If right-clicking an unselected item, select just that item
    if (!selectedIds.has(item.id)) {
      setSelectedIds(new Set([item.id]));
    }
    setContextAnchor(DOMRect.fromRect({ x: e.clientX, y: e.clientY, width: 0, height: 0 }));
  }, [selectedIds]);

  const closeContextMenu = useCallback(() => setContextAnchor(null), []);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextAnchor) return;
    const handler = () => setContextAnchor(null);
    document.addEventListener('click', handler);
    document.addEventListener('contextmenu', handler);
    return () => {
      document.removeEventListener('click', handler);
      document.removeEventListener('contextmenu', handler);
    };
  }, [contextAnchor]);

  // Clear selection on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedIds(new Set());
        closeContextMenu();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [closeContextMenu]);

  /** Bulk status change from context menu */
  const handleBulkStatusUpdate = useCallback(async (newStatus: string) => {
    closeContextMenu();
    const items = allItemsRef.current.filter(i => selectedIds.has(i.id));
    for (const item of items) {
      await updateItemStatus(item, newStatus);
    }
  }, [selectedIds, closeContextMenu, updateItemStatus]);

  /** Bulk priority change from context menu */
  const handleBulkPriorityUpdate = useCallback(async (newPriority: string) => {
    closeContextMenu();
    const items = allItemsRef.current.filter(i => selectedIds.has(i.id));
    for (const item of items) {
      // Custom tracker types can map priority to a non-priority field.
      const priorityFieldName = resolveRoleFieldName(item.primaryType, 'priority');
      await updateItemFields(item, { [priorityFieldName]: newPriority });
    }
  }, [selectedIds, closeContextMenu, updateItemFields]);

  // Sort mode for kanban columns
  type KanbanSortMode = 'manual' | 'priority' | 'created' | 'updated';
  const [sortMode, setSortMode] = useState<KanbanSortMode>('manual');

  const columns = useMemo(() => buildKanbanStatusColumns(filterType, allItems), [filterType, allItems]);

  const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

  const itemsByStatus = useMemo(() => {
    const grouped: Record<string, TrackerRecord[]> = {};
    for (const col of columns) {
      grouped[col.value] = [];
    }

    for (const item of allItems) {
      const status = (getRecordStatus(item) || 'to-do').toLowerCase();
      if (grouped[status]) {
        grouped[status].push(item);
      } else {
        const firstCol = columns[0]?.value || 'to-do';
        grouped[firstCol] = grouped[firstCol] || [];
        grouped[firstCol].push(item);
      }
    }

    // Apply sort within each column
    for (const col of columns) {
      const items = grouped[col.value];
      if (!items || items.length <= 1) continue;
      items.sort((a, b) => {
        if (sortMode === 'manual') {
          const aKey = getRecordSortOrder(a) ?? '';
          const bKey = getRecordSortOrder(b) ?? '';
          // Use raw string comparison, not localeCompare -- fractional indexing
          // keys are designed to sort by character code order (0-9, A-Z, a-z).
          return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
        }
        if (sortMode === 'priority') {
            const pa = PRIORITY_ORDER[getRecordPriority(a) || 'medium'] ?? 2;
            const pb = PRIORITY_ORDER[getRecordPriority(b) || 'medium'] ?? 2;
            return pa - pb;
          }
          if (sortMode === 'created') {
            return new Date(b.system.createdAt).getTime() - new Date(a.system.createdAt).getTime();
          }
          if (sortMode === 'updated') {
            return new Date(b.system.updatedAt).getTime() - new Date(a.system.updatedAt).getTime();
          }
          return 0;
        });
      }

    return grouped;
  }, [allItems, columns, sortMode]);

  // Flat ordered list of item IDs (column by column) for shift-range selection
  const flatItemIds = useMemo(() => {
    const ids: string[] = [];
    for (const col of columns) {
      const colItems = itemsByStatus[col.value] || [];
      for (const item of colItems) {
        ids.push(item.id);
      }
    }
    return ids;
  }, [columns, itemsByStatus]);

  // Keep itemsByStatus in a ref so handleDrop doesn't depend on it (avoids stale closures)
  const itemsByStatusRef = useRef(itemsByStatus);
  useEffect(() => { itemsByStatusRef.current = itemsByStatus; }, [itemsByStatus]);

  /** Handle drop: supports both cross-column (status change) and within-column reorder */
  const handleDrop = useCallback((e: React.DragEvent, targetStatus: string) => {
    e.preventDefault();
    e.stopPropagation();
    const currentDropIndex = dropIndexRef.current;
    setDragOverColumn(null);
    setDropIndex(null);
    dropIndexRef.current = null;
    setDragItemId(null);

    const item = dragItemRef.current;
    dragItemRef.current = null;
    if (!item) {
      console.log('[KanbanBoard] drop: no item ref');
      return;
    }

    const currentStatus = (getRecordStatus(item) || 'to-do').toLowerCase();
    const targetColItems = (itemsByStatusRef.current[targetStatus] || []).filter(i => i.id !== item.id);
    const idx = currentDropIndex ?? targetColItems.length;

    // Compute new sort order key between neighbors
    const prevItem = idx > 0 ? targetColItems[idx - 1] : null;
    const nextItem = idx < targetColItems.length ? targetColItems[idx] : null;
    const prevKey = prevItem ? (getRecordSortOrder(prevItem) ?? null) : null;
    const nextKey = nextItem ? (getRecordSortOrder(nextItem) ?? null) : null;
    const newSortOrder = generateKeyBetween(prevKey, nextKey);

    console.log('[KanbanBoard] drop:', item.id, 'to', targetStatus, 'at', idx, 'key:', newSortOrder);

    if (currentStatus === targetStatus) {
      updateItemFields(item, { kanbanSortOrder: newSortOrder });
    } else {
      // Moving between columns is a workflowStatus update.
      const statusFieldName = resolveRoleFieldName(item.primaryType, 'workflowStatus');
      updateItemFields(item, { [statusFieldName]: targetStatus, kanbanSortOrder: newSortOrder });
    }
  }, [updateItemFields]);

  const handleCardSelect = useCallback((e: React.MouseEvent, item: TrackerRecord) => {
    e.stopPropagation();
    if (e.shiftKey && lastClickedIdRef.current) {
      // Range select between anchor and target
      const anchorIdx = flatItemIds.indexOf(lastClickedIdRef.current);
      const targetIdx = flatItemIds.indexOf(item.id);
      if (anchorIdx !== -1 && targetIdx !== -1) {
        const start = Math.min(anchorIdx, targetIdx);
        const end = Math.max(anchorIdx, targetIdx);
        const rangeIds = flatItemIds.slice(start, end + 1);
        if (e.metaKey || e.ctrlKey) {
          // Add range to existing selection
          setSelectedIds(prev => {
            const next = new Set(prev);
            for (const id of rangeIds) next.add(id);
            return next;
          });
        } else {
          // Replace with range
          setSelectedIds(new Set(rangeIds));
        }
      }
      // Don't update anchor on shift-click
    } else if (e.metaKey || e.ctrlKey) {
      // Toggle individual
      lastClickedIdRef.current = item.id;
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
    } else {
      // Replace selection and open detail
      lastClickedIdRef.current = item.id;
      setSelectedIds(new Set([item.id]));
      if (onItemSelect && item.id) {
        onItemSelect(item.id);
      }
    }
  }, [onItemSelect, flatItemIds]);

  // Register module-level drag-and-drop callbacks.
  // The listeners on `document` are attached once and survive HMR.
  // We just update the callbacks they invoke.
  useEffect(() => {
    ensureKanbanDragListeners();

    _kanbanDragOverCb = (colStatus: string, idx: number) => {
      dragOverColumnRef.current = colStatus;
      dropIndexRef.current = idx;
      setDragOverColumn(colStatus);
      setDropIndex(idx);
    };

    _kanbanDropCb = (_targetStatusFromEvent: string) => {
      const targetStatus = dragOverColumnRef.current;
      const currentDropIdx = dropIndexRef.current;

      dragOverColumnRef.current = null;
      setDragOverColumn(null);
      setDropIndex(null);
      dropIndexRef.current = null;
      setDragItemId(null);

      const item = dragItemRef.current;
      dragItemRef.current = null;
      if (!item || !targetStatus) return;

      const currentStatus = (getRecordStatus(item) || 'to-do').toLowerCase();
      const fullColItems = itemsByStatusRef.current[targetStatus] || [];
      const targetColItems = fullColItems.filter(i => i.id !== item.id);

      // Adjust drop index: onDragOver computed idx against the full card list
      // (including the dragged card). After filtering it out, we need to adjust
      // if the dragged card was positioned before the drop point.
      let idx = currentDropIdx ?? targetColItems.length;
      if (currentStatus === targetStatus) {
        const draggedOrigIdx = fullColItems.findIndex(i => i.id === item.id);
        if (draggedOrigIdx >= 0 && draggedOrigIdx < idx) {
          idx--;
        }
      }
      // Clamp to valid range
      idx = Math.max(0, Math.min(idx, targetColItems.length));

      const prevItem = idx > 0 ? targetColItems[idx - 1] : null;
      const nextItem = idx < targetColItems.length ? targetColItems[idx] : null;
      const prevKey = prevItem ? (getRecordSortOrder(prevItem) ?? null) : null;
      const nextKey = nextItem ? (getRecordSortOrder(nextItem) ?? null) : null;
      const newSortOrder = generateKeyBetween(prevKey, nextKey);

      if (currentStatus === targetStatus) {
        updateItemFields(item, { kanbanSortOrder: newSortOrder });
      } else {
        // Keep the document-level drop path aligned with the component drop path.
        const statusFieldName = resolveRoleFieldName(item.primaryType, 'workflowStatus');
        updateItemFields(item, { [statusFieldName]: targetStatus, kanbanSortOrder: newSortOrder });
      }
    };

    _kanbanDragLeaveCb = () => {
      setDragOverColumn(null);
      setDropIndex(null);
    };

    return () => {
      _kanbanDropCb = null;
      _kanbanDragOverCb = null;
      _kanbanDragLeaveCb = null;
    };
  });

  if (allItems.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-nim-muted">
        <div className="text-center">
          <MaterialSymbol icon="view_kanban" size={48} className="opacity-30" />
          <p className="mt-2 text-sm">No items to display</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tracker-kanban-board h-full flex flex-col overflow-hidden relative" data-testid="tracker-kanban-board">
      {/* Sort controls */}
      <div className="flex items-center gap-2 px-3 pt-2 pb-0">
        <span className="text-[11px] text-nim-faint">Sort:</span>
        {(['manual', 'priority', 'created', 'updated'] as const).map(mode => (
          <button
            key={mode}
            className={`text-[11px] px-2 py-0.5 rounded cursor-pointer transition-colors ${
              sortMode === mode
                ? 'bg-[var(--nim-primary)] text-white'
                : 'text-nim-muted hover:bg-nim-tertiary'
            }`}
            onClick={() => setSortMode(mode)}
          >
            {mode.charAt(0).toUpperCase() + mode.slice(1)}
          </button>
        ))}
      </div>
    <div className="flex-1 flex gap-3 p-3 overflow-x-auto overflow-y-hidden min-h-0">
      {columns.map((col) => {
        const colItems = itemsByStatus[col.value] || [];
        const color = STATUS_COLORS[col.value] || '#6b7280';

        return (
          <div
            key={col.value}
            data-testid={`tracker-kanban-column-${col.value}`}
            data-column-status={col.value}
            className={`tracker-kanban-column flex flex-col min-w-[260px] max-w-[320px] flex-1 min-h-0 rounded-lg transition-colors bg-nim-secondary ${
              dragOverColumn === col.value ? 'ring-1 ring-[var(--nim-primary)]' : ''
            }`}
          >
            {/* Column header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-nim">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: color }}
              />
              <span className="text-xs font-semibold text-nim truncate">
                {col.label}
              </span>
              <span className="text-[10px] font-semibold text-nim-faint ml-auto">
                {colItems.length}
              </span>
            </div>

            {/* Column cards */}
            <div className="kanban-cards-container flex-1 overflow-y-auto p-1.5">
              {colItems.map((item, cardIndex) => (
                <React.Fragment key={item.id}>
                  {/* Drop insertion line */}
                  {dragOverColumn === col.value && dropIndex === cardIndex && dragItemId !== item.id && (
                    <div className="h-[2px] bg-[var(--nim-primary)] rounded-full mx-1 my-0.5" />
                  )}
                <button
                  data-testid="tracker-kanban-card"
                  data-item-id={item.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, item)}
                  onDragEnd={handleDragEnd}
                  className={`tracker-kanban-card w-full text-left p-2.5 rounded-md bg-nim hover:bg-nim-tertiary border transition-colors cursor-grab active:cursor-grabbing mb-1.5 ${
                    dragItemId === item.id ? 'opacity-40' : ''
                  } ${
                    selectedIds.has(item.id) || (selectedItemId && item.id === selectedItemId)
                      ? 'border-[var(--nim-primary)]'
                      : 'border-nim'
                  }`}
                  onClick={(e) => handleCardSelect(e, item)}
                  onContextMenu={(e) => handleCardContextMenu(e, item)}
                >
                  <div className="flex items-start gap-2">
                    {/* Priority dot */}
                    <span
                      className="w-2 h-2 rounded-full mt-1.5 shrink-0"
                      style={{ backgroundColor: PRIORITY_COLORS[getRecordPriority(item) || 'medium'] || '#6b7280' }}
                    />
                    <div className="flex-1 min-w-0">
                      {item.issueKey && (
                        <div className="text-[10px] font-mono font-medium uppercase tracking-[0.08em] text-nim-faint mb-0.5">
                          {item.issueKey}
                        </div>
                      )}
                      <div className="text-sm text-nim leading-snug line-clamp-2">
                        {getRecordTitle(item)}
                      </div>
                      <div className="flex items-center gap-1.5 mt-1.5">
                        {/* Type badge */}
                        <span
                          className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                          style={{
                            color: TYPE_COLORS[item.primaryType] || '#6b7280',
                            backgroundColor: `${TYPE_COLORS[item.primaryType] || '#6b7280'}20`,
                          }}
                        >
                          {item.primaryType}
                        </span>
                        {/* Secondary type tags */}
                        {item.typeTags
                          .filter(tag => tag !== item.primaryType)
                          .map(tag => (
                            <span
                              key={tag}
                              className="text-[9px] font-medium px-1 py-0.5 rounded"
                              style={{
                                color: TYPE_COLORS[tag] || '#6b7280',
                                backgroundColor: `${TYPE_COLORS[tag] || '#6b7280'}12`,
                                border: `1px solid ${TYPE_COLORS[tag] || '#6b7280'}30`,
                              }}
                            >
                              {tag}
                            </span>
                          ))}
                        {/* Priority label */}
                        {(() => { const p = getRecordPriority(item); return p && p !== 'medium' ? (
                          <span
                            className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                            style={{
                              color: PRIORITY_COLORS[p] || '#6b7280',
                              backgroundColor: `${PRIORITY_COLORS[p] || '#6b7280'}20`,
                            }}
                          >
                            {p}
                          </span>
                        ) : null; })()}
                        {/* Owner avatar */}
                        {(() => {
                          const owner = getFieldByRole(item, 'assignee') as string | undefined;
                          return owner ? (
                            <span className="ml-auto">
                              <UserAvatar identity={owner} size={18} />
                            </span>
                          ) : null;
                        })()}
                      </div>
                    </div>
                  </div>
                </button>
                </React.Fragment>
              ))}
              {/* Drop indicator after last card */}
              {dragOverColumn === col.value && dropIndex === colItems.length && (
                <div className="h-[2px] bg-[var(--nim-primary)] rounded-full mx-1 my-0.5" />
              )}
              {/* Drop zone spacer -- ensures there's always a target area below the last card */}
              <div className="min-h-[40px]" />
            </div>
          </div>
        );
      })}
    </div>
      {/* Context menu */}
      {contextAnchor && selectedIds.size > 0 && (
        <FloatingPortal>
        <div
          ref={contextRefs.setFloating}
          className="z-50 min-w-[180px] bg-nim-secondary border border-nim rounded-md shadow-lg py-1 text-[13px]"
          style={contextFloatingStyles}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1 text-[11px] text-nim-faint font-medium">
            {selectedIds.size} item{selectedIds.size > 1 ? 's' : ''} selected
          </div>
          <div className="border-b border-nim my-1" />

          {/* Set Status */}
          <KanbanContextSubmenu label="Set Status" icon="swap_horiz">
            {columns.map(col => (
              <button
                key={col.value}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-nim hover:bg-nim-tertiary cursor-pointer"
                onClick={() => handleBulkStatusUpdate(col.value)}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: STATUS_COLORS[col.value] || '#6b7280' }}
                />
                {col.label}
              </button>
            ))}
          </KanbanContextSubmenu>

          {/* Set Priority */}
          <KanbanContextSubmenu label="Set Priority" icon="flag">
            {(['critical', 'high', 'medium', 'low'] as const).map(p => (
              <button
                key={p}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-nim hover:bg-nim-tertiary cursor-pointer"
                onClick={() => handleBulkPriorityUpdate(p)}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: PRIORITY_COLORS[p] || '#6b7280' }}
                />
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </button>
            ))}
          </KanbanContextSubmenu>

          <div className="border-b border-nim my-1" />

          {onCopyDeepLink && selectedIds.size === 1 && (
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-nim hover:bg-nim-tertiary cursor-pointer"
              onClick={() => {
                const [onlyId] = selectedIds;
                closeContextMenu();
                onCopyDeepLink(onlyId);
              }}
            >
              <MaterialSymbol icon="link" size={16} />
              Copy Link
            </button>
          )}

          {onArchiveItems && (
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-nim hover:bg-nim-tertiary cursor-pointer"
              onClick={() => {
                closeContextMenu();
                onArchiveItems(Array.from(selectedIds), true);
                setSelectedIds(new Set());
              }}
            >
              <MaterialSymbol icon="archive" size={16} />
              Archive
            </button>
          )}

          {onDeleteItems && (
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[#ef4444] hover:bg-nim-tertiary cursor-pointer"
              onClick={() => {
                closeContextMenu();
                const ids = Array.from(selectedIds);
                if (window.confirm(`Delete ${ids.length} item${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) {
                  onDeleteItems(ids);
                  setSelectedIds(new Set());
                }
              }}
            >
              <MaterialSymbol icon="delete" size={16} />
              Delete
            </button>
          )}
        </div>
        </FloatingPortal>
      )}
    </div>
  );
};

/** Context submenu with hover-expand for KanbanBoard */
const KanbanContextSubmenu: React.FC<{
  label: string;
  icon: string;
  children: React.ReactNode;
}> = ({ label, icon, children }) => {
  const [open, setOpen] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { refs, floatingStyles } = useFloating({
    placement: 'right-start',
    middleware: [offset(2), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  return (
    <div
      ref={refs.setReference as React.RefCallback<HTMLDivElement>}
      onMouseEnter={() => { if (timeoutRef.current) clearTimeout(timeoutRef.current); setOpen(true); }}
      onMouseLeave={() => { timeoutRef.current = setTimeout(() => setOpen(false), 150); }}
    >
      <div className="flex items-center gap-2 px-3 py-1.5 text-nim hover:bg-nim-tertiary cursor-pointer">
        <MaterialSymbol icon={icon} size={16} />
        <span className="flex-1">{label}</span>
        <MaterialSymbol icon="chevron_right" size={14} className="text-nim-faint" />
      </div>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            className="min-w-[140px] bg-nim-secondary border border-nim rounded-md shadow-lg py-1 z-[60]"
            style={floatingStyles}
            onMouseEnter={() => { if (timeoutRef.current) clearTimeout(timeoutRef.current); setOpen(true); }}
            onMouseLeave={() => { timeoutRef.current = setTimeout(() => setOpen(false), 150); }}
          >
            {children}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
};
