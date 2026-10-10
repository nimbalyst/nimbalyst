import type { SharedParentKind } from '../../docs/index';
export interface PageTreeAncestorsInput {
    documents: ReadonlyArray<{
        documentId: string;
        title: string;
        documentType?: string;
        parentFolderId?: string | null;
        parentKind?: SharedParentKind;
    }>;
    /** Legacy folders, for a tree that was never converted to pages. */
    folders?: ReadonlyArray<{
        folderId: string;
        name: string;
        parentFolderId?: string | null;
        parentKind?: SharedParentKind;
    }>;
    itemPlacements: ReadonlyArray<{
        itemId: string;
        parentId?: string | null;
        parentKind?: SharedParentKind;
    }>;
    typePlacements: ReadonlyArray<{
        typeId: string;
        parentFolderId?: string | null;
        parentKind?: SharedParentKind;
    }>;
    /** A typed page's title and type; null when unknown here. */
    item(itemId: string): {
        title: string;
        typeId: string;
    } | null;
    typeName(typeId: string): string | null;
}
export type PageTreeNodeRef = {
    id: string;
    kind: SharedParentKind | 'type';
};
/** One node above a position, with its name: what a clickable crumb opens. A typed page carries its type. */
export type PageTreeAncestor = PageTreeNodeRef & {
    name: string;
    typeId?: string;
};
/** The ref's own name and everything above it. A missing node or a cycle stops the walk. */
export declare function pageTreeAncestors(start: PageTreeNodeRef | null, tree: PageTreeAncestorsInput): string[];
/** `pageTreeAncestors` with each node's id and kind, root first. */
export declare function pageTreeAncestorRefs(start: PageTreeNodeRef | null, tree: PageTreeAncestorsInput): PageTreeAncestor[];
