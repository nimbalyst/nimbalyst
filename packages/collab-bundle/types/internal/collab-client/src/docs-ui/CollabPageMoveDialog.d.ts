/**
 * "Move to..." for the one page tree: pick the page or typed page a page,
 * type or typed page should live under, root, or (typed pages only) back
 * under its type. Destinations come from the tree as shown, and one that
 * would put the row inside itself (also through a type) is not offered.
 * Lazy-loaded by the sidebar so it stays out of the docs-ui eager bundle.
 */
import React from 'react';
import type { CollabTreeNode } from '../docs/index';
import { type PageTreeDestination } from '../docs/collabPageTree';
/** A destination: a page or typed page row id, null for root, or `UNDER_TYPE`. */
export type CollabMoveDestination = string | null;
export interface CollabPageMoveDialogProps {
    name: string;
    tree: CollabTreeNode[];
    /** The row being moved (`document:`, `type:` or `item:` id). */
    movingNodeId: string;
    rootLabel: string;
    /** Typed pages only: label for the "under its type" destination. */
    underTypeLabel?: string;
    onConfirm: (destination: PageTreeDestination) => void;
    onCancel: () => void;
}
export default function CollabPageMoveDialog({ name, tree, movingNodeId, rootLabel, underTypeLabel, onConfirm, onCancel, }: CollabPageMoveDialogProps): React.JSX.Element;
