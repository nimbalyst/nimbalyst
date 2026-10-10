// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { PageMarkEntry } from '@nimbalyst/collab-protocol';
import type { PageMarkRecord } from '@nimbalyst/collab-client/pages';
import { createDesktopPageMarksSource } from '../desktopPageMarksSource';

// The default local watcher reads renderer atoms; every test here passes its own or needs none.
vi.mock('../desktopPageMarksWatch', () => ({ watchLocalPageMarks: () => () => {} }));

const localTyped: PageMarkRecord = {
  id: 'tracker://item-1#0', kind: 'decided', text: 'Local', plainText: 'Local', by: 'Ann', email: 'ann@x.io',
  on: '2026-09-01', over: null, line: 1,
  page: { kind: 'typed-page', scope: 'team', id: 'item-1', title: 'Sync engine', uri: 'tracker://item-1', typeId: 'module', issueKey: null },
};
const serverEntry = (documentId: string, on: string): PageMarkEntry => ({
  documentId, projectId: 'p1', title: 'Specs', kind: 'decided', text: 'Server', plainText: 'Server',
  by: 'Ann', email: 'ann@x.io', on, over: null, line: 1, offset: 0,
});

describe('desktop marks source', () => {
  it('adds plain team pages from the server index to the local marks, once each, filtered together', async () => {
    const query = vi.fn(async () => ({
      status: 'ready' as const,
      // The typed page's body is also in the server index; the local copy is the one listed.
      marks: [serverEntry('page-1', '2026-10-01'), serverEntry('tracker-content/item-1', '2026-09-01')],
    }));
    const source = createDesktopPageMarksSource({
      listLocal: async () => [localTyped],
      teamIndex: () => ({ orgId: 'org-1', query }),
    });

    const marks = await source.listMarks({ kind: 'decided', email: 'ann@x.io', limit: 5 });
    expect(marks.map((mark) => mark.page.uri)).toEqual(['collab://org:org-1:doc:page-1', 'tracker://item-1']);
    expect(query).toHaveBeenCalledWith({ kind: 'decided', email: 'ann@x.io' });
  });

  it('reloads open lists when the team says marks changed, and retries while the index is partial or unanswered', async () => {
    vi.useFakeTimers();
    try {
      let teamChanged = () => {};
      let answer: { status: 'ready' | 'partial'; marks: PageMarkEntry[] } | null = { status: 'partial', marks: [] };
      const source = createDesktopPageMarksSource({
        listLocal: async () => [],
        teamIndex: () => ({ orgId: 'org-1', query: async () => answer }),
        watchTeam: (listener) => { teamChanged = listener; return () => {}; },
      });
      const reload = vi.fn();
      const unsubscribe = source.subscribe!(reload);

      await source.listMarks({});
      await vi.advanceTimersByTimeAsync(2000);
      expect(reload).toHaveBeenCalledTimes(1);
      answer = null;
      await source.listMarks({});
      await vi.advanceTimersByTimeAsync(4000);
      expect(reload).toHaveBeenCalledTimes(2);
      answer = { status: 'ready', marks: [] };
      await source.listMarks({});
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reload).toHaveBeenCalledTimes(2);

      teamChanged();
      expect(reload).toHaveBeenCalledTimes(3);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reloads open lists once for a burst of local page, typed-page or team page-list changes', async () => {
    vi.useFakeTimers();
    try {
      let localChanged = () => {};
      const source = createDesktopPageMarksSource({
        listLocal: async () => [],
        teamIndex: () => null,
        watchTeam: () => () => {},
        watchLocal: (listener) => { localChanged = listener; return () => {}; },
      });
      const reload = vi.fn();
      const unsubscribe = source.subscribe!(reload);

      localChanged();
      localChanged();
      localChanged();
      await vi.advanceTimersByTimeAsync(1000);
      expect(reload).toHaveBeenCalledTimes(1);

      localChanged();
      unsubscribe();
      await vi.advanceTimersByTimeAsync(1000);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists local marks when there is no team or the server does not answer', async () => {
    const listLocal = async () => [localTyped];
    expect(await createDesktopPageMarksSource({ listLocal, teamIndex: () => null }).listMarks({})).toEqual([localTyped]);
    const offline = createDesktopPageMarksSource({ listLocal, teamIndex: () => ({ orgId: 'org-1', query: async () => null }) });
    expect(await offline.listMarks({})).toEqual([localTyped]);
  });
});
