import type { CollabDocsUIStatus } from '../docs/session';
import type { SharedDocument, SharedItemPlacement, SharedTypePlacement } from '../docs/types';
export interface CollabPagesState {
    /** Every non-trashed document in the index, type page prose included. */
    documents: SharedDocument[];
    typePlacements: SharedTypePlacement[];
    itemPlacements: SharedItemPlacement[];
    /** True once the server runs the one page tree. */
    pageTree: boolean;
    syncStatus: CollabDocsUIStatus;
}
export declare function useCollabPagesState(): CollabPagesState;
