/**
 * A Pages section's Search table as data: one row per page and typed page in
 * the section, the filter fields the Trackers omnibox and pills read (type,
 * tags, author, updated, and the chosen type's own fields), the title query,
 * the page-text hits the section's search index returns, and the URL state
 * that carries all of it.
 *
 * Filters are the tracker filter language (`TrackerFilterSet`), evaluated by
 * the runtime's `matchesFilterSet`, so the omnibox drives them unchanged.
 * Pure: hosts map their documents and records in, the view renders the rows.
 */
import { type PageSearchHighlight, type PageSearchHit } from '@nimbalyst/collab-protocol';
import type { FieldDefinition } from '../../../../tracker-schema/src/browser';
import { type TrackerFilterSet } from '../../../../runtime/src/plugins/TrackerPlugin/models/trackerFilters';
import type { TrackerFilterField, TrackerFilterFieldOption } from '../trackerFilterFields';
/** The type value of a plain page, which has no tracker type. */
export declare const PLAIN_PAGE_TYPE = "__page";
/** A type's own fields are filtered under this prefix, so a field named `type` or `tags` cannot collide. */
export declare const TYPE_FIELD_PREFIX = "field:";
export interface PagesSearchRow {
    kind: 'page' | 'typed';
    /** Document id for a page, item id for a typed page. */
    id: string;
    title: string;
    /** `PLAIN_PAGE_TYPE` for a page, the tracker type for a typed page. */
    typeId: string;
    issueKey: string | null;
    tags: string[];
    /** Who created it: an email when known, otherwise the member id; null when unknown. */
    author: string | null;
    /** Last change, epoch millis; 0 when unknown. */
    updated: number;
    /** A typed page's own field values, by field name. */
    fields: Readonly<Record<string, unknown>>;
    /** Status value: a plain page's own, or a typed page's `status` field. */
    status: string | null;
    /** Owner (an email or a member id): a plain page's own, or a typed page's `owner`. */
    owner: string | null;
    /** One line about the page (a plain page's own summary). */
    summary: string | null;
}
/** A page as the docs session lists it. */
export interface PagesSearchPageInput {
    documentId: string;
    title: string;
    createdBy?: string | null;
    updatedAt?: number | null;
    trashedAt?: number | null;
    decryptFailed?: boolean;
    /** The page's own fields (`pageFields.ts`). */
    fields?: {
        status?: string;
        owner?: string;
        summary?: string;
        tags?: readonly string[];
    };
}
/** A typed page as the tracker room holds it. */
export interface PagesSearchItemInput {
    id: string;
    primaryType: string;
    issueKey?: string | null;
    archived?: boolean;
    fields: Readonly<Record<string, unknown>>;
    system: {
        createdAt?: string;
        updatedAt?: string;
        authorIdentity?: {
            email?: string | null;
            name?: string | null;
        } | null;
    };
}
export interface PagesSearchRowOptions {
    /** True for the types this section shows (its lane, listed). */
    inSection: (typeId: string) => boolean;
    /** A typed page's title. */
    itemTitle: (item: PagesSearchItemInput) => string;
    /** A member id's email, so a page's author and a typed page's author compare alike. */
    memberEmail?: (memberId: string) => string | null | undefined;
}
/**
 * Which typed pages a section's Search lists: those of the types placed in its
 * tree, and in its lane. Other tracker items (bugs, tasks, imported issues)
 * stay in Tracker mode.
 */
export declare function placedTypeScope(placements: ReadonlyArray<{
    typeId: string;
}>, inLane: (typeId: string) => boolean): (typeId: string) => boolean;
/** Every page and typed page in the section, newest change first. */
export declare function buildPagesSearchRows(pages: readonly PagesSearchPageInput[], items: readonly PagesSearchItemInput[], options: PagesSearchRowOptions): PagesSearchRow[];
/** What a clause on `field` compares. */
export declare function pagesSearchValue(row: PagesSearchRow, field: string): unknown;
export declare function matchesPagesFilters(row: PagesSearchRow, filters: TrackerFilterSet | null, nowMs: number, me?: string | null): boolean;
/**
 * The one type the filters narrow to, when they do: a single `type = X` or
 * `type in [X]` clause under `and`. Its own fields join the filter fields then.
 */
export declare function narrowedType(filters: TrackerFilterSet | null): string | null;
export interface PagesSearchMatch {
    row: PagesSearchRow;
    /** Where the query matched in the body, when the index found it there. */
    snippet: {
        text: string;
        highlights: PageSearchHighlight[];
    } | null;
}
/** Rows whose title or issue key holds every query term, case-insensitively. */
export declare function titleMatches(row: PagesSearchRow, query: string): boolean;
/**
 * The rows a query keeps: title matches first (newest first), then pages the
 * index found by their text, by its score. A body hit on a title match lends
 * it the snippet. A hit with no row in this section is dropped: an archived
 * typed page, one not synced yet, or a type page.
 */
export declare function matchPagesQuery(rows: readonly PagesSearchRow[], query: string, hits: readonly PageSearchHit[] | null): PagesSearchMatch[];
/**
 * The `typeIds` the index searches typed pages of (it filters before its
 * limit): the placed types, only the one the filters narrow to, or none when
 * they narrow to plain pages. A type that is not placed has no rows here, so
 * narrowing to one asks for the placed types as usual. Past the ids the index
 * reads, undefined asks for every type and the section's own filter applies.
 */
export declare function pagesBodySearchTypeIds(placedTypeIds: readonly string[], filters: TrackerFilterSet | null): string[] | undefined;
/**
 * True when the index returned a full page of hits (`limit`) and the filters
 * it cannot apply (author, tags, a type's fields) hid some of them, so more
 * matches may exist past the page. `shownKeys` are `kind:id` of shown rows.
 */
export declare function bodyHitsHiddenByFilters(hits: readonly PageSearchHit[], limit: number, shownKeys: ReadonlySet<string>): boolean;
/** A snippet split into plain and highlighted runs, in order. Overlapping or out-of-range highlights are clipped. */
export declare function snippetRuns(text: string, highlights: readonly PageSearchHighlight[]): Array<{
    text: string;
    hit: boolean;
}>;
export interface PagesSearchLabels {
    type: (typeId: string) => string;
    author: (author: string) => string;
}
export declare function tallyOptions(entries: ReadonlyArray<{
    value: string;
    label: string;
}>): TrackerFilterFieldOption[];
/** A status value as a reader sees it: "in-review" reads "In review". */
export declare function pageStatusLabel(value: string): string;
/**
 * Type, Tags, Author and Updated, then the narrowed type's own fields. Options
 * come from `rows` (the rows the clauses would narrow), so the typeahead only
 * offers values something still holds.
 */
export declare function buildPagesFilterFields(rows: readonly PagesSearchRow[], labels: PagesSearchLabels, narrowed?: {
    typeId: string;
    fields: readonly FieldDefinition[];
    titleOf?: (itemId: string) => string | null;
} | null): TrackerFilterField[];
export interface PagesSearchState {
    query: string;
    filters: TrackerFilterSet | null;
}
export declare const EMPTY_PAGES_SEARCH: PagesSearchState;
export declare function parsePagesSearch(params: URLSearchParams): PagesSearchState;
/** The query string (no `?`) for a state; empty parts are left out. */
export declare function pagesSearchQuery(state: Partial<PagesSearchState>): string;
