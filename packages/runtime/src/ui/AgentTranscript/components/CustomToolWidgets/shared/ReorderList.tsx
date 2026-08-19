/**
 * The shipped drag-to-rank list.
 *
 * Lifted verbatim out of `RequestUserInputWidget`, which is still its only
 * other caller, so the `reorder` field drags identically wherever it appears --
 * including the feedback respond surface, where a second implementation would
 * have meant a second set of iOS gesture bugs to rediscover.
 *
 * Presentation only: no atoms, no host, no transport. Callers own the ordering
 * state and hand it back down.
 */

import React, { useMemo } from 'react';
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

export interface ReorderListItem {
  id: string;
  title: string;
  subtitle?: string;
  removable?: boolean;
}

export interface ReorderListState {
  orderedIds: string[];
  removedIds: string[];
}

export interface ReorderListTestIds {
  root?: string;
  row?: string;
  remove?: string;
}

export interface ReorderListProps {
  /** The catalog, in any order; `orderedIds` decides what renders and where. */
  items: readonly ReorderListItem[];
  state: ReorderListState;
  onChange: (next: ReorderListState) => void;
  /** Removal stops once the list is this short. */
  minItems?: number;
  disabled?: boolean;
  /** Semantic kebab-case DOM marker for the list root. */
  rootClassName?: string;
  testIds?: ReorderListTestIds;
  /**
   * Optional content rendered at the end of each row, before the remove
   * button. Added for "rank these mockups", where each row needs a way to open
   * the thing being ranked; the list itself stays ignorant of what that is.
   */
  renderTrailing?: (itemId: string) => React.ReactNode;
}

interface ReorderRowProps {
  itemId: string;
  index: number;
  title: string;
  subtitle?: string;
  removable: boolean;
  canRemove: boolean;
  onRemove: () => void;
  disabled: boolean;
  testIds: ReorderListTestIds;
  trailing?: React.ReactNode;
}

function ReorderRow({
  itemId,
  index,
  title,
  subtitle,
  removable,
  canRemove,
  onRemove,
  disabled,
  testIds,
  trailing,
}: ReorderRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: itemId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // iOS WKWebView: the long-press text-selection callout will hijack a drag
  // gesture if we let any text on the row be selectable. Keep the row's
  // touchAction permissive (so vertical scroll still works on the transcript)
  // but disable selection and the callout outright.
  const rowStyle: React.CSSProperties = {
    ...style,
    WebkitUserSelect: 'none',
    userSelect: 'none',
    WebkitTouchCallout: 'none',
  };

  return (
    <div
      ref={setNodeRef}
      style={rowStyle}
      data-testid={testIds.row}
      data-item-id={itemId}
      data-dragging={isDragging || undefined}
      className={`reorder-list-row flex items-center gap-2.5 py-2 px-2.5 rounded border bg-nim-secondary ${
        isDragging ? 'border-nim-primary shadow-lg' : 'border-nim'
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        disabled={disabled}
        aria-label="Drag to reorder"
        // touch-action: none on the handle -- once the TouchSensor fires
        // (after the activation delay) the browser must NOT also try to
        // pan/scroll. Without this, iOS routes the gesture to scroll and
        // @dnd-kit cancels the drag mid-flight, snapping the row back to its
        // original position on release.
        style={{ touchAction: 'none' }}
        className="w-5 h-5 shrink-0 text-nim-faint cursor-grab disabled:cursor-not-allowed flex items-center justify-center"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="5" cy="3" r="1" fill="currentColor" />
          <circle cx="9" cy="3" r="1" fill="currentColor" />
          <circle cx="5" cy="7" r="1" fill="currentColor" />
          <circle cx="9" cy="7" r="1" fill="currentColor" />
          <circle cx="5" cy="11" r="1" fill="currentColor" />
          <circle cx="9" cy="11" r="1" fill="currentColor" />
        </svg>
      </button>
      <div className="w-6 text-center text-xs font-semibold text-nim-muted font-mono shrink-0">{index + 1}</div>
      <div className="flex-1 min-w-0">
        <div className="text-[0.8125rem] font-medium text-nim leading-snug">{title}</div>
        {subtitle && <div className="text-xs text-nim-muted leading-snug">{subtitle}</div>}
      </div>
      {trailing}
      {removable && (
        <button
          type="button"
          data-testid={testIds.remove}
          onClick={onRemove}
          disabled={disabled || !canRemove}
          aria-label="Remove item"
          className="w-6 h-6 shrink-0 rounded text-nim-faint hover:text-nim-error hover:bg-[color-mix(in_srgb,var(--nim-error)_12%,transparent)] disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 4h8M5 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M4 4l.5 7a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1L10 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

export const ReorderList: React.FC<ReorderListProps> = ({
  items,
  state,
  onChange,
  minItems,
  disabled = false,
  rootClassName,
  testIds = {},
  renderTrailing,
}) => {
  // Three sensors for cross-platform support:
  //  - MouseSensor (distance) for desktop click-drag
  //  - TouchSensor (delay) for iOS/Android long-press drag. The delay is what
  //    lets us coexist with the iOS text-selection callout: short taps still
  //    select text, but ~200ms holds initiate the drag and the activation
  //    swallows the touch so the OS doesn't pop the callout.
  //  - KeyboardSensor for accessibility
  // PointerSensor is intentionally NOT used here -- on iOS WKWebView its
  // default activation conflicts with the selection callout, which cancels
  // the drag and snaps items back to their original order.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const itemsById = useMemo(() => {
    const map = new Map<string, ReorderListItem>();
    for (const item of items) map.set(item.id, item);
    return map;
  }, [items]);

  const min = Math.max(minItems ?? 0, 0);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = state.orderedIds.indexOf(String(active.id));
    const newIndex = state.orderedIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    onChange({
      orderedIds: arrayMove(state.orderedIds, oldIndex, newIndex),
      removedIds: state.removedIds,
    });
  };

  const remove = (id: string) => {
    if (disabled) return;
    if (state.orderedIds.length <= min) return;
    onChange({
      orderedIds: state.orderedIds.filter((candidate) => candidate !== id),
      removedIds: [...state.removedIds, id],
    });
  };

  return (
    <div
      data-testid={testIds.root}
      className={`${rootClassName ? `${rootClassName} ` : ''}reorder-list flex flex-col gap-1.5`}
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={state.orderedIds} strategy={verticalListSortingStrategy}>
          {state.orderedIds.map((id, index) => {
            const item = itemsById.get(id);
            if (!item) return null;
            return (
              <ReorderRow
                key={id}
                itemId={id}
                index={index}
                title={item.title}
                subtitle={item.subtitle}
                removable={item.removable === true}
                canRemove={state.orderedIds.length > min}
                onRemove={() => remove(id)}
                disabled={disabled}
                testIds={testIds}
                trailing={renderTrailing?.(id)}
              />
            );
          })}
        </SortableContext>
      </DndContext>
      {state.removedIds.length > 0 && (
        <div className="text-[0.6875rem] text-nim-faint italic px-1">
          Removed: {state.removedIds.length} item{state.removedIds.length === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
};
