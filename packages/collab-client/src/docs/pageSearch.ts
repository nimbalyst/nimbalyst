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
import {
  PAGE_SEARCH_TITLE_BOOST,
  pageSearchLimit,
  pageSearchMatches,
  pageSearchQueryTerms,
  pageSearchSource,
  type PageSearchHit,
  type PageSearchRequest,
  type PageSearchResponse,
} from '@nimbalyst/collab-protocol';
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
export function pageSearchTitleHits(query: string, entries: readonly PageSearchTitleEntry[]): PageSearchHit[] {
  const parsed = pageSearchQueryTerms(query);
  if (parsed.terms.length === 0) return [];
  return entries.filter((entry) => pageSearchMatches(entry.title, parsed)).map((entry) => ({
    ...pageSearchSource(entry.documentId),
    documentId: entry.documentId,
    title: entry.title,
    issueKey: entry.issueKey ?? null,
    snippet: '',
    highlights: [],
    updatedAt: entry.updatedAt ?? null,
    score: PAGE_SEARCH_TITLE_BOOST,
  }));
}

/**
 * Body hits and title hits as one list, best first: a page found both ways
 * keeps its body snippet and gains the title boost.
 */
export function mergePageSearchHits(bodyHits: readonly PageSearchHit[], titleHits: readonly PageSearchHit[], limit?: number): PageSearchHit[] {
  const merged = new Map<string, PageSearchHit>();
  for (const hit of bodyHits) merged.set(hit.documentId, { ...hit });
  for (const hit of titleHits) {
    const body = merged.get(hit.documentId);
    merged.set(hit.documentId, body
      ? { ...body, title: body.title ?? hit.title, issueKey: body.issueKey ?? hit.issueKey, score: body.score + hit.score }
      : hit);
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.documentId.localeCompare(b.documentId))
    .slice(0, pageSearchLimit(limit));
}

/**
 * Typed-page hits named from the caller's tree; a typed hit the tree does not
 * hold is dropped. Other hits pass through.
 */
export function nameTypedHits(
  hits: readonly PageSearchHit[],
  typedPage: (itemId: string) => { title: string; issueKey?: string | null } | null,
): PageSearchHit[] {
  const out: PageSearchHit[] = [];
  for (const hit of hits) {
    if (hit.kind !== 'typed') {
      out.push(hit);
      continue;
    }
    const item = typedPage(hit.id);
    if (item) out.push({ ...hit, title: hit.title ?? item.title, issueKey: hit.issueKey ?? item.issueKey ?? null });
  }
  return out;
}

/** The session's live pages and type pages as title entries. */
export function sessionTitleEntries(documents: readonly SharedDocument[]): PageSearchTitleEntry[] {
  return documents
    .filter((document) => document.trashedAt == null && document.title)
    .map((document) => ({ documentId: document.documentId, title: document.title, updatedAt: document.updatedAt ?? null }));
}

/**
 * A section's search: body hits from its data source, page and type-page
 * titles filled in and matched from `documents`. Typed hits keep a null title
 * for the caller to name (`nameTypedHits`). A body hit for a page `documents`
 * does not hold live (trashed, or not loaded) is dropped. Null when the
 * section cannot search now; a source with no body search answers titles only.
 */
export async function searchSectionPages(
  dataSource: PageBodySearch,
  documents: readonly SharedDocument[],
  request: PageSearchRequest,
): Promise<PageSearchResponse | null> {
  const entries = sessionTitleEntries(documents);
  const live = new Map(entries.map((entry) => [entry.documentId, entry]));
  const body = dataSource.searchPages ? await dataSource.searchPages({ ...request, limit: pageSearchLimit(request.limit) }) : null;
  if (dataSource.searchPages && !body) return null;
  const bodyHits = (body?.hits ?? []).flatMap((hit) => {
    if (hit.kind === 'typed') return [hit];
    const entry = live.get(hit.documentId);
    return entry ? [{ ...hit, title: hit.title ?? entry.title }] : [];
  });
  return {
    hits: mergePageSearchHits(bodyHits, pageSearchTitleHits(request.query, entries), request.limit),
    status: body?.status ?? 'ready',
  };
}
