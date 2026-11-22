import type { CollabTreeNode } from '@nimbalyst/collab-client/docs';

/** The key a row's open/closed state is stored under in the sidebar. */
export function expansionKeyOf(node: CollabTreeNode): string {
  return node.type === 'type' || node.type === 'item' ? node.id : node.path;
}

/**
 * The item row the open page is drawn as, if any. A local wiki typed page
 * opens as a file tab, not an item tab, yet the sidebar shows it as the row of
 * its tracker record, whose itemId is the page id.
 */
export function itemRowIdForDocument(nodes: readonly CollabTreeNode[], documentId: string | null): string | null {
  if (!documentId) return null;
  for (const node of nodes) {
    if (node.type === 'item' && node.itemId === documentId) return documentId;
    const children = 'children' in node ? node.children : undefined;
    if (children?.length && itemRowIdForDocument(children, documentId)) return documentId;
  }
  return null;
}

/**
 * The expansion keys of every row above the open page, typed page or type,
 * outermost first, so the sidebar can open them to show it. Null when the
 * target is not in the tree (yet: types and items arrive after the pages).
 * A page parented to a typed item sits under item and type rows, which are
 * keyed by id rather than path, so a path-only reveal leaves it hidden.
 */
export function revealKeysFor(
  nodes: readonly CollabTreeNode[],
  target: { itemId: string | null; typeId: string | null; documentId?: string | null },
): string[] | null {
  for (const node of nodes) {
    if (
      (target.itemId && node.type === 'item' && node.itemId === target.itemId)
      || (target.typeId && node.type === 'type' && node.typeId === target.typeId)
      || (target.documentId && node.type === 'document' && node.document.documentId === target.documentId)
    ) return [];
    const children = 'children' in node ? node.children : undefined;
    if (!children?.length) continue;
    const below = revealKeysFor(children, target);
    if (below) return [expansionKeyOf(node), ...below];
  }
  return null;
}
