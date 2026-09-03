/**
 * One card on the tracker board.
 *
 * The DOM contract matters: the `tracker-kanban-card` class, `data-item-id` and
 * `data-card-index` are what the document-level drag handlers and the kanban E2E
 * spec address.
 *
 * The unread dot, the favorite star, and the milestone chip all arrive as slots
 * rather than imports. For the milestone chip that is a weight argument -- it
 * drags a picker, a relationship resolver, and a write path behind it. For the
 * other two it is a boundary: they ride the personal lane behind a personal JWT,
 * the browser holds team auth only, and a slot is the one shape that makes their
 * absence structural. A host with no personal lane has nothing to pass, so the
 * modules never enter its bundle graph and no future edit here can wire them up.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { TrackerIdentity } from '@nimbalyst/runtime/core/DocumentService';
import {
  getFieldByRole,
  getRecordExternalKey,
  getRecordPriority,
  getRecordTitle,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { UserAvatar } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/UserAvatar';
import { TrackerSwatchBadge } from '../primitives/TrackerSwatchBadge';
import { NEUTRAL_SWATCH, PRIORITY_COLORS, TYPE_COLORS } from './trackerBoardTokens';
import { TrackerCardStalenessChip } from './TrackerCardStalenessChip';
import { TrackerRecentActivityChip } from '../TrackerRecentActivityChip';
import './TrackerBoardCard.css';

export interface TrackerBoardCardProps {
  item: TrackerRecord;
  /**
   * The lane this rendering of the card sits in. A card in several milestones
   * renders once per lane, and the drop needs to know which copy was picked up.
   */
  columnKey: string;
  /**
   * Position within the column. Published to the DOM because the column is
   * virtualized: the drag handlers only see the mounted cards, so they cannot
   * infer an index from sibling order.
   */
  cardIndex: number;
  /** In the board's multi-selection; drives the checkbox. */
  selected: boolean;
  /** Open in the detail panel. Outlined like a selected card, but not checked. */
  highlighted: boolean;
  dragging: boolean;
  onDragStart?: (event: React.DragEvent, item: TrackerRecord, columnKey: string) => void;
  onDragEnd?: () => void;
  onSelect: (event: React.MouseEvent, item: TrackerRecord) => void;
  /** Checkbox path: add or remove this card from the selection, nothing else. */
  onToggleSelected: (itemId: string) => void;
  onContextMenu?: (event: React.MouseEvent, item: TrackerRecord) => void;
  onOpenDocument?: (itemId: string) => void;
  /** Milestone chip, when the host has a milestone picker to open. */
  milestoneSlot?: React.ReactNode;
  /** Personal lane, desktop only. Omitted by a host with team auth only. */
  unreadSlot?: React.ReactNode;
  /** Personal lane, desktop only. Omitted by a host with team auth only. */
  favoriteSlot?: React.ReactNode;
  /** Current viewer, used only to distinguish teammate activity. */
  currentIdentity?: TrackerIdentity | null;
}

export const TrackerBoardCard: React.FC<TrackerBoardCardProps> = ({
  item,
  columnKey,
  cardIndex,
  selected,
  highlighted,
  dragging,
  onDragStart,
  onDragEnd,
  onSelect,
  onToggleSelected,
  onContextMenu,
  onOpenDocument,
  milestoneSlot,
  unreadSlot,
  favoriteSlot,
  currentIdentity,
}) => {
  const priority = getRecordPriority(item);
  const typeColor = TYPE_COLORS[item.primaryType] || NEUTRAL_SWATCH;
  const owner = getFieldByRole(item, 'assignee') as string | undefined;
  // externalKey role (e.g. a PR number) rides next to the local issue key so
  // imported/external items stay recognizable on the board.
  const keyLine = [item.issueKey, getRecordExternalKey(item)].filter(Boolean).join(' · ');
  const draggable = Boolean(onDragStart);

  return (
    <div
      data-testid="tracker-kanban-card"
      data-item-id={item.id}
      data-card-index={cardIndex}
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={onDragStart ? (event) => onDragStart(event, item, columnKey) : undefined}
      onDragEnd={onDragEnd}
      className={`tracker-kanban-card w-full text-left p-2.5 rounded-md bg-nim hover:bg-nim-tertiary border transition-colors mb-1.5 ${
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
      } ${dragging ? 'opacity-40' : ''} ${
        selected || highlighted ? 'border-[var(--nim-primary)]' : 'border-nim'
      }`}
      onClick={(event) => onSelect(event, item)}
      onDoubleClick={() => onOpenDocument?.(item.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(event as unknown as React.MouseEvent, item);
        }
      }}
      onContextMenu={onContextMenu ? (event) => onContextMenu(event, item) : undefined}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          draggable={false}
          className={`tracker-card-select-checkbox ${
            selected ? 'tracker-card-select-checkbox-checked' : 'tracker-card-select-checkbox-unchecked'
          }`}
          data-testid="tracker-card-select-checkbox"
          role="checkbox"
          aria-checked={selected}
          aria-label={selected ? 'Deselect card' : 'Select card'}
          title={selected ? 'Deselect' : 'Select for a bulk action'}
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelected(item.id);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <MaterialSymbol icon="check" size={11} />
        </button>
        <span
          className="w-2 h-2 rounded-full mt-1.5 shrink-0"
          style={{ backgroundColor: PRIORITY_COLORS[priority || 'medium'] || NEUTRAL_SWATCH }}
        />
        {unreadSlot}
        {favoriteSlot}
        <div className="flex-1 min-w-0">
          {keyLine ? (
            <div className="text-[10px] font-mono font-medium uppercase tracking-[0.08em] text-nim-faint mb-0.5">
              {keyLine}
            </div>
          ) : null}
          <div className="text-sm text-nim leading-snug line-clamp-2">
            {getRecordTitle(item)}
          </div>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <TrackerSwatchBadge label={item.primaryType} color={typeColor} />
            {item.typeTags
              .filter(tag => tag !== item.primaryType)
              .map(tag => (
                <TrackerSwatchBadge
                  key={tag}
                  label={tag}
                  color={TYPE_COLORS[tag] || NEUTRAL_SWATCH}
                  variant="secondary"
                />
              ))}
            {priority && priority !== 'medium' ? (
              <TrackerSwatchBadge
                label={priority}
                color={PRIORITY_COLORS[priority] || NEUTRAL_SWATCH}
              />
            ) : null}
            <TrackerCardStalenessChip item={item} />
            <TrackerRecentActivityChip item={item} identity={currentIdentity} />
            {milestoneSlot}
            {owner ? (
              <span className="ml-auto">
                <UserAvatar identity={owner} size={18} />
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};
