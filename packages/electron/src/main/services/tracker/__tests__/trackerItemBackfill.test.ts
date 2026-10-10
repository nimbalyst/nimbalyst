// @vitest-environment node

/**
 * The reconnect drain for tracker items left `pending` by an offline write.
 *
 * The regression under test is invisible at the call site: the drain used to
 * be guarded by a process-lifetime `Set`, so it ran on the FIRST `connected`
 * and never again. A mid-session disconnect -- laptop sleeps, wifi drops --
 * left every edit at `sync_status='pending'` until the next app launch, and if
 * a teammate touched the same row in the meantime `applyRemoteItem` stamped it
 * `synced` and the edit was gone with no rejection and no log line (NIM-3657).
 *
 * Schemas, saved views and navigation all push at the end of every bootstrap.
 * Items are the lane that did not, so "drains on the second connect too" is
 * the assertion that matters here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { drainPendingTrackerItems, planTrackerDrain, type TrackerItemBackfillPort } from '../trackerItemBackfill';

const WORKSPACE = '/tmp/workspace';

/** A resolution that succeeded. The drain's port hands these back per row. */
const known = (sharing: 'team' | 'personal', draftByDefault = false) =>
  ({ known: true, policy: { sharing, draftByDefault } }) as const;

/** A resolution that did not. This is the value NIM-2968 could not express. */
const unresolved = (trackerType = 'bug') =>
  ({ known: false, reason: 'no-model', trackerType, workspacePath: WORKSPACE }) as const;

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bug-1',
    type: 'bug',
    workspace: WORKSPACE,
    sync_id: null,
    sync_status: 'pending',
    data: {},
    ...overrides,
  };
}

function makePort(rows: Array<Record<string, unknown>>): TrackerItemBackfillPort & {
  upsertItem: ReturnType<typeof vi.fn>;
  deleteItem: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  emitEvent: ReturnType<typeof vi.fn>;
  reloadSchemas: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn(async () => ({ rows: [...rows] })),
    upsertItem: vi.fn(async () => {}),
    deleteItem: vi.fn(async () => {}),
    resolvePolicy: () => known('team'),
    countSyncedRows: vi.fn(async () => 0),
    emitEvent: vi.fn() as any,
    reloadSchemas: vi.fn(async () => {}),
    toItem: (row: any) => ({ id: row.id, type: row.type, workspace: row.workspace }) as any,
    log: { info: vi.fn(), warn: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('drainPendingTrackerItems', () => {
  it('drains again on a later reconnect instead of once per process', async () => {
    const port = makePort([makeRow()]);

    const first = await drainPendingTrackerItems(WORKSPACE, port);
    const second = await drainPendingTrackerItems(WORKSPACE, port);

    expect(first.queued).toBe(1);
    // The whole point: a second connect in the same process must push again.
    expect(second.queued).toBe(1);
    expect(port.upsertItem).toHaveBeenCalledTimes(2);
  });

  it('does not start a second pass while one is still in flight', async () => {
    let releaseQuery: () => void = () => {};
    const blocked = new Promise<void>((resolve) => { releaseQuery = resolve; });
    const port = makePort([makeRow()]);
    port.query.mockImplementation(async () => {
      await blocked;
      return { rows: [makeRow()] };
    });

    const inFlight = drainPendingTrackerItems(WORKSPACE, port);
    const overlapping = await drainPendingTrackerItems(WORKSPACE, port);
    releaseQuery();
    await inFlight;

    expect(overlapping.skippedRun).toBe(true);
    expect(port.upsertItem).toHaveBeenCalledTimes(1);
  });

  it('tombstones an item that was published before and is now a draft', async () => {
    const port = makePort([makeRow({ sync_id: 42 })]);
    port.resolvePolicy = () => known('team', true);

    const result = await drainPendingTrackerItems(WORKSPACE, port);

    expect(result.deleted).toBe(1);
    expect(port.deleteItem).toHaveBeenCalledWith('bug-1');
    // Reset locally so the next reconnect does not re-delete it.
    expect(port.query).toHaveBeenCalledWith(
      expect.stringContaining("sync_status = 'local'"),
      ['bug-1'],
    );
  });

  it('leaves a never-published draft on the machine', async () => {
    // `local` already agrees with the policy, so there is nothing to correct.
    const port = makePort([makeRow({ sync_status: 'local' })]);
    port.resolvePolicy = () => known('personal');

    const result = await drainPendingTrackerItems(WORKSPACE, port);

    expect(result.skipped).toBe(1);
    expect(result.repaired).toBe(0);
    expect(port.upsertItem).not.toHaveBeenCalled();
    expect(port.deleteItem).not.toHaveBeenCalled();
  });

  it('repairs a personal draft still marked pending, without touching the room', async () => {
    const port = makePort([makeRow({ sync_status: 'pending' })]);
    port.resolvePolicy = () => known('personal');

    const result = await drainPendingTrackerItems(WORKSPACE, port);

    expect(result.repaired).toBe(1);
    expect(port.upsertItem).not.toHaveBeenCalled();
    expect(port.deleteItem).not.toHaveBeenCalled();
    // Guarded on sync_id in SQL as well as in the plan.
    expect(port.query).toHaveBeenCalledWith(
      expect.stringContaining('sync_id IS NULL'),
      ['bug-1'],
    );
  });

  it('keeps draining after one item fails to push', async () => {
    const port = makePort([makeRow({ id: 'bug-1' }), makeRow({ id: 'bug-2' })]);
    port.upsertItem.mockRejectedValueOnce(new Error('socket closed'));

    const result = await drainPendingTrackerItems(WORKSPACE, port);

    expect(result.queued).toBe(1);
    expect(port.upsertItem).toHaveBeenCalledTimes(2);
    // The failed row keeps its `pending` status, so the next connect retries it.
    expect(port.log.warn).toHaveBeenCalled();
  });
});

/**
 * NIM-2968. The branch that deleted 26 team items had never once executed under
 * observation, because it could only be reached inside a live engine with a
 * half-loaded registry. Extracting the decision is what makes it testable --
 * the `pgliteInitRecovery.js` pattern named in destructive-data-paths.md.
 */
describe('planTrackerDrain', () => {
  const candidate = (over: Record<string, unknown> = {}) => ({
    id: 'bug-1',
    trackerType: 'bug',
    previouslyShared: false,
    syncStatus: 'pending',
    resolution: known('team'),
    source: {},
    ...over,
  }) as any;

  it('aborts the whole run rather than deleting a shared item on an unresolved policy', () => {
    const plan = planTrackerDrain({
      workspacePath: WORKSPACE,
      syncedRowCount: 2700,
      candidates: [candidate({ previouslyShared: true, resolution: unresolved() })],
    });

    expect(plan.abort).toMatchObject({ reason: 'unresolved-policy-would-delete' });
    // Nothing executes on an abort -- not even the rows that resolved fine.
    expect(plan.actions).toEqual([]);
  });

  it('never creates a team item from a file projection the room has never had', () => {
    const file = { id: 'fm:decision:wiki/decision/second.md', trackerType: 'decision', syncStatus: 'local' };
    const plan = planTrackerDrain({
      workspacePath: WORKSPACE,
      syncedRowCount: 0,
      candidates: [
        candidate({ ...file, source: { source: 'frontmatter' } }),
        // Once shared it is the room's item, and the drain keeps it current.
        candidate({ ...file, id: 'fm:decision:old.md', previouslyShared: true, source: { source: 'frontmatter' } }),
      ],
    });
    expect(plan.actions).toEqual([
      { kind: 'skip', id: file.id, cause: 'routine' },
      { kind: 'upsert', id: 'fm:decision:old.md' },
    ]);
  });

  it('never creates a team item from an inline #type[...] marker the room has never had', () => {
    const scanned = { source: 'inline', module: 'temptests/fixture.md' };
    const plan = planTrackerDrain({
      workspacePath: WORKSPACE,
      syncedRowCount: 0,
      candidates: [
        candidate({ id: 'bug_a', source: scanned }),
        candidate({ id: 'bug_b', previouslyShared: true, source: scanned }),
        // An agent-created item with an inline origin has no document_path:
        // it was made deliberately and drains like any native item.
        candidate({ id: 'bug_c', source: { source: 'inline', sourceRef: 'notes.md' } }),
      ],
    });
    expect(plan.actions).toEqual([
      { kind: 'skip', id: 'bug_a', cause: 'routine' },
      { kind: 'upsert', id: 'bug_b' },
      { kind: 'upsert', id: 'bug_c' },
    ]);
  });

  it('counts an unresolved never-shared row separately instead of aborting', () => {
    const plan = planTrackerDrain({
      workspacePath: WORKSPACE,
      syncedRowCount: 0,
      candidates: [candidate({ previouslyShared: false, resolution: unresolved() })],
    });

    expect(plan.abort).toBeNull();
    expect(plan.actions).toEqual([
      { kind: 'skip', id: 'bug-1', cause: 'unresolved-policy' },
    ]);
  });

  it('aborts when a whole workspace of synced rows produces zero upserts and any delete', () => {
    // The aggregate signature of NIM-2968: `queued: 0  deleted: 26` against
    // ~2,700 synced items. No legitimate policy read produces that.
    const plan = planTrackerDrain({
      workspacePath: WORKSPACE,
      syncedRowCount: 2700,
      candidates: [
        candidate({ id: 'a', previouslyShared: true, resolution: known('personal') }),
        candidate({ id: 'b', previouslyShared: true, resolution: known('personal') }),
      ],
    });

    expect(plan.abort).toMatchObject({ reason: 'zero-upserts-with-deletes' });
    expect(plan.actions).toEqual([]);
  });

  it('allows a genuine unshare in a workspace that is not wholly failing to resolve', () => {
    // Same delete, but alongside a successful upsert -- so the read is working
    // and the delete is a real unshare, not a symptom.
    const plan = planTrackerDrain({
      workspacePath: WORKSPACE,
      syncedRowCount: 2700,
      candidates: [
        candidate({ id: 'a', previouslyShared: true, resolution: known('personal') }),
        candidate({ id: 'b', resolution: known('team'), source: { shared: true } }),
      ],
    });

    expect(plan.abort).toBeNull();
    expect(plan.actions).toContainEqual({ kind: 'delete', id: 'a' });
    expect(plan.actions).toContainEqual({ kind: 'upsert', id: 'b' });
  });

  it('lets a deliberate offline unshare through even as the only candidate', () => {
    // The guard's obvious false positive: unshare your only two pending items
    // while offline, reconnect, and a naive "zero upserts plus any delete"
    // check would abort and the unshare would never reach the room. The
    // tracker is still team here -- only the item's published bit flipped --
    // so this is the user's own action, not a failed policy read.
    const plan = planTrackerDrain({
      workspacePath: WORKSPACE,
      syncedRowCount: 2700,
      candidates: [
        candidate({ id: 'a', previouslyShared: true, resolution: known('team', true), source: {} }),
        candidate({ id: 'b', previouslyShared: true, resolution: known('team', true), source: {} }),
      ],
    });

    expect(plan.abort).toBeNull();
    expect(plan.actions).toEqual([
      { kind: 'delete', id: 'a' },
      { kind: 'delete', id: 'b' },
    ]);
  });

  it('does not fire the aggregate guard on a fresh workspace with nothing synced', () => {
    const plan = planTrackerDrain({
      workspacePath: WORKSPACE,
      syncedRowCount: 0,
      candidates: [candidate({ previouslyShared: true, resolution: known('personal') })],
    });

    expect(plan.abort).toBeNull();
    expect(plan.actions).toEqual([{ kind: 'delete', id: 'bug-1' }]);
  });

  it('repairs a stranded row by resetting it to local, never by pushing it', () => {
    // Leg 2's residue: 16 `idea` rows written when `idea` had no sharing
    // declaration and resolved team, still `pending` after it became
    // `sharing: personal` in 13580f2f6. Pushing them would publish personal
    // items into a team room; leaving them re-examines them on every reconnect
    // forever. `sync_id IS NULL` proves there is no remote copy to orphan.
    const plan = planTrackerDrain({
      workspacePath: WORKSPACE,
      syncedRowCount: 100,
      candidates: [candidate({
        id: 'idea-1',
        trackerType: 'idea',
        syncStatus: 'pending',
        previouslyShared: false,
        resolution: known('personal'),
      })],
    });

    expect(plan.actions).toEqual([{ kind: 'reset-local', id: 'idea-1' }]);
  });

  it('does not repair a row that still has a remote copy', () => {
    // `sync_id` set means the room has it. That is the unshare path, which
    // deletes deliberately -- not a state correction on a never-replicated row.
    const plan = planTrackerDrain({
      workspacePath: WORKSPACE,
      syncedRowCount: 100,
      candidates: [
        candidate({ id: 'shared', syncStatus: 'pending', previouslyShared: true, resolution: known('personal') }),
        candidate({ id: 'push', resolution: known('team'), source: { shared: true } }),
      ],
    });

    expect(plan.actions).toContainEqual({ kind: 'delete', id: 'shared' });
    expect(plan.actions).not.toContainEqual({ kind: 'reset-local', id: 'shared' });
  });

  it('never repairs on an unresolved policy', () => {
    const plan = planTrackerDrain({
      workspacePath: WORKSPACE,
      syncedRowCount: 100,
      candidates: [candidate({ syncStatus: 'pending', previouslyShared: false, resolution: unresolved() })],
    });

    expect(plan.actions).toEqual([{ kind: 'skip', id: 'bug-1', cause: 'unresolved-policy' }]);
  });

  it('separates a policy contradiction from a routine local-only skip', () => {
    // Leg 2: `pending` + policy says personal is two decisions disagreeing about
    // the same row, and it gets repaired. `local` + personal is agreement, and
    // it is a routine skip. Both were skips sharing one counter, which is why
    // this went unnoticed for ten months.
    const plan = planTrackerDrain({
      workspacePath: WORKSPACE,
      syncedRowCount: 0,
      candidates: [
        candidate({ id: 'contradiction', syncStatus: 'pending', resolution: known('personal') }),
        candidate({ id: 'routine', syncStatus: 'local', resolution: known('personal') }),
      ],
    });

    expect(plan.actions).toContainEqual({ kind: 'reset-local', id: 'contradiction' });
    expect(plan.actions).toContainEqual({ kind: 'skip', id: 'routine', cause: 'routine' });
  });
});

describe('drainPendingTrackerItems on an aborted plan', () => {
  it('deletes nothing and reports the abort before returning', async () => {
    const port = makePort([makeRow({ sync_id: 42 })]);
    port.resolvePolicy = () => unresolved();
    port.countSyncedRows = vi.fn(async () => 2700);

    const result = await drainPendingTrackerItems(WORKSPACE, port);

    expect(port.deleteItem).not.toHaveBeenCalled();
    expect(result.aborted).toMatchObject({ reason: 'unresolved-policy-would-delete' });
    // Emitted before acting, per destructive-data-paths.md: a mid-run death in
    // #1347 reported nothing because the event was computed at the end.
    expect(port.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unresolved-policy-would-delete' }),
    );
  });

  it('reloads schemas and proceeds when the second resolve succeeds', async () => {
    // "Retry before you destroy": an unresolved read is usually a race with
    // schema load. Without the reload the re-resolve would be theatre --
    // resolvePolicy is synchronous, so nothing could have changed.
    const port = makePort([makeRow({ sync_id: 42 })]);
    let loaded = false;
    port.reloadSchemas = vi.fn(async () => { loaded = true; });
    port.resolvePolicy = () => (loaded ? known('team') : unresolved());

    const result = await drainPendingTrackerItems(WORKSPACE, port);

    expect(port.reloadSchemas).toHaveBeenCalledWith(WORKSPACE);
    expect(result.aborted).toBeNull();
    expect(result.queued).toBe(1);
    expect(port.deleteItem).not.toHaveBeenCalled();
    expect(port.emitEvent).not.toHaveBeenCalled();
  });

  it('still aborts when the reload does not help', async () => {
    const port = makePort([makeRow({ sync_id: 42 })]);
    port.resolvePolicy = () => unresolved();

    const result = await drainPendingTrackerItems(WORKSPACE, port);

    expect(port.reloadSchemas).toHaveBeenCalledTimes(1);
    expect(result.aborted).not.toBeNull();
    expect(port.deleteItem).not.toHaveBeenCalled();
  });
});
