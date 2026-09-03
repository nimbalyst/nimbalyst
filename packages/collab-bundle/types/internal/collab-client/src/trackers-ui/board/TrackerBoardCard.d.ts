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
import type { TrackerRecord } from '../../../../runtime/src/core/TrackerRecord';
import type { TrackerIdentity } from '../../../../runtime/src/core/DocumentService';
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
export declare const TrackerBoardCard: React.FC<TrackerBoardCardProps>;
