import type { CollabTreeDocumentNode, CollabTreeItemNode, CollabTreeNode, CollabTreeTypeNode } from '../docs/index';
export type CollabPageAction = 'newPageInside' | 'rename' | 'moveTo' | 'trash' | 'removeFromTree' | 'backUnderType';
export interface CollabPageActionRequest {
    /** A plain page's document id, a typed page's item id, or (with `kind: 'type'`) a type id. */
    pageId: string;
    action: CollabPageAction;
    /** A type page: its id is a type id, which can repeat a page's. */
    kind?: 'type';
}
export type CollabPageActionTarget = CollabTreeDocumentNode | CollabTreeItemNode | CollabTreeTypeNode;
/** The row the request names, anywhere in the tree. */
export declare function findPageNode(nodes: readonly CollabTreeNode[], request: Pick<CollabPageActionRequest, 'pageId' | 'kind'>): CollabPageActionTarget | null;
export declare function usePageActionRequest({ request, tree, run, onHandled, onMissing, }: {
    request: CollabPageActionRequest | null | undefined;
    tree: readonly CollabTreeNode[];
    run: (target: CollabPageActionTarget, action: CollabPageAction) => void;
    onHandled?: () => void;
    onMissing: () => void;
}): void;
