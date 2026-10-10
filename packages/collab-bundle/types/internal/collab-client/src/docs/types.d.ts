import type { PageFields } from './pageFields';
/**
 * A parent in the page tree is a page (a document) or a typed page (a tracker
 * item). Absent on the wire means a page.
 */
export type SharedParentKind = 'page' | 'item';
export interface SharedDocument {
    documentId: string;
    /** Owning project preserved from the team document index. */
    teamProjectId: string | null;
    title: string;
    documentType: string;
    /** Optional V2 type metadata; legacy rows are inferred at read time. */
    metadataVersion?: 2;
    /** Exact normalized suffix, including the leading dot. */
    fileExtension?: string;
    /** Stable owning editor id (built-in or extension id). */
    editorId?: string;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
    /** User id of whoever most recently changed this doc. */
    lastWriterUserId?: string | null;
    /** First-class parent folder; null/undefined means root. */
    parentFolderId?: string | null;
    /** What `parentFolderId` names: a page (the default) or a typed page (tracker item). */
    parentKind?: SharedParentKind;
    /** Order among its siblings in the page tree; null until its group is first reordered. */
    sortOrder?: number | null;
    /** Millisecond epoch when moved to recoverable Trash. */
    trashedAt?: number | null;
    /**
     * False until the body is first edited; such a page with children shows as a
     * folder in the tree. Absent (older servers) = true.
     */
    hasContent?: boolean;
    /** True when the encrypted title could not be decrypted. */
    decryptFailed?: boolean;
    /** A plain page's own fields (owner, status, summary, tags); see `pageFields.ts`. */
    fields?: PageFields;
}
export interface SharedFolder {
    folderId: string;
    /** Null/undefined means root level. */
    parentFolderId?: string | null;
    /** A page projected as a folder whose parent is a typed page (`parentFolderId` is an item id). */
    parentKind?: SharedParentKind;
    name: string;
    sortOrder: number;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
    /** True when the encrypted folder name could not be decrypted. */
    decryptFailed?: boolean;
}
/**
 * A tracker type placed as a node in the page tree. One placement per type
 * per project; the type's items nest under it in the tree.
 */
export interface SharedTypePlacement {
    typeId: string;
    /** Owning team project; placements are scoped like folders. */
    projectId: string | null;
    /** Null/undefined means root level. */
    parentFolderId?: string | null;
    /** What `parentFolderId` names; absent means a page. */
    parentKind?: SharedParentKind;
    sortOrder: number;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
}
/**
 * Where a typed page (a tracker item) sits in the page tree, separate from its
 * type. No placement means it sits under its type's node.
 */
export interface SharedItemPlacement {
    itemId: string;
    projectId: string | null;
    /** Parent page (document) id; null/undefined means root level. */
    parentId?: string | null;
    /** What `parentId` names; absent means a page. */
    parentKind?: SharedParentKind;
    sortOrder: number;
    createdBy: string;
    createdAt: number;
    updatedAt: number;
}
/** Document id prefix for a type page's prose; never a tree row of its own. */
export declare const TYPE_PAGE_DOCUMENT_PREFIX = "type-page:";
