import { type PageSearchHit, type PageSearchRequest, type PageSearchResponse } from '@nimbalyst/collab-protocol';
export declare const PAGES_BODY_PARTIAL_RETRY_MS = 2000;
export declare const PAGES_BODY_PARTIAL_RETRIES = 5;
/** Hits asked for: the index's most, so filters it cannot apply have the most to work with. */
export declare const PAGES_BODY_LIMIT = 50;
export interface PagesBodyHits {
    query: string;
    hits: PageSearchHit[] | null;
    status: 'ready' | 'partial' | 'unavailable';
}
export interface PagesBodyHitsOptions {
    /** The typed pages' types to search (`pagesBodySearchTypeIds`); undefined searches every type. */
    typeIds: readonly string[] | undefined;
    /** Changes when the section's pages change. */
    pagesRevision: string;
}
/** The index's answer for `query`; null while there is no query or no index. */
export declare function usePagesBodyHits(query: string, searchPages: ((request: PageSearchRequest) => Promise<PageSearchResponse | null>) | undefined, { typeIds, pagesRevision }: PagesBodyHitsOptions): PagesBodyHits | null;
