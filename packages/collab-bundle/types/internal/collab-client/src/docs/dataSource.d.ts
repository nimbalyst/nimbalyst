import type { CollabCommandResult, CollabDataChange, CollabDataSnapshot, CollabDataSource, Unsubscribe } from '../core/index';
import type { PageSearchRequest, PageSearchResponse } from '@nimbalyst/collab-protocol';
import type { SharedDocument, SharedFolder, SharedItemPlacement, SharedParentKind, SharedTypePlacement } from './types';
export type { SharedItemPlacement, SharedParentKind, SharedTypePlacement } from './types';
export type CollabDocsCommand = {
    type: 'register-document';
    documentId: string;
    title: string;
    documentType: string;
    parentFolderId: string | null;
    /** What `parentFolderId` names; absent means a page. */
    parentKind?: SharedParentKind;
    /** Order among its siblings; absent leaves it unordered (null). */
    sortOrder?: number | null;
    metadata?: {
        metadataVersion: 2;
        fileExtension: string;
        editorId: string;
    };
} | {
    type: 'update-document-title';
    documentId: string;
    title: string;
}
/**
 * A plain page's own fields (`pageFields.ts`), as a patch: a key set to null
 * clears that field, an absent key keeps it. The store validates the result.
 */
 | {
    type: 'set-document-fields';
    documentId: string;
    fields: Record<string, unknown>;
}
/** `purge` permanently deletes a page in Trash; only Trash's permanent delete sets it. */
 | {
    type: 'remove-document';
    documentId: string;
    purge?: true;
} | {
    type: 'trash-document';
    documentId: string;
    trashedAt: number;
} | {
    type: 'restore-document';
    documentId: string;
} | {
    type: 'move-document';
    documentId: string;
    parentFolderId: string | null;
    parentKind?: SharedParentKind;
    /** Same parent and a new order is a reorder; absent on a move to a new parent means null. */
    sortOrder?: number | null;
    /** Resolve only once the store confirmed the move; reject on a refusal or timeout. */
    confirm?: boolean;
} | {
    type: 'register-folder';
    folderId: string;
    name: string;
    parentFolderId: string | null;
    sortOrder: number;
} | {
    type: 'rename-folder';
    folderId: string;
    name: string;
} | {
    type: 'move-folder';
    folderId: string;
    parentFolderId: string | null;
}
/** `purge` permanently deletes a page in Trash and the pages in Trash below it (Personal pages). */
 | {
    type: 'remove-folder';
    folderId: string;
    purge?: true;
} | {
    type: 'refresh-folders';
} | {
    type: 'set-type-placement';
    typeId: string;
    parentFolderId: string | null;
    sortOrder: number;
    parentKind?: SharedParentKind;
    /** As on `move-document`. */
    confirm?: boolean;
} | {
    type: 'remove-type-placement';
    typeId: string;
} | {
    type: 'refresh-type-placements';
} | {
    type: 'set-item-placement';
    itemId: string;
    parentId: string | null;
    sortOrder: number;
    parentKind?: SharedParentKind;
} | {
    type: 'remove-item-placement';
    itemId: string;
} | {
    type: 'refresh-item-placements';
} | {
    type: 'reconnect';
};
export interface CollabDocsCommandResult extends CollabCommandResult {
    folders?: SharedFolder[] | null;
    /** `refresh-type-placements` only: the server list, or null on timeout. */
    typePlacements?: SharedTypePlacement[] | null;
    /** `refresh-item-placements` only: the server list, or null on timeout. */
    itemPlacements?: SharedItemPlacement[] | null;
    /**
     * `register-document` only: whether the server confirmed the index row is
     * committed. `false` means unconfirmed (older server, or queued offline) —
     * not failed. Callers about to write into the new document's room use this
     * to decide whether the room is known-reachable yet (NIM-2472).
     */
    registrationAcked?: boolean;
    /**
     * Personal pages, `remove-document` / `remove-folder` with `purge`: how many
     * pages were deleted for good. 0 when none was still in Trash as read, for
     * example because another window restored it first.
     */
    purged?: number;
}
/**
 * Document snapshot plus the tracker types placed in the page tree. A host
 * that predates placements omits `typePlacements`; one that sets it is
 * authoritative for this scope's project.
 *
 * Placement changes travel as `snapshot` changes rather than their own kinds:
 * the docs source has to stay assignable to the core `CollabDataSource` seam,
 * and a listener typed for the core change union cannot accept new kinds.
 */
export interface CollabDocsSnapshot extends CollabDataSnapshot<SharedDocument, SharedFolder> {
    typePlacements?: SharedTypePlacement[];
    /** Typed pages placed in the tree; authoritative when present, like `typePlacements`. */
    itemPlacements?: SharedItemPlacement[];
    /**
     * True once the store has converted folders into pages: the tree is built
     * from documents (`parentFolderId` names the parent page) and `containers`
     * is ignored. Absent from an older server, which keeps the folder tree.
     */
    pageTree?: boolean;
    /**
     * The team's primary project (the team snapshot's `metadata.teamProjectId`).
     * The session shows one project: a document with no project (an older
     * server) belongs to the primary, and so does a scope with no project id.
     * Absent while unknown; then nothing is split off.
     */
    primaryProjectId?: string | null;
    /** True when this store keeps a plain page's own fields; absent hides them. */
    pageFields?: boolean;
}
export type CollabDocsDataChange = Exclude<CollabDataChange<SharedDocument, SharedFolder>, {
    type: 'snapshot';
}> | {
    type: 'snapshot';
    snapshot: CollabDocsSnapshot;
};
export interface CollabDocsDataSource extends Omit<CollabDataSource<SharedDocument, SharedFolder, CollabDocsCommand, CollabDocsCommandResult>, 'snapshot' | 'subscribe'> {
    snapshot(): Promise<CollabDocsSnapshot>;
    subscribe(cb: (change: CollabDocsDataChange) => void): Unsubscribe;
    /**
     * Pages whose bodies match `request` (see `@nimbalyst/collab-protocol`
     * `pageSearch.ts`). Null when this section cannot answer now (offline, not
     * connected yet). Absent on a source with no body search.
     */
    searchPages?(request: PageSearchRequest): Promise<PageSearchResponse | null>;
}
