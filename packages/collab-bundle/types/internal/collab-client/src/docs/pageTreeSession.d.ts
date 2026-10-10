/**
 * The part of a docs session the page tree planner and the agent tool core
 * act through. `CollabDocsSession` satisfies it as is; the collab worker's
 * remote Pages tools implement it over their rooms.
 *
 * Type-only and import-free of `session.ts` on purpose: that module brings
 * Jotai and the runtime store, which a worker cannot load or typecheck.
 */
import type { PageSearchRequest, PageSearchResponse } from '@nimbalyst/collab-protocol';
import type { SharedDocument, SharedItemPlacement, SharedParentKind } from './types';
/** Same shape as `CollabPlacementWriteResult` in `session.ts`. */
export type PageTreeWriteResult = {
    ok: true;
} | {
    ok: false;
    error: string;
};
export interface PageTreeMoveOptions {
    parentKind?: SharedParentKind;
    sortOrder?: number | null;
}
export interface PageTreeSession {
    readonly scope: {
        orgId: string;
        indexConfig?: {
            teamProjectId?: string | null;
        } | null;
    };
    start(): Promise<void>;
    isPageTree(): boolean;
    getDocuments(): SharedDocument[];
    getItemPlacements(): SharedItemPlacement[];
    movePage(documentId: string, parentId: string | null, options?: PageTreeMoveOptions): false | Promise<PageTreeWriteResult>;
    moveTypePlacement(typeId: string, parentFolderId: string | null, sortOrder?: number, parentKind?: SharedParentKind): Promise<PageTreeWriteResult>;
    placeType(typeId: string, parentFolderId: string | null, parentKind?: SharedParentKind): Promise<PageTreeWriteResult>;
    setItemPlacement(itemId: string, parentId: string | null, sortOrder?: number, parentKind?: SharedParentKind): Promise<PageTreeWriteResult>;
    removeItemPlacement(itemId: string): Promise<PageTreeWriteResult>;
    updateDocumentTitle(documentId: string, title: string): Promise<PageTreeWriteResult>;
    /**
     * Sets some of a plain page's own fields (`pageFields.ts`); null clears one.
     * Absent, or refusing, where the section's store cannot keep them.
     */
    updateDocumentFields?(documentId: string, patch: Record<string, unknown>): Promise<PageTreeWriteResult>;
    /**
     * Agent deletes are recoverable: a page and a subtree both go to Trash. A
     * permanent delete is left to a person in Trash, so it is not here.
     */
    trashDocument(documentId: string): Promise<PageTreeWriteResult>;
    removePage(documentId: string): Promise<PageTreeWriteResult>;
    pageRemovalCount?(documentId: string): number;
    /** Body and title search (`pageSearch.ts`); null when the section cannot search now. */
    searchPages?(request: PageSearchRequest): Promise<PageSearchResponse | null>;
}
