import type { CollabTreeNode } from '@nimbalyst/collab-client/docs';

/** The key a row's open/closed state is stored under in the sidebar. */
export function expansionKeyOf(node: CollabTreeNode): string {
  return node.type === 'type' || node.type === 'item' ? node.id : node.path;
}

/**
 * The expansion keys of every row above the open typed page or type, outermost
 * first, so the sidebar can open them to show it. Null when the target is not
 * in the tree (yet: types and items arrive after the pages).
 */
export function revealKeysFor(
  nodes: readonly CollabTreeNode[],
  target: { itemId: string | null; typeId: string | null },
): string[] | null {
  for (const node of nodes) {
    if (
      (target.itemId && node.type === 'item' && node.itemId === target.itemId)
      || (target.typeId && node.type === 'type' && node.typeId === target.typeId)
    ) return [];
    const children = 'children' in node ? node.children : undefined;
    if (!children?.length) continue;
    const below = revealKeysFor(children, target);
    if (below) return [expansionKeyOf(node), ...below];
  }
  return null;
}
