/**
 * A page action raised outside the tree -- a page's own header menu -- run
 * through the same dialogs and writes its row's context menu uses, so Rename,
 * Move to..., New page inside, Move to Trash and Remove from tree behave the
 * same from both.
 */
import { useEffect } from 'react';
import type { CollabTreeDocumentNode, CollabTreeItemNode, CollabTreeNode, CollabTreeTypeNode } from '@nimbalyst/collab-client/docs';

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
export function findPageNode(nodes: readonly CollabTreeNode[], request: Pick<CollabPageActionRequest, 'pageId' | 'kind'>): CollabPageActionTarget | null {
  for (const node of nodes) {
    if (request.kind === 'type') {
      if (node.type === 'type' && node.typeId === request.pageId) return node;
    } else if (node.type === 'document' && node.document.documentId === request.pageId) {
      return node;
    } else if (node.type === 'item' && node.itemId === request.pageId) {
      return node;
    }
    const children = 'children' in node ? node.children : undefined;
    const found = children?.length ? findPageNode(children, request) : null;
    if (found) return found;
  }
  return null;
}

/** How long a request waits for its page to reach the tree (the page tree loads lazily). */
const MISSING_PAGE_GRACE_MS = 3000;

export function usePageActionRequest({
  request,
  tree,
  run,
  onHandled,
  onMissing,
}: {
  request: CollabPageActionRequest | null | undefined;
  tree: readonly CollabTreeNode[];
  run: (target: CollabPageActionTarget, action: CollabPageAction) => void;
  onHandled?: () => void;
  onMissing: () => void;
}): void {
  useEffect(() => {
    if (!request) return undefined;
    const target = findPageNode(tree, request);
    if (!target) {
      const timer = setTimeout(() => {
        onHandled?.();
        onMissing();
      }, MISSING_PAGE_GRACE_MS);
      return () => clearTimeout(timer);
    }
    onHandled?.();
    run(target, request.action);
    return undefined;
    // `run` closes over the sidebar's latest state; the request is what triggers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, tree]);
}
