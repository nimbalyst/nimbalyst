// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { PageMarkEntry } from '@nimbalyst/collab-protocol';
import { filterPageMarks, mergePageMarks, PageMarksChangeFeed, pageMarkRecordsFromTeamIndex, type PageMarkRecord } from '../pageMarks';

function mark(id: string, kind: PageMarkRecord['kind'], on: string | null, extra: Partial<PageMarkRecord> = {}): PageMarkRecord {
  return {
    id,
    kind,
    text: id,
    plainText: id,
    by: null,
    email: null,
    on,
    over: null,
    line: 1,
    page: { kind: 'typed-page', scope: 'team', id: 'p', title: 'Flags', uri: 'tracker://p', typeId: 'module', issueKey: null },
    ...extra,
  };
}

describe('filterPageMarks', () => {
  it('filters by kind, type, person and text, newest first with ties in page order', () => {
    const records = [
      mark('a', 'decided', '2026-09-01'),
      mark('b', 'decided', '2026-09-30', { over: 'our own engine', by: 'Greg Hinkle', email: 'Greg@Example.com' }),
      mark('c', 'open', null),
      mark('d', 'decided', '2026-09-01', { page: { ...mark('x', 'open', null).page, typeId: 'tech' } }),
    ];
    expect(filterPageMarks(records, { kind: 'decided' }).map((r) => r.id)).toEqual(['b', 'a', 'd']);
    expect(filterPageMarks(records, { typeId: 'tech' }).map((r) => r.id)).toEqual(['d']);
    expect(filterPageMarks(records, { search: 'OWN ENGINE' }).map((r) => r.id)).toEqual(['b']);
    expect(filterPageMarks(records, { limit: 1 }).map((r) => r.id)).toEqual(['b']);
    expect(filterPageMarks(records, { email: 'greg@example.com' }).map((r) => r.id)).toEqual(['b']);
  });
});

describe('pageMarkRecordsFromTeamIndex', () => {
  const entry = (documentId: string, extra: Partial<PageMarkEntry> = {}): PageMarkEntry => ({
    documentId, projectId: 'p1', title: 'Specs', kind: 'decided', text: 'T', plainText: 'T',
    by: 'Ann', email: 'ann@x.io', on: '2026-10-01', over: null, line: 2, offset: 7, ...extra,
  });

  it('names plain and type pages by their collab uri, and never lists a typed-page body', () => {
    const entries = [
      entry('page-1'),
      entry('type-page:module', { title: 'Modules' }),
      // An older server indexed these; the item may since have been deleted.
      entry('tracker-content/item-1', { projectId: null, title: null }),
    ];
    const records = pageMarkRecordsFromTeamIndex(entries, { orgId: 'org-1' });
    expect(records.map((r) => [r.id, r.page.kind, r.page.uri, r.page.title, r.page.typeId])).toEqual([
      ['collab://org:org-1:doc:page-1#7', 'page', 'collab://org:org-1:doc:page-1', 'Specs', null],
      ['collab://org:org-1:doc:type-page:module#7', 'type-page', 'collab://org:org-1:doc:type-page:module', 'Modules', 'module'],
    ]);
    expect(records[0]).toMatchObject({ by: 'Ann', email: 'ann@x.io', on: '2026-10-01', line: 2, page: { scope: 'team', id: 'page-1' } });
  });

  it('accepts typed pages only when the server supplies checked membership metadata', () => {
    const records = pageMarkRecordsFromTeamIndex([
      entry('tracker-content/item-1', { typedPage: { itemId: 'item-1', typeId: 'decision', issueKey: 'NIM-1' } }),
      entry('tracker-content/item-2'),
      entry('tracker-content/item-3', { typedPage: { itemId: 'different', typeId: 'decision', issueKey: null } }),
    ], { orgId: 'org-1' });
    expect(records).toHaveLength(1);
    expect(records[0].page).toMatchObject({ kind: 'typed-page', id: 'item-1', uri: 'tracker://item-1', typeId: 'decision', issueKey: 'NIM-1' });
  });

  it('asks lists to load again while the team index answer is missing or partial, backing off, until it is complete', () => {
    vi.useFakeTimers();
    try {
      const feed = new PageMarksChangeFeed();
      const listener = vi.fn();
      const unsubscribe = feed.subscribe(listener);
      feed.settled(false);
      feed.settled(false); // A second list's answer does not start a second timer.
      vi.advanceTimersByTime(2000);
      expect(listener).toHaveBeenCalledTimes(1);
      feed.settled(false);
      vi.advanceTimersByTime(2000);
      expect(listener).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2000);
      expect(listener).toHaveBeenCalledTimes(2);
      feed.settled(false);
      feed.settled(true);
      vi.advanceTimersByTime(60_000);
      expect(listener).toHaveBeenCalledTimes(2);
      feed.notify();
      expect(listener).toHaveBeenCalledTimes(3);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges local and server marks without listing a page twice', () => {
    const local = [mark('tracker://p#1', 'open', null)];
    const server = pageMarkRecordsFromTeamIndex([entry('page-1')], { orgId: 'org-1' });
    const merged = mergePageMarks(local, [...server, { ...local[0] }]);
    expect(merged.map((r) => r.id)).toEqual(['tracker://p#1', 'collab://org:org-1:doc:page-1#7']);
  });
});
