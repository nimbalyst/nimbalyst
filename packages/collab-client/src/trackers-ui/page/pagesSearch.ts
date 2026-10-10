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
import { PAGE_SEARCH_MAX_TYPE_IDS, type PageSearchHighlight, type PageSearchHit } from '@nimbalyst/collab-protocol';
import type { FieldDefinition } from '@nimbalyst/tracker-schema';
import { matchesFilterSet, type TrackerFilterSet } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerFilters';
import type { TrackerFilterField, TrackerFilterFieldOption } from '../trackerFilterFields';

/** The type value of a plain page, which has no tracker type. */
export const PLAIN_PAGE_TYPE = '__page';
/** A type's own fields are filtered under this prefix, so a field named `type` or `tags` cannot collide. */
export const TYPE_FIELD_PREFIX = 'field:';
/** Type pages keep their prose under this id; they are the type's page, not a row of their own. */
const TYPE_PAGE_DOCUMENT_PREFIX = 'type-page:';

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
  fields?: { status?: string; owner?: string; summary?: string; tags?: readonly string[] };
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
    authorIdentity?: { email?: string | null; name?: string | null } | null;
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

function millis(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (value && typeof value === 'object') {
    // A relationship value names its target; an `{ value }` wrapper carries the value.
    const entry = value as { itemId?: unknown; id?: unknown; value?: unknown };
    if (typeof entry.itemId === 'string') return [entry.itemId];
    if (typeof entry.id === 'string') return [entry.id];
    if ('value' in entry) return strings(entry.value);
  }
  return [];
}

/**
 * Which typed pages a section's Search lists: those of the types placed in its
 * tree, and in its lane. Other tracker items (bugs, tasks, imported issues)
 * stay in Tracker mode.
 */
export function placedTypeScope(
  placements: ReadonlyArray<{ typeId: string }>,
  inLane: (typeId: string) => boolean,
): (typeId: string) => boolean {
  const placed = new Set(placements.map((placement) => placement.typeId));
  return (typeId) => placed.has(typeId) && inLane(typeId);
}

/** Every page and typed page in the section, newest change first. */
export function buildPagesSearchRows(
  pages: readonly PagesSearchPageInput[],
  items: readonly PagesSearchItemInput[],
  options: PagesSearchRowOptions,
): PagesSearchRow[] {
  const pageRows = pages
    .filter((page) => !page.trashedAt && !page.decryptFailed && !page.documentId.startsWith(TYPE_PAGE_DOCUMENT_PREFIX))
    .map((page): PagesSearchRow => ({
      kind: 'page',
      id: page.documentId,
      title: page.title.trim() || 'Untitled',
      typeId: PLAIN_PAGE_TYPE,
      issueKey: null,
      tags: [...(page.fields?.tags ?? [])],
      author: page.createdBy ? options.memberEmail?.(page.createdBy) || page.createdBy : null,
      updated: millis(page.updatedAt),
      fields: {},
      status: page.fields?.status ?? null,
      owner: page.fields?.owner ?? null,
      summary: page.fields?.summary ?? null,
    }));
  const itemRows = items
    .filter((item) => !item.archived && options.inSection(item.primaryType))
    .map((item): PagesSearchRow => {
      const identity = item.system.authorIdentity;
      return {
        kind: 'typed',
        id: item.id,
        title: options.itemTitle(item).trim() || 'Untitled',
        typeId: item.primaryType,
        issueKey: item.issueKey ?? null,
        tags: [...new Set(strings(item.fields.tags))],
        author: identity?.email || identity?.name || null,
        updated: millis(item.system.updatedAt ?? item.system.createdAt),
        fields: item.fields,
        status: strings(item.fields.status)[0] ?? null,
        owner: strings(item.fields.owner)[0] ?? null,
        summary: null,
      };
    });
  return [...pageRows, ...itemRows].sort((a, b) => b.updated - a.updated || a.title.localeCompare(b.title));
}

/** What a clause on `field` compares. */
export function pagesSearchValue(row: PagesSearchRow, field: string): unknown {
  switch (field) {
    case 'type': return row.typeId;
    case 'tags': return row.tags;
    case 'author': return row.author;
    case 'status': return row.status;
    case 'owner': return row.owner;
    case 'updated': return row.updated || null;
    default:
      return field.startsWith(TYPE_FIELD_PREFIX) ? strings(row.fields[field.slice(TYPE_FIELD_PREFIX.length)]) : undefined;
  }
}

export function matchesPagesFilters(row: PagesSearchRow, filters: TrackerFilterSet | null, nowMs: number, me?: string | null): boolean {
  return matchesFilterSet(filters, (field) => pagesSearchValue(row, field), { nowMs, currentUser: me ?? undefined });
}

/**
 * The one type the filters narrow to, when they do: a single `type = X` or
 * `type in [X]` clause under `and`. Its own fields join the filter fields then.
 */
export function narrowedType(filters: TrackerFilterSet | null): string | null {
  const typeId = singleTypeFilter(filters);
  return typeId && typeId !== PLAIN_PAGE_TYPE ? typeId : null;
}

/** The one type value a lone `type = X` / `type in [X]` clause under `and` names, `PLAIN_PAGE_TYPE` included. */
function singleTypeFilter(filters: TrackerFilterSet | null): string | null {
  if (!filters || filters.combinator === 'or') return null;
  const values = filters.clauses
    .filter((clause) => clause.field === 'type' && (clause.op === '=' || clause.op === 'in'))
    .map((clause) => (Array.isArray(clause.value) ? clause.value.map(String) : [String(clause.value ?? '')]));
  if (values.length !== 1 || values[0].length !== 1) return null;
  return values[0][0] || null;
}

// ── Text: titles here, bodies from the section's search index ───────────────

export interface PagesSearchMatch {
  row: PagesSearchRow;
  /** Where the query matched in the body, when the index found it there. */
  snippet: { text: string; highlights: PageSearchHighlight[] } | null;
}

/** Rows whose title or issue key holds every query term, case-insensitively. */
export function titleMatches(row: PagesSearchRow, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = `${row.title} ${row.issueKey ?? ''}`.toLowerCase();
  return terms.every((term) => text.includes(term));
}

/**
 * The rows a query keeps: title matches first (newest first), then pages the
 * index found by their text, by its score. A body hit on a title match lends
 * it the snippet. A hit with no row in this section is dropped: an archived
 * typed page, one not synced yet, or a type page.
 */
export function matchPagesQuery(
  rows: readonly PagesSearchRow[],
  query: string,
  hits: readonly PageSearchHit[] | null,
): PagesSearchMatch[] {
  if (!query.trim()) return rows.map((row) => ({ row, snippet: null }));
  const key = (kind: string, id: string) => `${kind}:${id}`;
  const byKey = new Map(rows.map((row) => [key(row.kind, row.id), row]));
  const snippets = new Map<string, { text: string; highlights: PageSearchHighlight[]; score: number }>();
  for (const hit of hits ?? []) {
    // A title-only hit carries no snippet; the row's title already shows the match.
    if (hit.kind === 'typePage' || !hit.snippet.trim() || !byKey.has(key(hit.kind, hit.id))) continue;
    const existing = snippets.get(key(hit.kind, hit.id));
    if (!existing || hit.score > existing.score) snippets.set(key(hit.kind, hit.id), { text: hit.snippet, highlights: hit.highlights, score: hit.score });
  }
  const snippetOf = (row: PagesSearchRow) => {
    const found = snippets.get(key(row.kind, row.id));
    return found ? { text: found.text, highlights: found.highlights } : null;
  };
  const byTitle = rows.filter((row) => titleMatches(row, query));
  const titled = new Set(byTitle);
  const byBody = [...snippets.entries()]
    .map(([id, found]) => ({ row: byKey.get(id)!, score: found.score }))
    .filter(({ row }) => !titled.has(row))
    .sort((a, b) => b.score - a.score)
    .map(({ row }) => row);
  return [...byTitle, ...byBody].map((row) => ({ row, snippet: snippetOf(row) }));
}

/**
 * The `typeIds` the index searches typed pages of (it filters before its
 * limit): the placed types, only the one the filters narrow to, or none when
 * they narrow to plain pages. A type that is not placed has no rows here, so
 * narrowing to one asks for the placed types as usual. Past the ids the index
 * reads, undefined asks for every type and the section's own filter applies.
 */
export function pagesBodySearchTypeIds(placedTypeIds: readonly string[], filters: TrackerFilterSet | null): string[] | undefined {
  const narrowed = singleTypeFilter(filters);
  if (narrowed === PLAIN_PAGE_TYPE) return [];
  if (narrowed && placedTypeIds.includes(narrowed)) return [narrowed];
  return placedTypeIds.length > PAGE_SEARCH_MAX_TYPE_IDS ? undefined : [...placedTypeIds];
}

/**
 * True when the index returned a full page of hits (`limit`) and the filters
 * it cannot apply (author, tags, a type's fields) hid some of them, so more
 * matches may exist past the page. `shownKeys` are `kind:id` of shown rows.
 */
export function bodyHitsHiddenByFilters(hits: readonly PageSearchHit[], limit: number, shownKeys: ReadonlySet<string>): boolean {
  if (hits.length < limit) return false;
  return hits.some((hit) => hit.kind !== 'typePage' && !shownKeys.has(`${hit.kind}:${hit.id}`));
}

/** A snippet split into plain and highlighted runs, in order. Overlapping or out-of-range highlights are clipped. */
export function snippetRuns(text: string, highlights: readonly PageSearchHighlight[]): Array<{ text: string; hit: boolean }> {
  const runs: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const { start, end } of [...highlights].sort((a, b) => a.start - b.start)) {
    const from = Math.max(start, at);
    const to = Math.min(end, text.length);
    if (to <= from) continue;
    if (from > at) runs.push({ text: text.slice(at, from), hit: false });
    runs.push({ text: text.slice(from, to), hit: true });
    at = to;
  }
  if (at < text.length) runs.push({ text: text.slice(at), hit: false });
  return runs;
}

// ── Filter fields for the omnibox and pills ────────────────────────────────

export interface PagesSearchLabels {
  type: (typeId: string) => string;
  author: (author: string) => string;
}

export function tallyOptions(entries: ReadonlyArray<{ value: string; label: string }>): TrackerFilterFieldOption[] {
  const byValue = new Map<string, TrackerFilterFieldOption>();
  for (const { value, label } of entries) {
    const existing = byValue.get(value);
    if (existing) existing.count = (existing.count ?? 0) + 1;
    else byValue.set(value, { value, label, count: 1 });
  }
  return [...byValue.values()].sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.label.localeCompare(b.label));
}

/** A status value as a reader sees it: "in-review" reads "In review". */
export function pageStatusLabel(value: string): string {
  return fieldLabel(value);
}

function fieldLabel(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The field types whose values the omnibox offers as a list. */
const CHOICE_TYPES = new Set(['select', 'multiselect', 'relationship', 'reference', 'user', 'boolean']);

/**
 * Type, Tags, Author and Updated, then the narrowed type's own fields. Options
 * come from `rows` (the rows the clauses would narrow), so the typeahead only
 * offers values something still holds.
 */
export function buildPagesFilterFields(
  rows: readonly PagesSearchRow[],
  labels: PagesSearchLabels,
  narrowed: { typeId: string; fields: readonly FieldDefinition[]; titleOf?: (itemId: string) => string | null } | null = null,
): TrackerFilterField[] {
  const fields: TrackerFilterField[] = [
    { id: 'type', label: 'Type', type: 'select', group: 'common', options: tallyOptions(rows.map((row) => ({ value: row.typeId, label: labels.type(row.typeId) }))) },
    { id: 'tags', label: 'Tags', type: 'multiselect', multiValue: true, group: 'common', options: tallyOptions(rows.flatMap((row) => row.tags.map((tag) => ({ value: tag, label: tag })))) },
    { id: 'author', label: 'Author', type: 'select', group: 'common', options: tallyOptions(rows.flatMap((row) => (row.author ? [{ value: row.author, label: labels.author(row.author) }] : []))) },
    { id: 'status', label: 'Status', type: 'select', group: 'common', options: tallyOptions(rows.flatMap((row) => (row.status ? [{ value: row.status, label: pageStatusLabel(row.status) }] : []))) },
    { id: 'owner', label: 'Owner', type: 'select', group: 'common', options: tallyOptions(rows.flatMap((row) => (row.owner ? [{ value: row.owner, label: labels.author(row.owner) }] : []))) },
    { id: 'updated', label: 'Updated', type: 'datetime', group: 'system' },
  ];
  if (!narrowed) return fields;
  const ofType = rows.filter((row) => row.typeId === narrowed.typeId);
  for (const definition of narrowed.fields) {
    if (definition.name === 'title' || definition.name === 'tags') continue;
    const id = `${TYPE_FIELD_PREFIX}${definition.name}`;
    const declared = new Map((definition.options ?? []).map((option) => [option.value, option.label]));
    const isRelation = definition.type === 'relationship' || definition.type === 'reference';
    const choice = CHOICE_TYPES.has(definition.type) || declared.size > 0;
    fields.push({
      id,
      label: fieldLabel(definition.name),
      type: choice ? (definition.multiValue || definition.type === 'multiselect' || isRelation ? 'multiselect' : 'select') : definition.type,
      multiValue: definition.type === 'multiselect' || (isRelation && definition.multiValue !== false),
      group: 'custom',
      ...(choice ? {
        options: tallyOptions(ofType.flatMap((row) => strings(row.fields[definition.name]).map((value) => ({
          value,
          label: declared.get(value) ?? (isRelation ? narrowed.titleOf?.(value) ?? value : value),
        })))),
      } : {}),
    });
  }
  return fields;
}

// ── URL and tab state ──────────────────────────────────────────────────────

export interface PagesSearchState {
  query: string;
  filters: TrackerFilterSet | null;
}

export const EMPTY_PAGES_SEARCH: PagesSearchState = { query: '', filters: null };

export function parsePagesSearch(params: URLSearchParams): PagesSearchState {
  let filters: TrackerFilterSet | null = null;
  const raw = params.get('filters');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as TrackerFilterSet;
      if (parsed && Array.isArray(parsed.clauses)) filters = { combinator: parsed.combinator === 'or' ? 'or' : 'and', clauses: parsed.clauses };
    } catch {
      // A hand-edited link with broken filters still opens the table, unfiltered.
    }
  }
  return { query: params.get('q') ?? '', filters };
}

/** The query string (no `?`) for a state; empty parts are left out. */
export function pagesSearchQuery(state: Partial<PagesSearchState>): string {
  const params = new URLSearchParams();
  if (state.query?.trim()) params.set('q', state.query);
  if (state.filters?.clauses.length) params.set('filters', JSON.stringify(state.filters));
  return params.toString();
}
