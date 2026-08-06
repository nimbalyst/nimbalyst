import type { SharedDocument } from './types';
export type DocFreshness = 'new' | 'updated';
export interface ChangedSharedDoc {
    doc: SharedDocument;
    freshness: DocFreshness;
}
/** Favorited docs in favorite order, resolved to current index entries. */
export declare function selectFavoriteDocs(favorites: readonly string[], docs: readonly SharedDocument[]): SharedDocument[];
/**
 * Opened docs, most-recently-opened first (excludes never-opened). Driven by
 * the `openedAt` watermark — NOT read receipts — so bulk "Mark all as read"
 * (which advances receipts but opens nothing) never surfaces docs here.
 */
export declare function selectRecentDocs(docs: readonly SharedDocument[], openedAt: Readonly<Record<string, number>>, limit?: number): SharedDocument[];
/**
 * Unread docs classified 'new' (never viewed) vs 'updated' (viewed, changed
 * since), most-recently-updated first. `unreadFn` is injected so callers pass
 * the shared read-receipt resolver.
 */
export declare function classifyChangedDocs(docs: readonly SharedDocument[], unreadFn: (doc: SharedDocument) => {
    unread: boolean;
    hasReceipt: boolean;
}): ChangedSharedDoc[];
