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
import React from 'react';
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
export declare const ReorderList: React.FC<ReorderListProps>;
