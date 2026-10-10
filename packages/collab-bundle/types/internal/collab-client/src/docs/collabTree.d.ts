import { type SharedDocument, type SharedFolder, type SharedTypePlacement } from './types';
export { TYPE_PAGE_DOCUMENT_PREFIX } from './types';
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
    /** Child pages, types and placed items; only in a page tree. */
    children?: CollabTreeNode[];
}
/**
 * A tracker type placed in the tree. Its children are the type's items, after
 * any placed subtypes (types that `extends` it).
 */
export interface CollabTreeTypeNode {
    id: string;
    type: 'type';
    typeId: string;
    path: string;
    name: string;
    /** Number of items of this type (in a page tree, and of every type that extends it). */
    count: number;
    placement: SharedTypePlacement;
    /** Why the type's file did not load; the type is shown so the user can fix it. */
    error?: string;
    children: Array<CollabTreeTypeNode | CollabTreeItemNode>;
}
export interface CollabTreeItemNode {
    id: string;
    type: 'item';
    itemId: string;
    typeId: string;
    path: string;
    name: string;
    /** Singular type name shown faintly beside the row (page tree only). */
    typeLabel?: string;
    /** Why the item's type did not load (see `CollabTreeTypeNode.error`). */
    typeError?: string;
    /** True when the item has a tree placement of its own. */
    placed?: boolean;
    /** A placed item's placement order among its siblings. */
    sortOrder?: number;
    /** Child pages, types and typed pages; only in a page tree. */
    children?: CollabTreeNode[];
}
export type CollabTreeNode = CollabTreeFolderNode | CollabTreeDocumentNode | CollabTreeTypeNode | CollabTreeItemNode;
/**
 * Host-supplied answers about tracker types and items. The tree stays pure: it
 * never reads a registry or a store itself.
 */
export interface CollabTypeTreeResolver {
    /** Display name of a type, or null when the type is unknown here. */
    typeName(typeId: string): string | null;
    /** Singular display name ("Module" for "Modules"); falls back to `typeName`. */
    typeLabel?(typeId: string): string | null;
    /** The type this one `extends`, if any. */
    typeExtends?(typeId: string): string | null;
    /** Why a type's file did not load; null for a type that loaded. */
    typeError?(typeId: string): string | null;
    /** Items of a type, in display order. */
    itemsOfType(typeId: string): Array<{
        itemId: string;
        title: string;
        sortKey?: string | number;
    }>;
    /** One item by id, for an item placed outside its type; null when unknown here. */
    item?(itemId: string): {
        itemId: string;
        title: string;
        typeId: string;
    } | null;
    /**
     * Types a user may place, for the "Place type..." menu. `creatable: false`
     * marks a type that holds no new pages, which "Set type" does not offer.
     */
    listedTypes?(): Array<{
        typeId: string;
        name: string;
        icon?: string;
        creatable?: boolean;
    }>;
}
export interface CollabTypePlacementInput {
    placements: SharedTypePlacement[];
    resolver: CollabTypeTreeResolver;
}
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
/** @internal Shared with `collabPageTree.ts`. */
export declare const compareTypeNodes: (left: CollabTreeTypeNode, right: CollabTreeTypeNode) => number;
/**
 * Folders, then placed types (by sortOrder), then documents (by name), then
 * placed typed pages (by sortOrder): the order of a group nobody reordered.
 * @internal Shared with `collabPageTree.ts`.
 */
export declare function compareTreeNodes(left: CollabTreeNode, right: CollabTreeNode): number;
/** @internal Shared with `collabPageTree.ts`. */
export declare function sortTreeNodes(nodes: CollabTreeNode[]): CollabTreeNode[];
/**
 * Build type nodes from placements and attach them under their folder (or
 * root). A type whose `extends` chain reaches another placed type nests inside
 * that type's node instead. Placements the resolver cannot name are skipped.
 */
export type CollabTreeContainer = {
    path: string;
    children: CollabTreeNode[];
};
/**
 * One node per resolvable placement, and the placed base each one nests in
 * (null when it sits by its own placement). A corrupt `extends` cycle between
 * placed types is broken by placing the node normally.
 * @internal Shared with `collabPageTree.ts`.
 */
export declare function createTypeNodes(placements: SharedTypePlacement[], resolver: CollabTypeTreeResolver): {
    nodes: Map<string, CollabTreeTypeNode>;
    parentType: Map<string, string | null>;
};
/** @internal Shared with `collabPageTree.ts`. */
export declare function attachTypeNodes(roots: CollabTreeNode[], folderNodeById: (folderId: string) => CollabTreeContainer | undefined, input: CollabTypePlacementInput | undefined): void;
export declare function buildCollabTree(documents: SharedDocument[], customFolders: string[], typePlacements?: CollabTypePlacementInput): CollabTreeNode[];
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
export declare function buildCollabTreeFromFolders(documents: SharedDocument[], folders: SharedFolder[], typePlacements?: CollabTypePlacementInput): CollabTreeNode[];
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
export declare function buildCollabTreeAdaptive(documents: SharedDocument[], folders: SharedFolder[], typePlacements?: CollabTypePlacementInput): CollabTreeNode[];
/**
 * Drop folder nodes that contain no documents (directly or transitively). Used
 * by the Favorites/Updated segments so an empty folder doesn't linger once its
 * only matching docs are filtered out. Folders with document descendants are
 * kept (with their empty sub-branches pruned).
 */
export declare function pruneEmptyFolders(nodes: CollabTreeNode[]): CollabTreeNode[];
export declare function filterCollabTree(nodes: CollabTreeNode[], query: string): CollabTreeNode[];
/**
 * A page's name wherever it shows (tree rows, tabs, crumbs, pickers). New
 * pages store the bare name; an older title may still carry its folder path
 * and, for markdown, ".md" ("Specs/Architecture.md" reads "Architecture").
 * Display only: nothing rewrites stored titles. Other document types keep
 * their extension.
 */
export declare function pageDisplayName(title: string, documentType: string | undefined): string;
export declare const isTypePageDocumentId: (documentId: string) => boolean;
/**
 * Every page as a folder-shaped row, for a page tree. Paths, crumbs, pickers
 * and the create flow resolve a parent through the folder list; in a page tree
 * any page can be a parent, so each one stands in as a folder with its own id.
 * Type-page documents are excluded: the type node stands for them.
 */
export declare function projectPagesAsFolders(documents: SharedDocument[]): SharedFolder[];
/** A page and every page below it, root first. Tolerates parent cycles. */
export declare function collectPageSubtree(documents: SharedDocument[], pageId: string): string[];
export interface CollabPageRemovalPlan {
    /** The page, its descendant pages and the prose of types placed among them. */
    removedIds: string[];
    /** Everything removed except the page itself, for the confirmation. */
    childCount: number;
    /**
     * Type-page prose sitting in the subtree whose type is placed outside it:
     * moved to the type's parent (or root) before the removal, never deleted.
     */
    relocate: Array<{
        documentId: string;
        parentId: string | null;
    }>;
}
/**
 * What removing a page takes with it. A `type-page:<typeId>` document belongs
 * to its type, not to the page it happens to sit under: it goes with the
 * subtree only when the type itself is placed inside it.
 */
export declare function planPageRemoval(documents: SharedDocument[], typePlacements: SharedTypePlacement[], pageId: string): CollabPageRemovalPlan;
