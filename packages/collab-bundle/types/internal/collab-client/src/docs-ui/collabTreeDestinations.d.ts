/**
 * The sidebar page tree as rows for a destination picker: same nodes, nesting,
 * names and icons as the tree, so a location is found the way it is in the
 * sidebar. Type collections hold only their own items, so they are shown (the
 * structure has to match) but cannot be picked.
 */
import type { CollabDocumentTypeDescriptor } from '../core/index';
import { type CollabTreeNode, type SharedParentKind } from '../docs/index';
export interface CollabTreeDestination {
    /** The tree row id (`document:`, `item:`, `type:`, `folder:`). */
    key: string;
    /** What a create writes as the parent. */
    parentId: string | null;
    parentKind: SharedParentKind;
    name: string;
    depth: number;
    icon: string;
    /** Icon while expanded, for rows drawn as folders. */
    expandedIcon?: string;
    /** Faint trailing label: a typed page's type, a type's item count. */
    hint?: string;
    selectable: boolean;
    /** Row keys above this one, outermost first. */
    ancestorKeys: string[];
    hasChildren: boolean;
}
export declare function buildCollabTreeDestinations(tree: CollabTreeNode[], descriptors: readonly CollabDocumentTypeDescriptor[]): CollabTreeDestination[];
