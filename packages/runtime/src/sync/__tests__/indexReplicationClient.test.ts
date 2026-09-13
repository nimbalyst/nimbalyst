// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { IndexPageResponseMessage } from '@nimbalyst/collab-protocol';
import {
  bootstrapIndexMirror,
  createIndexReplicationMirror,
  deltaSyncIndexMirror,
  type DecryptedIndexChange,
  type IndexPageRequestInput,
} from '../indexReplicationClient';

type Session = { sessionId: string; title: string };
type Project = { projectId: string };
type File = { docId: string };

const change = (
  over: Partial<DecryptedIndexChange<Session, Project, File>> & { id: string; revision: number },
): DecryptedIndexChange<Session, Project, File> => ({
  entity: 'session',
  deleted: false,
  session: { sessionId: over.id, title: over.id },
  ...over,
});

const page = (over: Partial<IndexPageResponseMessage>): IndexPageResponseMessage => ({
  type: 'indexPageResponse',
  protocolVersion: 2,
  requestId: 'r',
  mode: 'bootstrap',
  entries: [],
  complete: false,
  ...over,
});

/** Feeds canned pages and records what was requested. */
function scriptedServer(pages: IndexPageResponseMessage[]) {
  const requests: IndexPageRequestInput[] = [];
  let i = 0;
  return {
    requests,
    request: async (input: IndexPageRequestInput) => {
      requests.push(input);
      const next = pages[i++];
      if (!next) throw new Error('scripted server ran out of pages');
      return next;
    },
  };
}

const passthroughPrepare = (entries: any[]) => Promise.resolve(entries as Array<DecryptedIndexChange<Session, Project, File>>);

/**
 * Stands in for the production callback that writes a page into the local cache
 * and notifies listeners. Records what it was handed, per page, so tests can
 * assert the "applied before the cursor moved" ordering.
 */
function pageCollector() {
  const pages: string[][] = [];
  return {
    pages,
    get appliedIds() {
      return pages.flat();
    },
    commitPage: async (applied: Array<DecryptedIndexChange<Session, Project, File>>) => {
      pages.push(applied.map((c) => c.id));
    },
  };
}

describe('index replication mirror', () => {
  it('keeps expiry ordering without treating it as a permanent user deletion', () => {
    const mirror = createIndexReplicationMirror<Session, Project, File>();
    mirror.apply([change({ id: 'old', revision: 2, deleted: true, removalReason: 'expired', session: undefined }),
      change({ id: 'deleted', revision: 3, deleted: true, session: undefined })]);
    expect(mirror.deletedIds('session')).toEqual(['deleted']);
    expect(mirror.apply([change({ id: 'old', revision: 1 })])).toEqual([]);
    expect(mirror.apply([change({ id: 'old', revision: 4 })])).toHaveLength(1);
  });

  it('rejects revisions that are not strictly newer, including tombstones', () => {
    const mirror = createIndexReplicationMirror<Session, Project, File>();
    mirror.apply([change({ id: 's1', revision: 5 })]);

    // Stale re-delivery of an older page.
    expect(mirror.apply([change({ id: 's1', revision: 4, session: { sessionId: 's1', title: 'old' } })])).toEqual([]);
    // Same revision is a duplicate, not an update.
    expect(mirror.apply([change({ id: 's1', revision: 5 })])).toEqual([]);

    mirror.apply([change({ id: 's1', revision: 7, deleted: true, session: undefined })]);
    expect(mirror.peek('session', 's1')).toEqual({ revision: 7, deleted: true });
    // A stale row must not resurrect a deleted session.
    expect(mirror.apply([change({ id: 's1', revision: 6 })])).toEqual([]);
    expect(mirror.peek('session', 's1')?.deleted).toBe(true);
  });

  it('refuses to snapshot until coverage is complete, then omits deleted rows', () => {
    const mirror = createIndexReplicationMirror<Session, Project, File>();
    mirror.apply([
      change({ id: 's1', revision: 1 }),
      change({ id: 's2', revision: 2, deleted: true, session: undefined }),
      { entity: 'project', id: 'p1', revision: 3, deleted: false, project: { projectId: 'p1' } },
      { entity: 'file', id: 'f1', revision: 4, deleted: false, file: { docId: 'f1' } },
    ]);

    expect(() => mirror.snapshot()).toThrow(/incomplete/i);

    mirror.markComplete();
    const snapshot = mirror.snapshot();
    expect(snapshot.sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.files).toHaveLength(1);
  });

  it('never infers a cursor from the revisions it merged', () => {
    const mirror = createIndexReplicationMirror<Session, Project, File>();
    mirror.apply([change({ id: 's1', revision: 40 }), change({ id: 's2', revision: 99 })]);

    // Coverage comes from an explicit server cursor and nothing else. Reading
    // the highest revision merged would claim coverage over every revision the
    // server never sent us.
    expect(mirror.cursor).toBeUndefined();
    expect(mirror.isComplete()).toBe(false);
  });

  it('never rewinds the cursor and drops coverage on reset', () => {
    const mirror = createIndexReplicationMirror<Session, Project, File>();
    mirror.commitCursor(10);
    mirror.commitCursor(4);
    expect(mirror.cursor).toBe(10);
    mirror.markComplete();

    mirror.reset();
    expect(mirror.cursor).toBeUndefined();
    expect(mirror.isComplete()).toBe(false);
    expect(mirror.rowCount()).toBe(0);
  });
});

describe('bootstrap drain', () => {
  it('pages the whole baseline and only claims coverage on the terminal cursor', async () => {
    const mirror = createIndexReplicationMirror<Session, Project, File>();
    const server = scriptedServer([
      page({ entries: [change({ id: 's1', revision: 1 })] as any, nextPageToken: 't1' }),
      page({ entries: [change({ id: 's2', revision: 2 })] as any, nextPageToken: 't2' }),
      page({ entries: [change({ id: 's3', revision: 3 })] as any, complete: true, cursor: 3 }),
    ]);

    const collector = pageCollector();
    const outcome = await bootstrapIndexMirror({
      mirror,
      request: server.request,
      prepare: passthroughPrepare,
      commitPage: collector.commitPage,
    });

    expect(outcome.pages).toBe(3);
    expect(outcome.appliedCount).toBe(3);
    // Applied page by page, not accumulated until the terminal response.
    expect(collector.pages).toEqual([['s1'], ['s2'], ['s3']]);
    expect(server.requests.map((r) => r.pageToken)).toEqual([undefined, 't1', 't2']);
    expect(mirror.cursor).toBe(3);
    expect(mirror.snapshot().sessions).toHaveLength(3);
  });

  it('leaves the mirror unusable when the baseline stops short', async () => {
    const mirror = createIndexReplicationMirror<Session, Project, File>();
    const server = scriptedServer([
      // Partial page with no continuation and no completion: coverage unproven.
      page({ entries: [change({ id: 's1', revision: 1 })] as any }),
    ]);

    await expect(
      bootstrapIndexMirror({ mirror, request: server.request, prepare: passthroughPrepare, commitPage: pageCollector().commitPage }),
    ).rejects.toThrow(/partial/i);
    expect(mirror.isComplete()).toBe(false);
    expect(() => mirror.snapshot()).toThrow();
  });

  it('rejects a terminal page that carries no cursor', async () => {
    const mirror = createIndexReplicationMirror<Session, Project, File>();
    const server = scriptedServer([page({ entries: [], complete: true })]);

    await expect(
      bootstrapIndexMirror({ mirror, request: server.request, prepare: passthroughPrepare, commitPage: pageCollector().commitPage }),
    ).rejects.toThrow(/cursor/i);
    expect(mirror.isComplete()).toBe(false);
  });

  it('leaves the previous mirror and cursor intact when a rebuild fails', async () => {
    const mirror = createIndexReplicationMirror<Session, Project, File>();
    mirror.apply([change({ id: 's1', revision: 1 })]);
    mirror.commitCursor(1);
    mirror.markComplete();

    const server = scriptedServer([
      page({ entries: [change({ id: 's2', revision: 2 })] as any, nextPageToken: 't1' }),
    ]);
    const request = async (input: IndexPageRequestInput) => {
      const response = await server.request(input).catch(() => null);
      if (!response) throw new Error('page decryption failed');
      return response;
    };

    await expect(
      bootstrapIndexMirror({ mirror, request, prepare: passthroughPrepare, commitPage: pageCollector().commitPage }),
    ).rejects.toThrow();

    // Coverage the client already had is not collateral damage of a failed rebuild.
    expect(mirror.isComplete()).toBe(true);
    expect(mirror.cursor).toBe(1);
    expect(mirror.snapshot().sessions.map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('replaces rows the rebuilt baseline no longer contains', async () => {
    const mirror = createIndexReplicationMirror<Session, Project, File>();
    mirror.apply([change({ id: 's1', revision: 1 }), change({ id: 's2', revision: 2 })]);
    mirror.commitCursor(2);
    mirror.markComplete();

    // s1 was deleted before the server's journal floor, so the rebuilt baseline
    // simply does not mention it. Keeping the old copy would resurrect it.
    const server = scriptedServer([
      page({ entries: [change({ id: 's2', revision: 9 })] as any, complete: true, cursor: 9 }),
    ]);
    await bootstrapIndexMirror({ mirror, request: server.request, prepare: passthroughPrepare, commitPage: pageCollector().commitPage });

    expect(mirror.snapshot().sessions.map((s) => s.sessionId)).toEqual(['s2']);
    expect(mirror.cursor).toBe(9);
  });

  it('surfaces server tombstones as deletion evidence', async () => {
    const mirror = createIndexReplicationMirror<Session, Project, File>();
    const server = scriptedServer([
      page({
        entries: [
          change({ id: 'alive', revision: 1 }),
          change({ id: 'gone', revision: 2, deleted: true, session: undefined }),
        ] as any,
        complete: true,
        cursor: 2,
      }),
    ]);

    await bootstrapIndexMirror({ mirror, request: server.request, prepare: passthroughPrepare, commitPage: pageCollector().commitPage });

    expect(mirror.snapshot().sessions.map((s) => s.sessionId)).toEqual(['alive']);
    // Absent-from-snapshot alone would make reconciliation re-upload it; the
    // tombstone is what tells the caller the server meant to delete it.
    expect(mirror.deletedIds('session')).toEqual(['gone']);
  });

  it('restarts the baseline when the server signals resetRequired', async () => {
    const mirror = createIndexReplicationMirror<Session, Project, File>();
    const server = scriptedServer([
      page({ entries: [change({ id: 'stale', revision: 1 })] as any, nextPageToken: 't1' }),
      page({ resetRequired: true }),
      page({ entries: [change({ id: 's1', revision: 9 })] as any, complete: true, cursor: 9 }),
    ]);

    const collector = pageCollector();
    const outcome = await bootstrapIndexMirror({
      mirror,
      request: server.request,
      prepare: passthroughPrepare,
      commitPage: collector.commitPage,
    });

    expect(outcome.appliedCount).toBe(1);
    expect(collector.appliedIds).toEqual(['stale', 's1']);
    expect(mirror.snapshot().sessions.map((s) => s.sessionId)).toEqual(['s1']);
  });
});

describe('delta drain', () => {
  const completeMirror = () => {
    const mirror = createIndexReplicationMirror<Session, Project, File>();
    mirror.apply([change({ id: 's1', revision: 1 })]);
    mirror.commitCursor(1);
    mirror.markComplete();
    return mirror;
  };

  it('refuses to run without an established cursor', async () => {
    const mirror = createIndexReplicationMirror<Session, Project, File>();
    await expect(
      deltaSyncIndexMirror({ mirror, request: vi.fn(), prepare: passthroughPrepare, commitPage: pageCollector().commitPage }),
    ).rejects.toThrow(/bootstrap first/i);
  });

  it('commits each contiguous page cursor after its rows merge', async () => {
    const mirror = completeMirror();
    const server = scriptedServer([
      page({ mode: 'delta', entries: [change({ id: 's2', revision: 2 })] as any, cursor: 2, nextPageToken: 'd1' }),
      page({ mode: 'delta', entries: [change({ id: 's1', revision: 3, deleted: true, session: undefined })] as any, cursor: 3, complete: true }),
    ]);

    const outcome = await deltaSyncIndexMirror({
      mirror,
      request: server.request,
      prepare: passthroughPrepare,
      commitPage: pageCollector().commitPage,
    });

    expect(outcome.resetRequired).toBe(false);
    // Resumes from the committed cursor, not from the original one.
    expect(server.requests.map((r) => r.sinceRevision)).toEqual([1, 2]);
    expect(mirror.cursor).toBe(3);
    expect(mirror.snapshot().sessions.map((s) => s.sessionId)).toEqual(['s2']);
  });

  it('keeps the last fully-applied cursor when a later page fails', async () => {
    const mirror = completeMirror();
    let call = 0;
    const request = async (input: IndexPageRequestInput) => {
      call++;
      if (call === 1) {
        return page({ mode: 'delta', entries: [change({ id: 's2', revision: 2 })] as any, cursor: 2, nextPageToken: 'd1' });
      }
      throw new Error('connection dropped');
    };

    await expect(deltaSyncIndexMirror({ mirror, request, prepare: passthroughPrepare, commitPage: pageCollector().commitPage })).rejects.toThrow('connection dropped');
    expect(mirror.cursor).toBe(2);
    expect(mirror.isComplete()).toBe(true);
  });

  it('applies each page locally before committing its cursor, and resumes there after a failure', async () => {
    const mirror = completeMirror();
    const collector = pageCollector();
    const requests: IndexPageRequestInput[] = [];
    let call = 0;
    const request = async (input: IndexPageRequestInput) => {
      requests.push(input);
      call++;
      if (call === 1) {
        return page({ mode: 'delta', entries: [change({ id: 's2', revision: 2 })] as any, cursor: 2, nextPageToken: 'd1' });
      }
      if (call === 2) throw new Error('page 2 timed out');
      return page({ mode: 'delta', entries: [change({ id: 's3', revision: 3 })] as any, cursor: 3, complete: true });
    };

    await expect(
      deltaSyncIndexMirror({ mirror, request, prepare: passthroughPrepare, commitPage: collector.commitPage }),
    ).rejects.toThrow('page 2 timed out');

    // Page 1's rows reached local state, so its cursor may stand. If the cursor
    // had moved without the callback running, page 1's rows would be stranded:
    // the retry below starts after them and the server never re-sends them.
    expect(collector.pages).toEqual([['s2']]);
    expect(mirror.cursor).toBe(2);

    await deltaSyncIndexMirror({ mirror, request, prepare: passthroughPrepare, commitPage: collector.commitPage });

    expect(requests.map((r) => r.sinceRevision)).toEqual([1, 2, 2]);
    expect(collector.pages).toEqual([['s2'], ['s3']]);
    expect(mirror.cursor).toBe(3);
    expect(mirror.snapshot().sessions.map((s) => s.sessionId).sort()).toEqual(['s1', 's2', 's3']);
  });

  it('redelivers a page whose local apply failed, then advances the cursor', async () => {
    const mirror = completeMirror();
    const delivered: string[][] = [];
    let failNext = true;
    const commitPage = async (applied: Array<DecryptedIndexChange<Session, Project, File>>) => {
      if (failNext) {
        failNext = false;
        throw new Error('cache write failed');
      }
      delivered.push(applied.map((c) => c.id));
    };
    // The server re-sends the same page on retry, at the same revisions.
    const samePage = () => page({
      mode: 'delta',
      entries: [change({ id: 's2', revision: 2 }), change({ id: 's3', revision: 3 })] as any,
      cursor: 3,
      complete: true,
    });

    await expect(
      deltaSyncIndexMirror({ mirror, request: async () => samePage(), prepare: passthroughPrepare, commitPage }),
    ).rejects.toThrow('cache write failed');

    // Merging before the callback would have burned revisions 2 and 3 here, so
    // the retry below would see "not newer", deliver nothing, and still advance
    // the cursor -- losing both rows locally for good.
    expect(mirror.cursor).toBe(1);
    expect(mirror.peek('session', 's2')).toBeUndefined();

    await deltaSyncIndexMirror({ mirror, request: async () => samePage(), prepare: passthroughPrepare, commitPage });

    expect(delivered).toEqual([['s2', 's3']]);
    expect(mirror.cursor).toBe(3);
    expect(mirror.snapshot().sessions.map((s) => s.sessionId).sort()).toEqual(['s1', 's2', 's3']);
  });

  it('does not commit a cursor for a page whose local application failed', async () => {
    const mirror = completeMirror();
    const server = scriptedServer([
      page({ mode: 'delta', entries: [change({ id: 's2', revision: 2 })] as any, cursor: 2, complete: true }),
    ]);

    await expect(
      deltaSyncIndexMirror({
        mirror,
        request: server.request,
        prepare: passthroughPrepare,
        commitPage: async () => { throw new Error('cache write failed'); },
      }),
    ).rejects.toThrow('cache write failed');

    expect(mirror.cursor).toBe(1);
  });

  it('drops coverage but reports resetRequired rather than treating rows as deleted', async () => {
    const mirror = completeMirror();
    const server = scriptedServer([page({ mode: 'delta', resetRequired: true })]);

    const outcome = await deltaSyncIndexMirror({
      mirror,
      request: server.request,
      prepare: passthroughPrepare,
      commitPage: pageCollector().commitPage,
    });

    expect(outcome.resetRequired).toBe(true);
    expect(mirror.isComplete()).toBe(false);
    expect(() => mirror.snapshot()).toThrow();
  });
});
