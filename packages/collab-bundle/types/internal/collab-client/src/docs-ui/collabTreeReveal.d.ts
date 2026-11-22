import type { CollabTreeNode } from '../docs/index';
/** The key a row's open/closed state is stored under in the sidebar. */
export declare function expansionKeyOf(node: CollabTreeNode): string;
/**
 * The item row the open page is drawn as, if any. A local wiki typed page
 * opens as a file tab, not an item tab, yet the sidebar shows it as the row of
 * its tracker record, whose itemId is the page id.
 */
export declare function itemRowIdForDocument(nodes: readonly CollabTreeNode[], documentId: string | null): string | null;
/**
 * The expansion keys of every row above the open page, typed page or type,
 * outermost first, so the sidebar can open them to show it. Null when the
 * target is not in the tree (yet: types and items arrive after the pages).
 * A page parented to a typed item sits under item and type rows, which are
 * keyed by id rather than path, so a path-only reveal leaves it hidden.
 */
export declare function revealKeysFor(nodes: readonly CollabTreeNode[], target: {
    itemId: string | null;
    typeId: string | null;
    documentId?: string | null;
}): string[] | null;
