import type { CollabTreeNode } from '../docs/index';
/** The key a row's open/closed state is stored under in the sidebar. */
export declare function expansionKeyOf(node: CollabTreeNode): string;
/**
 * The expansion keys of every row above the open typed page or type, outermost
 * first, so the sidebar can open them to show it. Null when the target is not
 * in the tree (yet: types and items arrive after the pages).
 */
export declare function revealKeysFor(nodes: readonly CollabTreeNode[], target: {
    itemId: string | null;
    typeId: string | null;
}): string[] | null;
