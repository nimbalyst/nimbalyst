/**
 * The one page tree (documents nest in documents, typed pages can be placed
 * under any page). Not exported from the docs barrel: the sidebar loads it
 * lazily, only for a page-tree scope, so it stays out of the docs-ui eager
 * bundle.
 */
import { type CollabTreeNode, type CollabTypeTreeResolver } from './collabTree';
import type { PageTreeSession } from './pageTreeSession';
import type { SharedDocument, SharedFolder, SharedItemPlacement, SharedParentKind, SharedTypePlacement } from './types';
export interface CollabPageTreeInput {
    resolver?: CollabTypeTreeResolver;
    typePlacements?: SharedTypePlacement[];
    itemPlacements?: SharedItemPlacement[];
}
/** Spacing for a re-spaced sibling group. */
export declare const RENUMBER_STEP = 1024;
/**
 * The order a new page gets at the end of its group: past every sibling once
 * the group has been reordered, and none (today's place by name) before that.
 */
export declare function nextSiblingOrder(siblingOrders: Array<number | null | undefined>): number | null;
/**
 * A new page's order at the end of its group under (parentId, parentKind):
 * pages, placed types and placed typed pages there (see `nextSiblingOrder`).
 */
export declare function nextPageOrder(documents: SharedDocument[], typePlacements: SharedTypePlacement[], itemPlacements: SharedItemPlacement[], parentId: string | null, parentKind: SharedParentKind): number | null;
/**
 * Whether a sibling under the tree row `parentNodeId` (null for root) already
 * shows `name`. Names compare as the tree shows them, so an older "Child.md"
 * and a new bare "Child" collide.
 */
export declare function pageNameTaken(tree: CollabTreeNode[], parentNodeId: string | null, name: string, documentType: string, exceptDocumentId?: string): boolean;
/**
 * Whether another page under (parentId, parentKind) already shows the name
 * `title` (default: the page's own title), for a rename or a move.
 */
export declare function pageNameConflict(tree: CollabTreeNode[], page: SharedDocument, parentId: string | null, parentKind: SharedParentKind | undefined, title?: string): boolean;
/** The tree row id of a parent: a page's or a typed page's, null for root. */
export declare const parentNodeIdOf: (parentId: string | null | undefined, parentKind: SharedParentKind | undefined) => string | null;
/**
 * A type and every listed type whose `extends` chain reaches it, the type
 * first. Without `listedTypes` the resolver cannot name subtypes, so only the
 * type itself. Tolerates `extends` cycles.
 */
export declare function typeWithSubtypes(typeId: string, resolver: Pick<CollabTypeTreeResolver, 'typeExtends' | 'listedTypes'>): string[];
/**
 * The one page tree: pages, placed types and typed pages (tracker items) can
 * each sit under a page or a typed page; an unplaced typed page sits under its
 * type and can still hold children there. A node whose parent is not here (a
 * missing page, an item gone from the tracker) sits at root, except a typed
 * page placed under a missing page, which stays under its type. A corrupt
 * cycle (through pages, typed pages or a type) is broken by rooting the node
 * where the walk up repeats, so nothing ever disappears.
 */
export declare function buildCollabPageTree(documents: SharedDocument[], input?: CollabPageTreeInput): CollabTreeNode[];
export type PageTreeDragged = {
    kind: 'page';
    documentId: string;
} | {
    kind: 'type';
    typeId: string;
} | {
    kind: 'item';
    itemId: string;
    typeId: string;
};
/** Where on a row a drag is: its upper or lower edge, or its middle. */
export type PageTreeDropZone = 'before' | 'inside' | 'after';
/** One row's new parent and order. A page's order is null until its group is reordered. */
export type PageTreeWrite = {
    kind: 'page';
    documentId: string;
    parentId: string | null;
    parentKind: SharedParentKind;
    sortOrder: number | null;
} | {
    kind: 'type';
    typeId: string;
    parentFolderId: string | null;
    parentKind: SharedParentKind;
    sortOrder: number;
} | {
    kind: 'item';
    itemId: string;
    parentId: string | null;
    parentKind: SharedParentKind;
    sortOrder: number;
};
/** What a drop writes: the dragged row, after any siblings re-spaced to make room (`renumber`). */
export type PageTreeDropPlan = (PageTreeWrite & {
    renumber?: PageTreeWrite[];
}) | {
    kind: 'unplace-item';
    itemId: string;
};
/** The upper and lower quarters of a row insert beside it; the middle drops inside. */
export declare function pageTreeDropZone(offsetY: number, height: number): PageTreeDropZone;
/**
 * Plan dropping `dragged` on the row `targetId`. An edge drop lands in the
 * row's parent next to it; a middle drop lands inside the row (a page or a
 * typed page). Null means the drop is refused or changes nothing.
 *
 * Order (one order across pages, types and typed pages): an edge drop is a
 * reorder. In a group nobody reordered yet it re-spaces the whole group in its
 * displayed order; after that it takes the gap at the drop point, re-spacing
 * only when there is none. A middle drop lands at the end of the group.
 *
 * A subtype always renders inside its placed base (see `createTypeNodes`), so
 * it moves only within that base. A drop that would put a row inside itself is
 * refused, also when the way up passes through a type node (an unplaced typed
 * page sits under its type, which the server cannot see).
 */
export declare function planPageTreeDrop(tree: CollabTreeNode[], dragged: PageTreeDragged, targetId: string, zone: PageTreeDropZone): PageTreeDropPlan | null;
/** The parts of a drag event a row drop reads (a React or DOM drag event). */
interface RowDragEvent {
    clientY: number;
    currentTarget: {
        getBoundingClientRect(): {
            top: number;
            height: number;
        };
        contains(node: never): boolean;
    };
    relatedTarget: unknown;
    dataTransfer: {
        dropEffect: string;
    };
    preventDefault(): void;
    stopPropagation(): void;
}
export interface PageTreeRowDropContext {
    tree: CollabTreeNode[];
    dragged: PageTreeDragged | null;
    documents: SharedDocument[];
    dropIndicator: {
        nodeId: string;
        zone: 'before' | 'after';
    } | null;
    dropTargetPath: string | null;
    setDropIndicator(value: {
        nodeId: string;
        zone: 'before' | 'after';
    } | null): void;
    setDropTargetPath(value: string | null): void;
    /** A drop the planner accepted, for the host to write. */
    onDropPlan(plan: PageTreeDropPlan, zone: PageTreeDropZone, node: CollabTreeNode): void;
}
/**
 * A page-tree row as a drop target: an edge drop inserts beside the row (a
 * line above or below it), the middle drops inside (the row highlighted).
 */
export declare function pageTreeRowDrop(context: PageTreeRowDropContext, node: CollabTreeNode): {
    onDragOver: (event: RowDragEvent) => void;
    onDragLeave: (event: RowDragEvent) => void;
    onDrop: (event: RowDragEvent) => void;
    className: string;
};
/**
 * Move or reorder a page in the page tree through the session. Says what
 * happened: refused for a taken name or a cycle, nothing to do, or done.
 */
export declare function movePageInTree(session: PageTreeSession, tree: CollabTreeNode[], page: SharedDocument, parentId: string | null, options?: {
    parentKind?: SharedParentKind;
    sortOrder?: number | null;
}): 'taken' | 'cycle' | 'unchanged' | 'reordered' | 'moved';
/** Where a move puts a row: under a page or typed page (null id = root), or back under its own type. */
export type PageTreeDestination = {
    parentId: string | null;
    parentKind: SharedParentKind;
} | {
    underType: true;
};
/**
 * Send a typed page to a destination through the session, refusing one that
 * would put it inside itself (also through its type). Every path uses this:
 * drops, the row menu's "Back under its type" and the move dialog.
 */
export declare function moveItemInTree(session: PageTreeSession, tree: CollabTreeNode[], itemId: string, destination: PageTreeDestination): 'cycle' | ReturnType<PageTreeSession['setItemPlacement']>;
/** Apply one row's write from a drop plan through the docs session. */
export declare function applyPageTreeWrite(session: PageTreeSession, write: PageTreeWrite, onError: (error: unknown) => void): void;
/**
 * Whether moving the row `movingNodeId` under a row (`nodeId`, null for root)
 * or, for a typed page, back under its own type would put it inside itself, walking up
 * the tree as shown, type nodes included. The menu and the move dialog ask
 * this before writing; drops go through `planPageTreeDrop`, which does the
 * same.
 */
export declare function treeMoveRefused(tree: CollabTreeNode[], movingNodeId: string, target: {
    nodeId: string | null;
} | {
    underOwnType: true;
}): boolean;
/** The tree for a scope: the one page tree when the store says so, else folders. */
export declare function buildCollabTreeForScope(input: CollabPageTreeInput & {
    pageTree: boolean;
    documents: SharedDocument[];
    folders: SharedFolder[];
}): CollabTreeNode[];
export {};
