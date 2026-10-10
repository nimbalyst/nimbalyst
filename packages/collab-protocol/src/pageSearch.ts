/**
 * Page search: find pages by the text in their bodies.
 *
 * The Team section asks the TeamRoom (`pageSearchQuery`), which keeps a search
 * index of every team page body, typed-page body (`tracker-content/<itemId>`)
 * and type-page prose (`type-page:<typeId>`). The Personal section answers
 * the same question from the desktop's local pages store. Both use the
 * helpers here, so a query matches the same pages and shows the same snippet
 * whichever section answers it.
 *
 * Matching: every query term must appear in the body (or the title) as the
 * start of a word; the last term also matches as a prefix while it is being
 * typed (no trailing space). Case and diacritics are ignored.
 *
 * Pure and dependency-free: imported by the sync worker, the desktop main
 * process and the clients.
 */

export type PageSearchHitKind = 'page' | 'typed' | 'typePage';

/** A highlighted range in a hit's snippet: `snippet.slice(start, end)`. */
export interface PageSearchHighlight {
  start: number;
  end: number;
}

/** One page whose text matches a query. */
export interface PageSearchHit {
  kind: PageSearchHitKind;
  /** The page's id: a document id (page), item id (typed page) or type id (type page). */
  id: string;
  /** The body's document id: the page id, `tracker-content/<itemId>` or `type-page:<typeId>`. */
  documentId: string;
  /**
   * The page title, when the answering side knows it. A typed page's title is
   * null from the Team index: the caller fills it from its own tree, and drops
   * a hit its tree does not hold (archived, or not synced yet).
   */
  title: string | null;
  /** A typed page's issue key, when it has one. */
  issueKey: string | null;
  /** Plain text around the first match, with `…` where it was cut. */
  snippet: string;
  /** Where the query terms are in `snippet`. */
  highlights: PageSearchHighlight[];
  /** When the body last changed, ms since epoch; null when unknown. */
  updatedAt: number | null;
  /** Relevance; higher first. Only comparable within one response. */
  score: number;
}

export interface PageSearchRequest {
  query: string;
  /** At most this many hits (default `PAGE_SEARCH_DEFAULT_LIMIT`, at most `PAGE_SEARCH_MAX_LIMIT`). */
  limit?: number;
  /**
   * Only typed pages of these types (their primary type). Pages and type pages
   * always pass. Applied before the limit. Absent: every type; empty: no typed
   * pages. At most `PAGE_SEARCH_MAX_TYPE_IDS` are read.
   */
  typeIds?: string[];
}

export interface PageSearchResponse {
  hits: PageSearchHit[];
  /** `partial` while the index has not read every page once yet. */
  status: 'ready' | 'partial';
}

/** Client -> TeamRoom: search one project's pages. */
export interface TeamPageSearchQueryMessage {
  type: 'pageSearchQuery';
  /** Echoed on the response so a client can run several searches at once. */
  requestId: string;
  projectId: string;
  query: string;
  /**
   * Only typed pages of these types (their primary type). Pages and type pages
   * always pass. Applied before the limit. Absent: every type; empty: no typed
   * pages. At most `PAGE_SEARCH_MAX_TYPE_IDS` are read.
   */
  typeIds?: string[];
  limit?: number;
}

/** TeamRoom -> the asking connection only. */
export interface TeamPageSearchResponseMessage {
  type: 'pageSearchResponse';
  requestId: string;
  hits: PageSearchHit[];
  status: 'ready' | 'partial';
}

export const PAGE_SEARCH_DEFAULT_LIMIT = 20;
export const PAGE_SEARCH_MAX_LIMIT = 50;
/** Query text past this is ignored. */
export const PAGE_SEARCH_MAX_QUERY = 200;
/** Terms past this many are ignored. */
export const PAGE_SEARCH_MAX_TERMS = 8;
/** Type ids past this many are ignored. */
export const PAGE_SEARCH_MAX_TYPE_IDS = 200;
/** Body text past this many characters is not searched. */
export const PAGE_SEARCH_MAX_TEXT = 100_000;
/** A term is at least this long; shorter words are not indexed. */
export const PAGE_SEARCH_MIN_TERM = 2;
/** Longer words are cut to this many characters. */
export const PAGE_SEARCH_MAX_TERM = 40;
/** The last query term matches as a prefix from this many characters. */
export const PAGE_SEARCH_MIN_PREFIX = 3;
/** Prefixes are indexed up to this many characters; a longer last term matches whole. */
export const PAGE_SEARCH_MAX_PREFIX = 12;
const SNIPPET_LENGTH = 180;
const SNIPPET_LEAD = 50;

/** The type filter a request carries: null for none (every type), else the listed ids. */
export function pageSearchTypeFilter(typeIds: unknown): Set<string> | null {
  if (!Array.isArray(typeIds)) return null;
  return new Set(typeIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, PAGE_SEARCH_MAX_TYPE_IDS));
}

export function pageSearchLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return PAGE_SEARCH_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), PAGE_SEARCH_MAX_LIMIT);
}

/** The kind and page id a body document id names. */
export function pageSearchSource(documentId: string): { kind: PageSearchHitKind; id: string } {
  if (documentId.startsWith('tracker-content/')) return { kind: 'typed', id: documentId.slice('tracker-content/'.length) };
  if (documentId.startsWith('type-page:')) return { kind: 'typePage', id: documentId.slice('type-page:'.length) };
  return { kind: 'page', id: documentId };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * A markdown body as the plain text search reads: link and image targets,
 * markup characters, html tags and frontmatter dropped; one line per block.
 */
export function pageSearchTextFromMarkdown(markdown: string): string {
  let text = markdown.replace(/^﻿/, '');
  text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw;
    if (/^\s*(```|~~~)/.test(line)) continue;
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue;
    line = line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)(\{[^}]*\})?/g, '$1')
      .replace(/\[([^\]]*)\]\{[^}]*\}/g, '$1')
      .replace(/<[^>\n]+>/g, ' ')
      .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
      .replace(/(\*\*|__|~~|`)/g, '')
      .replace(/(^|\s)[*_](\S)/g, '$1$2')
      .replace(/(\S)[*_](?=\s|$|[.,;:!?)])/g, '$1')
      .replace(/\s*\|\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (line) lines.push(line);
  }
  return lines.join('\n').slice(0, PAGE_SEARCH_MAX_TEXT);
}

/** One character as search compares it: lower case, no diacritics. */
function foldChar(ch: string): string {
  return ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Text folded for matching, with each folded character's index in the original. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let index = 0;
  for (const ch of text) {
    const f = foldChar(ch);
    for (let i = 0; i < f.length; i++) map.push(index);
    folded += f;
    index += ch.length;
  }
  map.push(index);
  return { folded, map };
}

const WORD = /[\p{L}\p{N}]+/gu;

/** The words of `text`, folded, at least `PAGE_SEARCH_MIN_TERM` long, cut to `PAGE_SEARCH_MAX_TERM`. */
export function pageSearchWords(text: string): string[] {
  const words: string[] = [];
  for (const match of foldWithMap(text).folded.matchAll(WORD)) {
    const word = match[0];
    if (word.length >= PAGE_SEARCH_MIN_TERM) words.push(word.slice(0, PAGE_SEARCH_MAX_TERM));
  }
  return words;
}

/** A parsed query: distinct folded terms, the last one a prefix while typing. */
export interface PageSearchQueryTerms {
  terms: string[];
  /** True when the last term may match the start of a longer word. */
  prefixLast: boolean;
}

export function pageSearchQueryTerms(query: string): PageSearchQueryTerms {
  const text = query.slice(0, PAGE_SEARCH_MAX_QUERY);
  const words = [...new Set(pageSearchWords(text))].slice(0, PAGE_SEARCH_MAX_TERMS);
  const last = words[words.length - 1];
  const prefixLast = !!last && !/[^\p{L}\p{N}]$/u.test(text) && last.length >= PAGE_SEARCH_MIN_PREFIX;
  return { terms: words, prefixLast };
}

/**
 * The keys a body is indexed under: `t:<word>` for each distinct word with its
 * count, and `p:<prefix>` for the prefixes the last query term can match.
 */
export function pageSearchIndexKeys(text: string): Map<string, number> {
  const keys = new Map<string, number>();
  for (const word of pageSearchWords(text)) {
    keys.set(`t:${word}`, (keys.get(`t:${word}`) ?? 0) + 1);
  }
  for (const key of [...keys.keys()]) {
    const word = key.slice(2);
    for (let n = PAGE_SEARCH_MIN_PREFIX; n < word.length && n <= PAGE_SEARCH_MAX_PREFIX; n++) {
      const prefix = `p:${word.slice(0, n)}`;
      keys.set(prefix, (keys.get(prefix) ?? 0) + (keys.get(key) ?? 0));
    }
  }
  return keys;
}

/** The index keys that may match each query term (any one of a term's keys matches it). */
export function pageSearchQueryKeys(parsed: PageSearchQueryTerms): string[][] {
  return parsed.terms.map((term, i) => {
    const last = i === parsed.terms.length - 1;
    if (!last || !parsed.prefixLast || term.length > PAGE_SEARCH_MAX_PREFIX) return [`t:${term}`];
    return [`t:${term}`, `p:${term}`];
  });
}

/** Ranges in `text` where each term starts a word (and, unless it is the prefix term, ends one). */
function termRanges(text: string, parsed: PageSearchQueryTerms): Array<PageSearchHighlight & { term: number }> {
  if (parsed.terms.length === 0) return [];
  const { folded, map } = foldWithMap(text);
  const ranges: Array<PageSearchHighlight & { term: number }> = [];
  for (const match of folded.matchAll(WORD)) {
    const word = match[0];
    const start = match.index ?? 0;
    parsed.terms.forEach((term, i) => {
      const prefix = i === parsed.terms.length - 1 && parsed.prefixLast;
      const cut = word.slice(0, PAGE_SEARCH_MAX_TERM);
      if (prefix ? !cut.startsWith(term) : cut !== term) return;
      const end = start + (prefix ? term.length : word.length);
      ranges.push({ start: map[start]!, end: map[end]!, term: i });
    });
  }
  return ranges;
}

/** Does `text` contain every query term? */
export function pageSearchMatches(text: string, parsed: PageSearchQueryTerms): boolean {
  if (parsed.terms.length === 0) return false;
  const found = new Set(termRanges(text, parsed).map((range) => range.term));
  return found.size === parsed.terms.length;
}

/**
 * Plain text around the place where the most distinct terms appear close
 * together, cut at word boundaries, with the terms' ranges in it. Without a
 * match, the start of the text.
 */
export function pageSearchSnippet(text: string, parsed: PageSearchQueryTerms): { snippet: string; highlights: PageSearchHighlight[] } {
  const flat = text.replace(/\s+/g, ' ').trim();
  const ranges = termRanges(flat, parsed);
  let anchor = 0;
  if (ranges.length > 0) {
    let best = -1;
    for (const range of ranges) {
      const distinct = new Set(ranges.filter((r) => r.start >= range.start && r.end <= range.start + SNIPPET_LENGTH - SNIPPET_LEAD).map((r) => r.term)).size;
      if (distinct > best) {
        best = distinct;
        anchor = range.start;
      }
    }
  }
  let start = Math.max(0, anchor - SNIPPET_LEAD);
  if (start > 0) {
    const space = flat.indexOf(' ', start);
    start = space >= 0 && space < anchor ? space + 1 : anchor;
  }
  let end = Math.min(flat.length, start + SNIPPET_LENGTH);
  if (end < flat.length) {
    const space = flat.lastIndexOf(' ', end);
    if (space > start) end = space;
  }
  const lead = start > 0 ? '…' : '';
  const snippet = `${lead}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
  const highlights = ranges
    .filter((range) => range.start >= start && range.end <= end)
    .map((range) => ({ start: range.start - start + lead.length, end: range.end - start + lead.length }));
  return { snippet, highlights };
}

/**
 * BM25 relevance of one body for the query terms: `counts[i]` is how often term
 * i occurs (its best-matching key), `docs[i]` how many bodies contain it.
 */
export function pageSearchScore(input: {
  counts: number[];
  docs: number[];
  total: number;
  length: number;
  averageLength: number;
}): number {
  const k1 = 1.2;
  const b = 0.75;
  const norm = 1 - b + b * (input.length / Math.max(1, input.averageLength));
  let score = 0;
  input.counts.forEach((count, i) => {
    const df = input.docs[i] ?? 0;
    const idf = Math.log(1 + (input.total - df + 0.5) / (df + 0.5));
    score += idf * ((count * (k1 + 1)) / (count + k1 * norm));
  });
  return Math.round(score * 1000) / 1000;
}

/** Added to a hit's score when its title holds every term. */
export const PAGE_SEARCH_TITLE_BOOST = 5;

// ---------------------------------------------------------------------------
// Requests over the TeamRoom socket
// ---------------------------------------------------------------------------

let nextSearchRequest = 0;

/**
 * Searches in flight on one TeamRoom connection, matched by request id. A
 * search is a read: never queued offline; it answers null when the socket is
 * down or the server does not reply in time.
 */
export class PageSearchRequests {
  private readonly pending = new Map<string, { resolve: (result: PageSearchResponse | null) => void; timer: ReturnType<typeof setTimeout> }>();

  /** `send` returns false when the message could not go out. */
  request(
    send: (message: TeamPageSearchQueryMessage) => boolean,
    projectId: string,
    request: PageSearchRequest,
    timeoutMs: number,
  ): Promise<PageSearchResponse | null> {
    const requestId = `search-${Date.now().toString(36)}-${(nextSearchRequest++).toString(36)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, null), timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      const message: TeamPageSearchQueryMessage = {
        type: 'pageSearchQuery', requestId, projectId, query: request.query,
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
        ...(request.typeIds !== undefined ? { typeIds: request.typeIds } : {}),
      };
      if (!send(message)) this.settle(requestId, null);
    });
  }

  receive(message: TeamPageSearchResponseMessage): void {
    this.settle(message.requestId, { hits: message.hits, status: message.status });
  }

  /** Every open search answers null (disconnect, destroy). */
  cancelAll(): void {
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, null);
  }

  private settle(requestId: string, result: PageSearchResponse | null): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(result);
  }
}
