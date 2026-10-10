// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { PageSearchHit } from '@nimbalyst/collab-protocol';
import { nameTypedHits, searchSectionPages } from '../pageSearch';
import type { SharedDocument } from '../types';

const doc = (documentId: string, title: string, extra: Partial<SharedDocument> = {}) =>
  ({ documentId, title, updatedAt: 10, ...extra }) as SharedDocument;

const hit = (documentId: string, kind: PageSearchHit['kind'], id: string, score: number): PageSearchHit => ({
  kind, id, documentId, title: null, issueKey: null, snippet: `${id} body`, highlights: [{ start: 0, end: 2 }], updatedAt: 5, score,
});

describe('section page search', () => {
  it('merges body hits with title matches, names pages from the session, drops pages it does not hold live, and leaves typed pages to the tree', async () => {
    const documents = [doc('page-a', 'Sync design'), doc('page-b', 'Pricing'), doc('type-page:module', 'Modules'), doc('page-t', 'Sync trash', { trashedAt: 5 })];
    const source = {
      searchPages: vi.fn(async () => ({
        status: 'partial' as const,
        hits: [hit('page-b', 'page', 'page-b', 3), hit('tracker-content/item-1', 'typed', 'item-1', 2), hit('page-gone', 'page', 'page-gone', 9), hit('page-t', 'page', 'page-t', 8)],
      })),
    };

    const result = (await searchSectionPages(source, documents.filter((d) => d.trashedAt == null), { query: 'sync' }))!;
    expect(result.status).toBe('partial');
    await searchSectionPages(source, documents, { query: 'sync', typeIds: ['module'] });
    expect(source.searchPages).toHaveBeenLastCalledWith({ query: 'sync', typeIds: ['module'], limit: 20 });
    // page-a matched its title only (boost 5, no snippet); page-b its body.
    expect(result.hits.map((h) => [h.documentId, h.title, h.snippet])).toEqual([
      ['page-a', 'Sync design', ''],
      ['page-b', 'Pricing', 'page-b body'],
      ['tracker-content/item-1', null, 'item-1 body'],
    ]);
    // The caller's tree names typed pages and drops one it does not show (archived).
    expect(nameTypedHits(result.hits, (itemId) => (itemId === 'item-1' ? { title: 'CRDT engine', issueKey: 'NIM-1' } : null))
      .find((h) => h.kind === 'typed')).toMatchObject({ title: 'CRDT engine', issueKey: 'NIM-1' });
    expect(nameTypedHits(result.hits, () => null).map((h) => h.documentId)).toEqual(['page-a', 'page-b']);

    // A section that cannot search now answers null; one with no body search answers titles.
    expect(await searchSectionPages({ searchPages: async () => null }, documents, { query: 'sync' })).toBeNull();
    expect((await searchSectionPages({}, documents, { query: 'modules' }))!.hits).toMatchObject([{ kind: 'typePage', id: 'module', title: 'Modules' }]);
  });
});
