/**
 * Search's page-text query against the section's index. Debounced; while the
 * index answers `partial` (it has not read every page yet) it asks again a
 * bounded number of times, and it asks again whenever the section's pages
 * change, so a partial or stale answer does not stand for good.
 */
import { useEffect, useState } from 'react';
import { PAGE_SEARCH_MAX_LIMIT, type PageSearchHit, type PageSearchRequest, type PageSearchResponse } from '@nimbalyst/collab-protocol';

const DEBOUNCE_MS = 200;
export const PAGES_BODY_PARTIAL_RETRY_MS = 2_000;
export const PAGES_BODY_PARTIAL_RETRIES = 5;
/** Hits asked for: the index's most, so filters it cannot apply have the most to work with. */
export const PAGES_BODY_LIMIT = PAGE_SEARCH_MAX_LIMIT;

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
export function usePagesBodyHits(
  query: string,
  searchPages: ((request: PageSearchRequest) => Promise<PageSearchResponse | null>) | undefined,
  { typeIds, pagesRevision }: PagesBodyHitsOptions,
): PagesBodyHits | null {
  const [result, setResult] = useState<PagesBodyHits | null>(null);
  const trimmed = query.trim();
  // Undefined (every type) and [] (no typed pages) ask different things.
  const typeKey = typeIds ? `[${typeIds.join('\u0000')}` : '*';
  useEffect(() => {
    if (!trimmed || !searchPages) {
      setResult(null);
      return undefined;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    // `typeIds` narrows the index before its limit.
    const request: PageSearchRequest = {
      query: trimmed,
      limit: PAGES_BODY_LIMIT,
      ...(typeKey === '*' ? {} : { typeIds: typeKey === '[' ? [] : typeKey.slice(1).split('\u0000') }),
    };
    const ask = (attempt: number) => {
      searchPages(request)
        .then((response) => {
          if (!live) return;
          setResult({ query: trimmed, hits: response?.hits ?? null, status: response ? response.status : 'unavailable' });
          if (response?.status === 'partial' && attempt < PAGES_BODY_PARTIAL_RETRIES) {
            timer = setTimeout(() => ask(attempt + 1), PAGES_BODY_PARTIAL_RETRY_MS);
          }
        })
        .catch((error: unknown) => {
          // A failed search leaves title matches standing; the note says text matches are missing.
          console.warn('[PagesSearchView] Page text search failed:', error);
          if (live) setResult({ query: trimmed, hits: null, status: 'unavailable' });
        });
    };
    timer = setTimeout(() => ask(0), DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [trimmed, searchPages, typeKey, pagesRevision]);
  return result?.query === trimmed ? result : null;
}
