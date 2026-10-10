/**
 * Page search for a Pages section: the section's body search (its data
 * source's `searchPages`, the server index for Team or the local store for
 * Personal) merged with title matches from the pages the caller shows.
 *
 * Titles are matched here, not by the body search, because the caller already
 * holds them: the session holds page and type-page titles, and the Pages UI
 * and the agent tools hold typed-page titles in their tree. A typed-page body
 * hit arrives with no title; `nameTypedHits` names it from the caller's tree
 * and drops it when the tree does not hold it (archived, not synced yet).
 */
import { type PageSearchHit, type PageSearchRequest, type PageSearchResponse } from '@nimbalyst/collab-protocol';
import type { SharedDocument } from './types';
/** The body search a section offers (`CollabDocsDataSource.searchPages`); absent when it has none. */
export interface PageBodySearch {
    searchPages?(request: PageSearchRequest): Promise<PageSearchResponse | null>;
}
/** A page the caller shows, as title search reads it. */
export interface PageSearchTitleEntry {
    /** The body's document id: page id, `tracker-content/<itemId>` or `type-page:<typeId>`. */
    documentId: string;
    title: string;
    issueKey?: string | null;
    updatedAt?: number | null;
}
/** Title matches: every query term in the title. Their snippet is empty. */
export declare function pageSearchTitleHits(query: string, entries: readonly PageSearchTitleEntry[]): PageSearchHit[];
/**
 * Body hits and title hits as one list, best first: a page found both ways
 * keeps its body snippet and gains the title boost.
 */
export declare function mergePageSearchHits(bodyHits: readonly PageSearchHit[], titleHits: readonly PageSearchHit[], limit?: number): PageSearchHit[];
/**
 * Typed-page hits named from the caller's tree; a typed hit the tree does not
 * hold is dropped. Other hits pass through.
 */
export declare function nameTypedHits(hits: readonly PageSearchHit[], typedPage: (itemId: string) => {
    title: string;
    issueKey?: string | null;
} | null): PageSearchHit[];
/** The session's live pages and type pages as title entries. */
export declare function sessionTitleEntries(documents: readonly SharedDocument[]): PageSearchTitleEntry[];
/**
 * A section's search: body hits from its data source, page and type-page
 * titles filled in and matched from `documents`. Typed hits keep a null title
 * for the caller to name (`nameTypedHits`). A body hit for a page `documents`
 * does not hold live (trashed, or not loaded) is dropped. Null when the
 * section cannot search now; a source with no body search answers titles only.
 */
export declare function searchSectionPages(dataSource: PageBodySearch, documents: readonly SharedDocument[], request: PageSearchRequest): Promise<PageSearchResponse | null>;
