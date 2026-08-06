import type { SharedDocument, SharedFolder } from './types';
export interface CollabTreeFolderNode {
    id: string;
    type: 'folder';
    path: string;
    name: string;
    children: CollabTreeNode[];
    /**
     * First-class folder id, present when the tree was built from real folder
     * nodes (`buildCollabTreeFromFolders`). Absent for the legacy path-in-title
     * builder (`buildCollabTree`). Folder operations (rename/move/delete/link)
     * key off this id.
     */
    folderId?: string;
    /** The underlying folder node (first-class builder only). */
    folder?: SharedFolder;
}
export interface CollabTreeDocumentNode {
    id: string;
    type: 'document';
    path: string;
    name: string;
    document: SharedDocument;
}
export type CollabTreeNode = CollabTreeFolderNode | CollabTreeDocumentNode;
export interface CollabFolderOption {
    folderId: string | null;
    name: string;
    depth: number;
}
/** Every folder id in the subtree rooted at `folderId`, including the root. */
export declare function collectFolderSubtree(folders: SharedFolder[], folderId: string): string[];
/** True when `candidateId` is `ancestorId` or is nested below it. */
export declare function isDescendantFolder(folders: SharedFolder[], candidateId: string, ancestorId: string): boolean;
/**
 * Build the Root-first location list used by the collab create dialog.
 * Missing parents are treated as root. A final visited-set pass keeps every
 * folder selectable even if corrupt data contains a parent cycle.
 */
export declare function flattenCollabFolderOptions(folders: SharedFolder[]): CollabFolderOption[];
/**
 * Resolve the create target when opening the dialog. `undefined` means there
 * is no folder context menu, while `null` is an explicit Root target (used by
 * legacy folder rows that have no first-class folder id).
 */
export declare function resolveCollabCreateTargetFolderId(contextFolderId: string | null | undefined, selectedFolderId: string | null | undefined): string | null;
export declare function normalizeCollabPath(value: string | null | undefined): string;
export declare function getCollabParentPath(path: string): string | null;
export declare function getCollabNodeName(path: string): string;
export declare function joinCollabPath(parentPath: string | null | undefined, name: string): string;
export declare function renameCollabDocumentPath(path: string, name: string): string;
export declare function getCollabDocumentPath(document: SharedDocument): string;
export declare const UNRESOLVED_SHARED_DOCUMENT_NAME = "Shared document";
/**
 * Resolve the user-facing path for a shared document without ever exposing its
 * transport id. First-class folder rows are authoritative; legacy documents
 * may still carry their path in `title`, so the title is retained when there
 * is no first-class parent.
 */
export declare function getSharedDocumentDisplayPath(document: Pick<SharedDocument, 'documentId' | 'title' | 'parentFolderId'>, folders: SharedFolder[]): string;
export declare function getSharedDocumentDisplayName(titleOrPath: string | null | undefined, documentId: string): string;
export declare function reconcileSharedDocumentDisplayName(currentDisplayName: string | null | undefined, titleOrPath: string | null | undefined, documentId: string): string;
/**
 * Prefer fresh index metadata once it is complete, but never let a partial
 * sync replace a useful path restored with the tab's collaboration config.
 */
export declare function getSharedDocumentDisplayPathWithFallback(document: Pick<SharedDocument, 'documentId' | 'title' | 'parentFolderId'>, folders: SharedFolder[], fallbackPath: string | null | undefined): string;
export declare function buildCollabTree(documents: SharedDocument[], customFolders: string[]): CollabTreeNode[];
/**
 * Build the collab tree from FIRST-CLASS folder nodes + each document's
 * `parentFolderId`, instead of splitting titles on '/'. Folder identity is the
 * stable `folderId`; `path` is a derived breadcrumb (parent path + name) kept
 * for search and display. A document's display name is the leaf of its title —
 * during the dual-write transition a title may still be a full path, so the
 * leaf is taken defensively (`getCollabNodeName`).
 *
 * Documents (or folders) whose `parentFolderId` points at a missing folder are
 * placed at root so nothing disappears if a parent is briefly out of sync.
 */
export declare function buildCollabTreeFromFolders(documents: SharedDocument[], folders: SharedFolder[]): CollabTreeNode[];
/**
 * Compute the document title rewrites needed to rename a LEGACY (path-in-title)
 * folder. Legacy folders have no first-class `folderId`; their identity is the
 * breadcrumb path, and their structure lives in each descendant document's
 * full-path title. Renaming such a folder swaps the folder's segment in every
 * descendant doc's title (dual-write friendly: un-upgraded clients keep the
 * structure, and it works whether or not first-class migration has run).
 *
 * Returns one `{ documentId, newTitle }` per affected document. Empty when the
 * new name is blank or unchanged.
 */
export declare function computeLegacyFolderRenameUpdates(documents: SharedDocument[], folderPath: string, newName: string): {
    documentId: string;
    newTitle: string;
}[];
/**
 * Choose the right tree builder so folders NEVER visually disappear during the
 * legacy -> first-class folder transition.
 *
 * The first-class builder (`buildCollabTreeFromFolders`) places any document
 * whose `parentFolderId` is null at ROOT. Legacy documents encode their folder
 * structure in the TITLE (`Specs/API Spec`) and still have a null
 * `parentFolderId` until the client-driven migration populates `folder_nodes`
 * on the server AND those rows round-trip back into `sharedFolders`. Until then,
 * building exclusively from first-class rows collapses every foldered doc to a
 * flat root list and the user's folders vanish.
 *
 * Fallback rule: if there are NO first-class folder rows yet but some document
 * still encodes a folder path in its title, render with the legacy path-in-title
 * builder. Otherwise use the first-class builder (which also handles the "no
 * folders, all root-level docs" case correctly). Once migration completes and
 * folder rows exist, we always use the first-class builder — so its
 * context-menu / drag / deep-link behavior (keyed off `folderId`) is preserved.
 */
export declare function buildCollabTreeAdaptive(documents: SharedDocument[], folders: SharedFolder[]): CollabTreeNode[];
/**
 * Drop folder nodes that contain no documents (directly or transitively). Used
 * by the Favorites/Updated segments so an empty folder doesn't linger once its
 * only matching docs are filtered out. Folders with document descendants are
 * kept (with their empty sub-branches pruned).
 */
export declare function pruneEmptyFolders(nodes: CollabTreeNode[]): CollabTreeNode[];
export declare function filterCollabTree(nodes: CollabTreeNode[], query: string): CollabTreeNode[];
