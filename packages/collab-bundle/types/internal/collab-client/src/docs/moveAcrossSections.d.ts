/**
 * Moving a page, with the plain pages under it, from one Pages section to the
 * other (Personal to Team, or Team to Personal). The two sections are
 * different stores, so a move is a copy that must be confirmed before the
 * source is touched:
 *
 *   1. Read the source subtree; refuse what can't cross yet (typed pages and
 *      types, whose type belongs to one section; images, whose files live in
 *      one section's asset store).
 *   2. Copy each page, parents first, and read each body back from the
 *      destination.
 *   3. Check no source page changed while it was copied.
 *   4. Only then move the source page (and its subtree) to its section's Trash.
 *
 * Any failure before step 4 sends the copies to the destination's Trash and
 * leaves the source as it was. Pure over its dependencies, like Set type.
 */
import type { PageFields } from './pageFields';
import type { CollabPlacementWriteResult } from './session';
import { type SharedDocument } from './types';
export interface MovePageNode {
    documentId: string;
    title: string;
    fields?: PageFields;
    children: MovePageNode[];
}
export interface MovePageCopy {
    markdown: string;
    /** The source's version where it has one (Personal), for the unchanged check. */
    version?: number;
}
export interface MoveAcrossSectionsDependencies {
    /** The page and its plain descendants, or why it can't move. */
    readTree(pageId: string): {
        ok: true;
        root: MovePageNode;
    } | {
        ok: false;
        error: string;
    };
    /** The source page's body, after any open editor's edits are stored. */
    readSource(pageId: string): Promise<MovePageCopy>;
    /** Whether the source still holds what was copied. */
    sourceUnchanged(pageId: string, copy: MovePageCopy): Promise<boolean>;
    /** Creates the page in the destination with its body; returns its id. */
    createDestination(input: {
        title: string;
        markdown: string;
        parentId: string | null;
        fields?: PageFields;
    }): Promise<string>;
    /** The destination page's body, as stored. */
    readDestination(pageId: string): Promise<string>;
    /** Rollback: the copy and everything under it to the destination's Trash. */
    trashDestination(pageId: string): Promise<void>;
    /** The source page and its subtree to the source's Trash. */
    trashSource(pageId: string): Promise<CollabPlacementWriteResult>;
}
export type MoveAcrossSectionsResult = {
    ok: true;
    pageId: string;
    moved: number;
} | {
    ok: false;
    error: string;
};
/** Line endings, trailing spaces and blank-line runs differ across a markdown round trip; nothing else may. */
export declare function normalizeBodyForComparison(markdown: string): string;
/** Markdown or HTML images, whose files stay in the source section's asset store. */
export declare function bodyHasImages(markdown: string): boolean;
export declare function moveAcrossSections(pageId: string, deps: MoveAcrossSectionsDependencies): Promise<MoveAcrossSectionsResult>;
/**
 * The page and the plain pages under it. Typed pages and types can't cross
 * (a type belongs to one section), nor can a type's prose or a non-markdown page.
 */
export declare function readMoveTree(pageId: string, documents: readonly SharedDocument[], placements: {
    items: ReadonlyArray<{
        parentId?: string | null;
    }>;
    types: ReadonlyArray<{
        parentFolderId?: string | null;
    }>;
}): {
    ok: true;
    root: MovePageNode;
} | {
    ok: false;
    error: string;
};
