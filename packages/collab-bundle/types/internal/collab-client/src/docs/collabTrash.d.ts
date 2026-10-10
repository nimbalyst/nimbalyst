import type { SharedDocument } from './types';
/** A page and the pages that went to Trash with it (below it, same trash time), the page first. */
export declare function pagesTrashedWith(documents: SharedDocument[], documentId: string): string[];
/**
 * Whether restoring `documentId` (with `restoring`, the pages coming back with
 * it) would leave it under a page that is not in the tree: one deleted for
 * good, or one still in Trash. Such a page goes to the section root. A typed
 * page parent is not checked; the page tree holds no list of typed pages.
 */
export declare function restoredParentGone(documents: SharedDocument[], documentId: string, restoring: ReadonlySet<string>): boolean;
export interface CollabTrashEntry {
    document: SharedDocument;
    /** Pages that went to Trash with it and come back with it. */
    insideCount: number;
}
/**
 * One entry per page a person (or agent) sent to Trash, newest first; the
 * pages that went with it are counted on it, not listed. A type's prose page
 * is not counted as a page.
 */
export declare function listTrashEntries(trashed: SharedDocument[]): CollabTrashEntry[];
