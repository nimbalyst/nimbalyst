// @vitest-environment node
/**
 * The Search table's model: which pages and typed pages a section lists, how
 * filter clauses, the title query and the index's body hits narrow them, and
 * the URL state that carries the filters.
 */
import { describe, expect, it } from 'vitest';
import { PAGE_SEARCH_MAX_TYPE_IDS, type PageSearchHit } from '@nimbalyst/collab-protocol';
import {
  PLAIN_PAGE_TYPE,
  buildPagesFilterFields,
  buildPagesSearchRows,
  matchPagesQuery,
  matchesPagesFilters,
  narrowedType,
  pagesSearchQuery,
  parsePagesSearch,
  placedTypeScope,
  bodyHitsHiddenByFilters,
  pagesBodySearchTypeIds,
  snippetRuns,
  type PagesSearchItemInput,
} from '../pagesSearch';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const pages = [
  { documentId: 'doc-a', title: 'Launch plan', createdBy: 'm-ann', updatedAt: NOW - 1000, fields: { status: 'current', owner: 'ann@x.dev', tags: ['db'] } },
  { documentId: 'doc-old', title: 'Old notes', createdBy: 'm-bob', updatedAt: NOW - 40 * 86_400_000 },
  { documentId: 'type-page:module', title: 'Modules', createdBy: 'm-ann', updatedAt: NOW },
  { documentId: 'doc-trash', title: 'Gone', createdBy: 'm-ann', updatedAt: NOW, trashedAt: NOW },
];
const item = (id: string, primaryType: string, fields: Record<string, unknown>, updated: string, extra: Partial<PagesSearchItemInput> = {}): PagesSearchItemInput => ({
  id, primaryType, fields, system: { updatedAt: updated, authorIdentity: { email: 'bob@x.dev' } }, ...extra,
});
const items = [
  item('i-sync', 'module', { title: 'Sync engine', tags: ['core'], owner: 'ann@x.dev', dependsOn: [{ itemId: 'i-store' }] }, day(2), { issueKey: 'MOD-1' }),
  item('i-store', 'module', { title: 'Store', tags: ['core', 'db'] }, day(10)),
  item('i-arch', 'module', { title: 'Archived', tags: [] }, day(1), { archived: true }),
  item('i-bug', 'bug', { title: 'Crash on sync' }, day(3)),
  item('i-mine', 'note', { title: 'Private' }, day(1)),
];
const rows = buildPagesSearchRows(pages, items, {
  inSection: (type) => type === 'module' || type === 'bug',
  itemTitle: (record) => String(record.fields.title ?? ''),
  memberEmail: (id) => (id === 'm-ann' ? 'ann@x.dev' : null),
});

describe('pages search rows', () => {
  it('lists live pages and the section\'s live typed pages, newest first, with authors joined by email', () => {
    expect(rows.map((row) => row.id)).toEqual(['doc-a', 'i-sync', 'i-bug', 'i-store', 'doc-old']);
    expect(rows.find((row) => row.id === 'doc-a')).toMatchObject({ kind: 'page', typeId: PLAIN_PAGE_TYPE, author: 'ann@x.dev' });
    expect(rows.find((row) => row.id === 'doc-old')?.author).toBe('m-bob');
    expect(rows.find((row) => row.id === 'i-sync')).toMatchObject({ kind: 'typed', author: 'bob@x.dev', tags: ['core'], issueKey: 'MOD-1' });
  });

  it('lists typed pages only of the types placed in the section\'s tree, so a body hit on any other is dropped', () => {
    const inSection = placedTypeScope([{ typeId: 'module' }, { typeId: 'note' }], (type) => type !== 'note');
    const placed = buildPagesSearchRows(pages, items, { inSection, itemTitle: (record) => String(record.fields.title ?? '') });
    expect(placed.map((row) => row.id)).toEqual(['doc-a', 'i-sync', 'i-store', 'doc-old']);
    const bugHit: PageSearchHit = {
      kind: 'typed', id: 'i-bug', documentId: 'tracker-content/i-bug', title: null, issueKey: null, snippet: 'a crash here', highlights: [{ start: 2, end: 7 }], updatedAt: null, score: 9,
    };
    expect(matchPagesQuery(placed, 'crash', [bugHit])).toEqual([]);
  });

  it('filters by type, tags, author, updated and a type\'s own fields, never widening on an operator it cannot evaluate', () => {
    const keep = (clauses: Parameters<typeof matchesPagesFilters>[1]) => rows.filter((row) => matchesPagesFilters(row, clauses, NOW)).map((row) => row.id);
    expect(keep({ clauses: [{ field: 'type', op: '=', value: 'module' }] })).toEqual(['i-sync', 'i-store']);
    expect(keep({ clauses: [{ field: 'type', op: '=', value: PLAIN_PAGE_TYPE }] })).toEqual(['doc-a', 'doc-old']);
    // A plain page's own tags, status and owner filter alongside a typed page's.
    expect(keep({ clauses: [{ field: 'tags', op: 'in', value: ['db'] }] })).toEqual(['doc-a', 'i-store']);
    expect(keep({ clauses: [{ field: 'owner', op: '=', value: 'ann@x.dev' }] })).toEqual(['doc-a', 'i-sync']);
    expect(keep({ clauses: [{ field: 'status', op: '=', value: 'current' }] })).toEqual(['doc-a']);
    expect(keep({ clauses: [{ field: 'author', op: 'is-current-user' }] })).toEqual([]);
    expect(rows.filter((row) => matchesPagesFilters(row, { clauses: [{ field: 'author', op: 'is-current-user' }] }, NOW, 'ann@x.dev')).map((row) => row.id)).toEqual(['doc-a']);
    expect(keep({ clauses: [{ field: 'updated', op: 'in-last', value: 7 }] })).toEqual(['doc-a', 'i-sync', 'i-bug']);
    expect(keep({ clauses: [{ field: 'field:dependsOn', op: '=', value: 'i-store' }] })).toEqual(['i-sync']);
    expect(keep({ combinator: 'or', clauses: [{ field: 'tags', op: 'in', value: ['db'] }, { field: 'type', op: '=', value: 'bug' }] })).toEqual(['doc-a', 'i-bug', 'i-store']);
    expect(keep({ clauses: [{ field: 'updated', op: '>', value: 'not a date' }] })).toEqual([]);
  });

  it('adds the narrowed type\'s own fields to the filter fields, with options from the rows', () => {
    const filters = { clauses: [{ field: 'type', op: '=' as const, value: 'module' }] };
    expect(narrowedType(filters)).toBe('module');
    expect(narrowedType({ combinator: 'or', clauses: filters.clauses })).toBeNull();
    expect(narrowedType({ clauses: [{ field: 'type', op: 'in', value: ['module', 'bug'] }] })).toBeNull();
    const fields = buildPagesFilterFields(rows, { type: (id) => id, author: (id) => id }, {
      typeId: 'module',
      fields: [
        { name: 'title', type: 'string' },
        { name: 'dependsOn', type: 'relationship', multiValue: true },
        { name: 'owner', type: 'user' },
      ],
      titleOf: (id) => (id === 'i-store' ? 'Store' : null),
    });
    expect(fields.map((field) => field.id)).toEqual(['type', 'tags', 'author', 'status', 'owner', 'updated', 'field:dependsOn', 'field:owner']);
    expect(fields.find((field) => field.id === 'field:dependsOn')?.options).toEqual([{ value: 'i-store', label: 'Store', count: 1 }]);
    expect(fields.find((field) => field.id === 'tags')?.options?.[0]).toEqual({ value: 'core', label: 'core', count: 2 });
  });
});

describe('pages search text', () => {
  const hit = (kind: PageSearchHit['kind'], id: string, score: number, snippet = 'about sync here'): PageSearchHit => ({
    kind, id, documentId: id, title: null, issueKey: null, snippet, highlights: [{ start: 6, end: 10 }], updatedAt: null, score,
  });

  it('keeps title matches first, then body hits by score, and drops hits the section does not list', () => {
    const matches = matchPagesQuery(rows, 'sync', [
      hit('page', 'doc-old', 1),
      hit('typed', 'i-store', 5),
      hit('typed', 'i-arch', 9),
      hit('typePage', 'module', 9),
      hit('typed', 'i-sync', 2),
    ]);
    expect(matches.map((match) => match.row.id)).toEqual(['i-sync', 'i-bug', 'i-store', 'doc-old']);
    expect(matches[0].snippet?.text).toBe('about sync here');
    expect(matches[1].snippet).toBeNull();
    expect(matchPagesQuery(rows, 'mod-1', null).map((match) => match.row.id)).toEqual(['i-sync']);
  });

  it('splits a snippet into highlighted runs, clipping overlaps', () => {
    expect(snippetRuns('find the sync bug', [{ start: 9, end: 13 }, { start: 11, end: 17 }, { start: 30, end: 40 }])).toEqual([
      { text: 'find the ', hit: false },
      { text: 'sync', hit: true },
      { text: ' bug', hit: true },
    ]);
  });

  it('round-trips the query and filters through the URL, and opens a broken link unfiltered', () => {
    const state = { query: 'sync', filters: { combinator: 'and' as const, clauses: [{ field: 'type', op: '=' as const, value: 'module' }] } };
    expect(parsePagesSearch(new URLSearchParams(pagesSearchQuery(state)))).toEqual(state);
    expect(pagesSearchQuery({ query: ' ', filters: { clauses: [] } })).toBe('');
    expect(parsePagesSearch(new URLSearchParams('q=x&filters=%7Bnope'))).toEqual({ query: 'x', filters: null });
  });
});

describe('pages search text request', () => {
  it('asks the index for the placed types, or only the type the filters narrow to', () => {
    const typeIs = (value: string) => ({ combinator: 'and' as const, clauses: [{ field: 'type', op: '=' as const, value }] });
    expect(pagesBodySearchTypeIds(['module', 'decision'], null)).toEqual(['module', 'decision']);
    expect(pagesBodySearchTypeIds(['module', 'decision'], typeIs('decision'))).toEqual(['decision']);
    // Plain pages only: no typed pages at all.
    expect(pagesBodySearchTypeIds(['module', 'decision'], typeIs(PLAIN_PAGE_TYPE))).toEqual([]);
    // Narrowed to a type that is not placed: nothing of it is listed anyway.
    expect(pagesBodySearchTypeIds(['module'], typeIs('bug'))).toEqual(['module']);
    // Past what the index reads, ask for every type and let the section filter.
    const many = Array.from({ length: PAGE_SEARCH_MAX_TYPE_IDS + 1 }, (_, index) => `type-${index}`);
    expect(pagesBodySearchTypeIds(many, null)).toBeUndefined();
  });

  it('says text matches may be hidden only when the index filled its page and filters dropped some of them', () => {
    const hit = (id: string): PageSearchHit => ({
      kind: 'typed', id, documentId: id, title: null, issueKey: null, snippet: 'x', highlights: [], updatedAt: null, score: 1,
    });
    const hits = [hit('a'), hit('b'), hit('c')];
    const shown = new Set(['typed:a', 'typed:b']);
    expect(bodyHitsHiddenByFilters(hits, 3, shown)).toBe(true);
    expect(bodyHitsHiddenByFilters(hits, 4, shown)).toBe(false);
    expect(bodyHitsHiddenByFilters(hits, 3, new Set(['typed:a', 'typed:b', 'typed:c']))).toBe(false);
  });
});
