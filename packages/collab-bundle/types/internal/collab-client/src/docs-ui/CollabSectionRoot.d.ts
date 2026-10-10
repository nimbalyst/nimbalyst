/**
 * A Pages section's root: the menu that empty tree space and the section
 * header open (New page, then Place type...), and the messages an empty or
 * filtered-out tree shows instead of rows. A page started from any of these
 * lands at the section root.
 */
import React from 'react';
/** A host's own entry in a section menu, after New page and Place type... */
export interface CollabSectionMenuItem {
    /** Stable kebab-case marker, used as the entry's class. */
    id: string;
    label: string;
    icon: string;
    onSelect: () => void;
}
export declare const CollabSectionMenu: React.FC<{
    x: number;
    y: number;
    onNewPage: () => void;
    /** Absent without tracker data (no types to place). */
    onPlaceType?: () => void;
    extraItems?: readonly CollabSectionMenuItem[];
    onClose: () => void;
}>;
export type CollabTreeEmptyReason = 'empty' | 'favorites' | 'updated';
export declare const CollabTreeEmptyState: React.FC<{
    reason: CollabTreeEmptyReason;
    personal: boolean;
    scopeAvailable: boolean;
    /** Absent when no page type can be created here. */
    onNewPage?: () => void;
}>;
