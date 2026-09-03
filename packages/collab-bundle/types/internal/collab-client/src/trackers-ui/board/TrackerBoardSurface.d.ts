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
import React from 'react';
import type { TrackerRecord } from '../../../../runtime/src/core/TrackerRecord';
import type { TrackerIdentity } from '../../../../runtime/src/core/DocumentService';
import type { TrackerGroupBy, TrackerOrdering, TrackerRelationshipLabelResolver } from '../../../../runtime/src/plugins/TrackerPlugin/models/index';
import { type TrackerStatusScope } from '../../trackers/index';
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
export declare function TrackerBoardSurface({ rows, trackerType, groupBy, ordering, statusScope, resolveRelationshipLabel, selectedItemIds, highlightedItemId, onToggleSelected, onOpenItem, onItemUpdate, currentIdentity, }: TrackerBoardSurfaceProps): React.JSX.Element;
