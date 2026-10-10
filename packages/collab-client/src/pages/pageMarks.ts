/**
 * Decision and open-question marks across pages, for a view someone places.
 *
 * A mark lives in a page's markdown body (`[sentence]{decided by=...}`); a
 * host answers `listMarks`. Team pages come from the server's marks index
 * (`pageMarksQuery`, mapped by `pageMarkRecordsFromTeamIndex`). The desktop
 * adds its local bodies and merges the two; web uses the index alone. Typed
 * pages are accepted only with server-checked live membership metadata. A source's `subscribe` (`PageMarksChangeFeed`)
 * tells open lists to load again.
 *
 * Logic and contracts only -- no React, no DOM.
 */

import { buildCollabUri, type PageMarkEntry } from '@nimbalyst/collab-protocol';

export type PageMarkKind = 'decided' | 'open';

/** Where the page holding a mark lives. `page` is a plain team page. */
export type PageMarkPageKind = 'page' | 'typed-page' | 'type-page' | 'personal-page';

export interface PageMarkRecord {
  /** Stable id of this mark: the page's uri plus its position in the body. */
  id: string;
  kind: PageMarkKind;
  /** The marked sentence as inline markdown. */
  text: string;
  /** The sentence reduced to plain text. */
  plainText: string;
  by: string | null;
  /** The person's email, the stable identity to search by; null or absent when the owner is not a person. */
  email?: string | null;
  /** `YYYY-MM-DD` as written, or null. */
  on: string | null;
  /** What was not chosen (decided marks), or null. */
  over: string | null;
  /** 1-based line of the mark in the page body. */
  line: number;
  page: {
    kind: PageMarkPageKind;
    scope: 'team' | 'personal';
    /** Tracker item id for a typed page, document id otherwise. */
    id: string;
    title: string;
    /** Tab uri that opens the page: `tracker://<id>`, `personal://<docId>` or a team page's `collab://` uri. */
    uri: string;
    /** Tracker type of a typed page, or of the type a type page belongs to. */
    typeId: string | null;
    issueKey: string | null;
  };
}

export interface PageMarksQuery {
  kind?: PageMarkKind;
  /** Only marks by this person (case-insensitive email match). */
  email?: string;
  /** Only pages of this tracker type. */
  typeId?: string;
  /** Case-insensitive text match on the sentence, who and what was not chosen. */
  search?: string;
  limit?: number;
}

export interface PageMarksSource {
  listMarks(query: PageMarksQuery): Promise<PageMarkRecord[]>;
  /** Hosts with completeness support return this to avoid claiming partial emptiness. */
  listMarksResult?(query: PageMarksQuery): Promise<{ marks: PageMarkRecord[]; status: 'ready' | 'partial' }>;
  /** Called when marks may have changed; returns the unsubscribe. Optional. */
  subscribe?(listener: () => void): () => void;
}

let currentSource: PageMarksSource | null = null;
const sourceListeners = new Set<() => void>();

/** A host installs its source once at startup; `null` clears it. */
export function setPageMarksSource(source: PageMarksSource | null): void {
  currentSource = source;
  sourceListeners.forEach((listener) => listener());
}

export function getPageMarksSource(): PageMarksSource | null {
  return currentSource;
}

export function onPageMarksSourceChange(listener: () => void): () => void {
  sourceListeners.add(listener);
  return () => sourceListeners.delete(listener);
}

/** Applies a query to records, newest decision first; open questions keep page order. */
export function filterPageMarks(records: readonly PageMarkRecord[], query: PageMarksQuery = {}): PageMarkRecord[] {
  const needle = query.search?.trim().toLowerCase() ?? '';
  const email = query.email?.trim().toLowerCase() ?? '';
  const matched = records.filter((record) => {
    if (query.kind && record.kind !== query.kind) return false;
    if (query.typeId && record.page.typeId !== query.typeId) return false;
    if (email && record.email?.toLowerCase() !== email) return false;
    if (needle) {
      const haystack = [record.plainText, record.by, record.over, record.page.title].filter(Boolean).join('\n').toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
  const sorted = matched
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const byDate = (b.record.on ?? '').localeCompare(a.record.on ?? '');
      return byDate !== 0 ? byDate : a.index - b.index;
    })
    .map(({ record }) => record);
  return query.limit !== undefined && query.limit >= 0 ? sorted.slice(0, query.limit) : sorted;
}

const TRACKER_CONTENT_PREFIX = 'tracker-content/';
const TYPE_PAGE_PREFIX = 'type-page:';

export interface TeamIndexMappingOptions {
  orgId: string;
}

/**
 * Records for the marks the server's index returned. A typed page's body is
 * accepted only with live membership metadata. Older unchecked rows are ignored.
 */
export function pageMarkRecordsFromTeamIndex(entries: readonly PageMarkEntry[], options: TeamIndexMappingOptions): PageMarkRecord[] {
  const out: PageMarkRecord[] = [];
  for (const entry of entries) {
    const typed = entry.documentId.startsWith(TRACKER_CONTENT_PREFIX);
    if (typed && (!entry.typedPage || entry.typedPage.itemId !== entry.documentId.slice(TRACKER_CONTENT_PREFIX.length))) continue;
    const typeId = entry.documentId.startsWith(TYPE_PAGE_PREFIX) ? entry.documentId.slice(TYPE_PAGE_PREFIX.length) : null;
    const page: PageMarkRecord['page'] = {
      kind: typed ? 'typed-page' : typeId ? 'type-page' : 'page',
      scope: 'team',
      id: typed ? entry.typedPage!.itemId : entry.documentId,
      title: entry.title ?? typeId ?? 'Untitled',
      uri: typed ? `tracker://${entry.typedPage!.itemId}` : buildCollabUri(options.orgId, entry.documentId),
      typeId: typed ? entry.typedPage!.typeId : typeId,
      issueKey: typed ? entry.typedPage!.issueKey : null,
    };
    out.push({
      id: `${page.uri}#${entry.offset}`,
      kind: entry.kind,
      text: entry.text,
      plainText: entry.plainText,
      by: entry.by,
      email: entry.email,
      on: entry.on,
      over: entry.over,
      line: entry.line,
      page,
    });
  }
  return out;
}

const FIRST_RETRY_MS = 2000;
const MAX_RETRY_MS = 30_000;

/**
 * A source's `subscribe`: `notify()` reaches every open list, and while the
 * team index's last answer was missing (offline, no reply) or `partial`, the
 * lists are asked to load again, backing off, until an answer is complete.
 */
export class PageMarksChangeFeed {
  private readonly listeners = new Set<() => void>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 0;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopRetry();
    };
  }

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** After a load: whether the team index answered completely. */
  settled(complete: boolean): void {
    if (complete) {
      this.stopRetry();
      this.retryDelay = 0;
      return;
    }
    if (this.retryTimer || this.listeners.size === 0) return;
    this.retryDelay = this.retryDelay ? Math.min(this.retryDelay * 2, MAX_RETRY_MS) : FIRST_RETRY_MS;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.notify();
    }, this.retryDelay);
  }

  private stopRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

/** Local and server marks together; a mark listed by both appears once (the first list wins). */
export function mergePageMarks(first: readonly PageMarkRecord[], second: readonly PageMarkRecord[]): PageMarkRecord[] {
  const seen = new Set(first.map((record) => record.id));
  return [...first, ...second.filter((record) => !seen.has(record.id))];
}
