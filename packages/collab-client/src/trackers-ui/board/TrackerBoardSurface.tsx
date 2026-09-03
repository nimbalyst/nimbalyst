/**
 * The kanban board, with native HTML5 drag-and-drop when a mutation callback is
 * supplied.
 *
 * Lanes and card order come from `buildTrackerBoardColumns` /
 * `groupItemsIntoBoardColumns`, the same pure derivation desktop's board uses,
 * so the two hosts cannot disagree about which lane a card belongs in or how a
 * lane is ordered.
 *
 * `resolveBoardDrop` computes the exact field write. The interaction reuses the
 * same React-free document listener as desktop, including its
 * `data-card-index` rule for virtualized columns. Persistence stays outside this
 * component so both hosts route the write through their `TrackerDataSource`.
 *
 * This is the browser's board. It passes no `unreadSlot` and no `favoriteSlot`,
 * which is why neither personal-lane module reaches the browser bundle at all.
 * Desktop renders `TrackerBoardCard` from its own `KanbanBoard` and fills them.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { TrackerIdentity } from '@nimbalyst/runtime/core/DocumentService';
import type {
  TrackerGroupBy,
  TrackerOrdering,
  TrackerRelationshipLabelResolver,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  buildTrackerBoardColumns,
  groupItemsIntoBoardColumns,
  resolveBoardAxis,
  resolveBoardDrop,
  type TrackerStatusScope,
} from '@nimbalyst/collab-client/trackers';
import { getStatusColor } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerColumns';
import { TrackerSurfaceMessage } from '../primitives/TrackerSurfaceMessage';
import { NEUTRAL_SWATCH } from './trackerBoardTokens';
import { TrackerBoardCard } from './TrackerBoardCard';
import { registerKanbanDragCallbacks } from './kanbanDragListeners';

export interface TrackerBoardSurfaceProps {
  rows: TrackerRecord[];
  trackerType: string;
  groupBy: TrackerGroupBy;
  ordering: TrackerOrdering;
  statusScope?: TrackerStatusScope;
  resolveRelationshipLabel?: TrackerRelationshipLabelResolver;
  selectedItemIds?: ReadonlySet<string>;
  highlightedItemId?: string | null;
  onToggleSelected?: (itemId: string) => void;
  onOpenItem: (itemId: string) => void;
  /** Omit for a read-only permission state. */
  onItemUpdate?: (item: TrackerRecord, updates: Record<string, unknown>) => Promise<unknown> | unknown;
  currentIdentity?: TrackerIdentity | null;
}

const NO_SELECTION: ReadonlySet<string> = new Set<string>();

export function TrackerBoardSurface({
  rows,
  trackerType,
  groupBy,
  ordering,
  statusScope = 'all',
  resolveRelationshipLabel,
  selectedItemIds = NO_SELECTION,
  highlightedItemId = null,
  onToggleSelected,
  onOpenItem,
  onItemUpdate,
  currentIdentity,
}: TrackerBoardSurfaceProps) {
  const [dragItemId, setDragItemId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const dragItemRef = useRef<TrackerRecord | null>(null);
  const dragSourceColumnRef = useRef<string | null>(null);
  const dragOverColumnRef = useRef<string | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const axis = resolveBoardAxis(groupBy);
  const columns = useMemo(
    () => buildTrackerBoardColumns(groupBy, trackerType, rows, resolveRelationshipLabel, statusScope),
    [groupBy, trackerType, rows, resolveRelationshipLabel, statusScope],
  );
  const grouped = useMemo(
    () => groupItemsIntoBoardColumns(rows, columns, axis, ordering),
    [rows, columns, axis, ordering],
  );

  const clearDrag = useCallback(() => {
    setDragItemId(null);
    setDragOverColumn(null);
    setDropIndex(null);
    dragItemRef.current = null;
    dragSourceColumnRef.current = null;
    dragOverColumnRef.current = null;
    dropIndexRef.current = null;
  }, []);

  const handleDragStart = useCallback((
    event: React.DragEvent,
    item: TrackerRecord,
    columnKey: string,
  ) => {
    setMutationError(null);
    setDragItemId(item.id);
    dragItemRef.current = item;
    dragSourceColumnRef.current = columnKey;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
  }, []);

  useEffect(() => {
    if (!onItemUpdate) return undefined;
    return registerKanbanDragCallbacks({
      onDragOver: (columnKey, index) => {
        dragOverColumnRef.current = columnKey;
        dropIndexRef.current = index;
        setDragOverColumn(columnKey);
        setDropIndex(index);
      },
      onDrop: () => {
        const item = dragItemRef.current;
        const sourceColumnKey = dragSourceColumnRef.current;
        const targetKey = dragOverColumnRef.current;
        const targetColumn = columns.find((column) => column.key === targetKey);
        const targetIndex = dropIndexRef.current;
        clearDrag();
        if (!item || !targetColumn) return;
        const updates = resolveBoardDrop({
          item,
          axis,
          sourceColumnKey,
          targetColumn,
          columnItems: grouped[targetColumn.key] ?? [],
          dropIndex: targetIndex,
        });
        if (!updates) return;
        void Promise.resolve(onItemUpdate(item, updates)).catch((cause) => {
          setMutationError(cause instanceof Error ? cause.message : String(cause));
        });
      },
      onDragLeave: () => {
        dragOverColumnRef.current = null;
        dropIndexRef.current = null;
        setDragOverColumn(null);
        setDropIndex(null);
      },
    });
  }, [axis, clearDrag, columns, grouped, onItemUpdate]);

  if (rows.length === 0) {
    return (
      <TrackerSurfaceMessage
        icon="view_kanban"
        message="No items to display"
        testId="tracker-kanban-empty"
      />
    );
  }

  return (
    <div
      className="tracker-kanban-board h-full flex flex-col overflow-hidden relative"
      data-testid="tracker-kanban-board"
    >
      {mutationError ? (
        <div className="tracker-kanban-mutation-error px-3 py-2 text-xs text-nim-error" role="alert">
          {mutationError}
        </div>
      ) : null}
      <div className="flex-1 flex gap-3 p-3 overflow-x-auto overflow-y-hidden min-h-0">
        {columns.map((column) => {
          const cards = grouped[column.key] ?? [];
          const color = axis === 'status' && column.value
            ? getStatusColor(column.value, trackerType)
            : NEUTRAL_SWATCH;
          return (
            <div
              key={column.key}
              data-testid={`tracker-kanban-column-${column.key}`}
              data-column-key={column.key}
              className={`tracker-kanban-column flex flex-col min-w-[260px] max-w-[320px] flex-1 min-h-0 rounded-lg bg-nim-secondary ${
                column.empty ? 'tracker-kanban-column-empty-bucket border border-dashed border-nim' : ''
              } ${dragOverColumn === column.key ? 'ring-1 ring-[var(--nim-primary)]' : ''}`}
            >
              <div className="flex items-center gap-2 px-3 py-2 border-b border-nim">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${column.empty ? 'border border-nim' : ''}`}
                  style={column.empty ? undefined : { backgroundColor: color }}
                />
                <span className="flex-1 truncate text-xs font-medium text-nim">{column.label}</span>
                <span className="text-[10px] font-semibold text-nim-faint">{cards.length}</span>
              </div>
              <div className="kanban-cards-container flex-1 overflow-y-auto px-1.5 pt-1.5 min-h-0">
                {cards.map((card, cardIndex) => (
                  <React.Fragment key={`${column.key}:${card.id}`}>
                    {dragOverColumn === column.key
                      && dropIndex === cardIndex
                      && dragItemId !== card.id ? (
                        <div className="h-[2px] bg-[var(--nim-primary)] rounded-full mx-1 my-0.5" />
                      ) : null}
                    <TrackerBoardCard
                      item={card}
                      columnKey={column.key}
                      cardIndex={cardIndex}
                      selected={selectedItemIds.has(card.id)}
                      highlighted={highlightedItemId === card.id}
                      dragging={dragItemId === card.id}
                      onDragStart={onItemUpdate ? handleDragStart : undefined}
                      onDragEnd={clearDrag}
                      onSelect={() => onOpenItem(card.id)}
                      onToggleSelected={(itemId) => onToggleSelected?.(itemId)}
                      onOpenDocument={onOpenItem}
                      currentIdentity={currentIdentity}
                    />
                    {cardIndex === cards.length - 1
                      && dragOverColumn === column.key
                      && dropIndex === cards.length ? (
                        <div className="h-[2px] bg-[var(--nim-primary)] rounded-full mx-1 my-0.5" />
                      ) : null}
                  </React.Fragment>
                ))}
                <div className="min-h-[40px]" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
