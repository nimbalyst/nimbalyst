/**
 * Where a typed page or a type sits in the Pages tree, as the page's crumb
 * reads it. Pure over the session's placements and pages, so the desktop and
 * the web console read the same crumb from their own sessions.
 */
import type { TrackerRecord } from '../../../../runtime/src/core/TrackerRecord';
import { type PageTreeAncestor } from '../embed/pageTreeAncestors';
type CrumbParentKind = 'page' | 'item';
export interface CrumbPlacement {
    typeId: string;
    parentFolderId?: string | null;
    parentKind?: CrumbParentKind;
}
export interface CrumbItemPlacement {
    itemId: string;
    parentId?: string | null;
    parentKind?: CrumbParentKind;
}
export interface CrumbFolder {
    folderId: string;
    parentFolderId?: string | null;
    parentKind?: CrumbParentKind;
    name: string;
}
export interface CrumbDocument {
    documentId: string;
    parentFolderId?: string | null;
    parentKind?: CrumbParentKind;
    title: string;
    documentType?: string;
}
export type CrumbItemLookup = (itemId: string) => {
    title: string;
    typeId: string;
} | null;
export interface TrackerPageCrumb {
    /** Ancestor page names, root first. */
    ancestors: string[];
    /** Unplaced items sit under their type, which the crumb then names. */
    underType: boolean;
    /**
     * The same ancestors with what each one opens, root first, followed by the
     * type when `underType`. Absent from crumbs built before it existed.
     */
    path?: PageTreeAncestor[];
}
/**
 * Where a typed page sits in the Pages tree. A placed item reads its own
 * parents (pages and typed pages); an unplaced one sits under its type page,
 * so it reads the type's placement and then the type.
 */
export declare function trackerPageCrumb(itemId: string, typeId: string, tree: {
    itemPlacements: readonly CrumbItemPlacement[];
    typePlacements: readonly CrumbPlacement[];
    documents: readonly CrumbDocument[];
    folders: readonly CrumbFolder[];
    item?: CrumbItemLookup;
}): TrackerPageCrumb;
/** Same crumb, same names: lets a host skip a re-render when only titles elsewhere moved. */
export declare function sameTrackerPageCrumb(left: TrackerPageCrumb, right: TrackerPageCrumb): boolean;
/**
 * The ancestors of a type's placement, root first (the type page's crumb).
 * `folders` may be the session's folder list, which in a page tree is the
 * pages projected as folders.
 */
export declare function trackerPageCrumbFolders(typeId: string, placements: readonly CrumbPlacement[], folders: readonly CrumbFolder[], tree?: {
    itemPlacements?: readonly CrumbItemPlacement[];
    item?: CrumbItemLookup;
}): string[];
/** `trackerPageCrumbFolders` with what each ancestor opens. */
export declare function trackerPageCrumbFolderRefs(typeId: string, placements: readonly CrumbPlacement[], folders: readonly CrumbFolder[], tree?: {
    itemPlacements?: readonly CrumbItemPlacement[];
    item?: CrumbItemLookup;
}): PageTreeAncestor[];
/** A typed page's title and type, for a crumb walking up through typed pages. */
export declare function crumbItemLookup(records: ReadonlyMap<string, TrackerRecord>): CrumbItemLookup;
/**
 * Whether a page should offer its legacy `description` back: only when it
 * holds text the body does not already contain (whitespace aside). Items
 * created with the same text in both fields have nothing to recover. Until
 * the body has loaded there is nothing to compare against, so nothing shows.
 */
export declare function legacyDescriptionToRecover(description: unknown, body: string | null): string | null;
export {};
