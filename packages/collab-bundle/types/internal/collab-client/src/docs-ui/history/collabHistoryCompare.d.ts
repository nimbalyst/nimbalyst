/**
 * What the shared-document history dialog compares for a selection.
 *
 * Kept free of React and Electron so a web history surface can reuse it: the
 * inputs are revision metadata, the outputs are plain text (markdown for
 * markdown pages) for a diff viewer.
 */
import type { DocRevisionMetadata } from '@nimbalyst/collab-protocol';
/**
 * `previous`: the selected revision against the one saved before it.
 * `current`: the selected revision against the page as it is now.
 * `full`: the selected revision's contents, no diff.
 */
export type CollabHistoryCompareMode = 'previous' | 'current' | 'full';
export type CollabHistorySide = {
    kind: 'revision';
    revisionId: string;
    contentFormat: string;
} | {
    kind: 'current';
};
export type CollabHistoryComparePlan = {
    kind: 'none';
} | {
    kind: 'single';
    side: Extract<CollabHistorySide, {
        kind: 'revision';
    }>;
} | {
    kind: 'diff';
    old: CollabHistorySide;
    new: CollabHistorySide;
    /** Which side is the selected revision, for the no-diff fallback. */
    selected: 'old' | 'new';
};
export type CollabHistoryCompareContent = {
    kind: 'none';
}
/** `text` is null when this document type has no text projection. */
 | {
    kind: 'single';
    text: string | null;
} | {
    kind: 'diff';
    oldText: string;
    newText: string;
};
export interface CollabHistoryCompareLoaders {
    revision(revisionId: string, contentFormat: string): Promise<string | null>;
    current(): Promise<string | null>;
}
/**
 * @param revisions newest first, as the server lists them.
 * @param canReadCurrent whether the open editor can export its live content.
 */
export declare function planCollabHistoryCompare(revisions: readonly DocRevisionMetadata[], selectedId: string | null, mode: CollabHistoryCompareMode, canReadCurrent: boolean): CollabHistoryComparePlan;
export declare function loadCollabHistoryCompare(plan: CollabHistoryComparePlan, loaders: CollabHistoryCompareLoaders): Promise<CollabHistoryCompareContent>;
