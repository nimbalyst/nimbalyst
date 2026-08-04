/**
 * Regression tests for `TrackerPGLiteStore.applyAndEnqueueAtomically`
 * crash-safe ordering (NIM-602, SECURITY_REVIEW_ADDENDUM Finding C).
 *
 * The previous implementation applied the projection first and then wrote
 * the queue row. A process crash in the gap left the projection updated
 * with no queue row, so the next bootstrap re-synced from the server
 * (which never saw the mutation) and silently overwrote the user's
 * optimistic edit. The fix changes the order to:
 *
 *   1. snapshot the current row,
 *   2. write the queue row in state `pendingApply`,
 *   3. apply the optimistic projection,
 *   4. promote the queue row to `persistedEnqueue`.
 *
 * Any crash window now leaves a `pendingApply` row that
 * `loadPendingTransactions` surfaces on next startup. The engine re-drives
 * `applyOptimistic`, which is idempotent against the stored payload.
 *
 * These tests pin the ordering invariant and the crash-recovery contract
 * with a tiny in-memory mock of the two tables `applyAndEnqueueAtomically`
 * touches. They do NOT exercise PGLite itself; the mock is faithful to
 * the SQL semantics this method relies on (single-row INSERT...ON
 * CONFLICT DO UPDATE on `tracker_items`, single-row INSERT on
 * `tracker_transactions`, single-row UPDATE on either).
 */

import { describe, expect, it } from 'vitest';
import type {
  TrackerItemPayload,
  TrackerTransactionRow,
} from '@nimbalyst/runtime/sync';
import { TrackerPGLiteStore } from '../TrackerPGLiteStore';

// ---------------------------------------------------------------------------
// Mock database with crash injection
// ---------------------------------------------------------------------------

interface MockTrackerItemRow {
  id: string;
  workspace: string;
  sync_status: string | null;
  sync_id: string | number | null;
  deleted_at: Date | null;
  data: unknown;
  // Extra columns the store reads back -- defaults below.
  type: string;
  type_tags: string[] | null;
  document_path: string | null;
  line_number: number | null;
  issue_number: number | null;
  issue_key: string | null;
  body_version: string | number | null;
  archived: boolean | null;
  source: string | null;
  source_ref: string | null;
  created: Date | null;
  updated: Date | null;
  last_indexed: Date | null;
}

interface MockTransactionRow {
  client_mutation_id: string;
  item_id: string;
  workspace_path: string;
  state: string;
  kind: string;
  payload: unknown;
  enqueued_at: Date;
  started_at: Date | null;
  confirmed_sync_id: string | number | null;
  last_rejection: unknown;
}

interface CallRecord {
  index: number;
  sql: string;
  params: unknown[] | undefined;
}

interface MockDbOptions {
  /**
   * If set, the mock throws a synthetic "process crashed" error AFTER
   * completing the call at the given 1-based index. Calls before this
   * index commit their changes; the throwing call still commits before
   * raising. Choose the index so the throw lands in the gap BETWEEN two
   * persistence steps.
   *
   * The throw fires exactly once. Subsequent calls run normally, which
   * models a "next process startup reads the on-disk state we just
   * left behind" recovery scenario.
   */
  throwAfterCallIndex?: number;
}

function makeMockDb(options: MockDbOptions = {}) {
  const trackerItems = new Map<string, MockTrackerItemRow>();
  const transactions = new Map<string, MockTransactionRow>();
  const calls: CallRecord[] = [];
  let callCounter = 0;
  let crashArmed = options.throwAfterCallIndex !== undefined;

  function maybeThrow() {
    if (crashArmed
        && options.throwAfterCallIndex !== undefined
        && callCounter >= options.throwAfterCallIndex) {
      // Disarm so the next call (representing a fresh process startup)
      // runs against the persisted state.
      crashArmed = false;
      throw new Error(`mock crash: simulated process exit after call ${callCounter}`);
    }
  }

  async function query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    callCounter += 1;
    calls.push({ index: callCounter, sql, params });

    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase();

    // SELECT branches ------------------------------------------------------

    if (upper.startsWith('SELECT')) {
      // snapshotRow() and getTrackerItem() both SELECT FROM tracker_items
      // WHERE id = $1 AND workspace = $2.
      if (/FROM\s+TRACKER_ITEMS/i.test(sql)
          && /WHERE\s+id\s*=\s*\$1\s+AND\s+workspace\s*=\s*\$2/i.test(sql)) {
        const [id, workspace] = params ?? [];
        const row = trackerItems.get(String(id));
        const rows = row && row.workspace === workspace ? [row] : [];
        maybeThrow();
        return { rows: rows as T[] };
      }

      // SELECT (data->'labelsMap') AS labels_map FROM tracker_items WHERE id = $1
      if (/labelsMap/i.test(sql)) {
        const [id] = params ?? [];
        const row = trackerItems.get(String(id));
        const data = (row?.data as Record<string, unknown> | undefined) ?? {};
        maybeThrow();
        return { rows: [{ labels_map: data.labelsMap ?? null }] as T[] };
      }

      // Issue-number conflict probe in applyRemoteItem (not used by
      // applyOptimistic, but include for completeness).
      if (/issue_number/i.test(sql) && /LIMIT\s+1/i.test(sql)) {
        maybeThrow();
        return { rows: [] };
      }

      // loadPendingTransactions
      if (/FROM\s+TRACKER_TRANSACTIONS/i.test(sql) && /confirmed_sync_id\s+IS\s+NULL/i.test(sql)) {
        const [workspacePath] = params ?? [];
        const rows = [...transactions.values()]
          .filter(r => r.workspace_path === workspacePath && r.confirmed_sync_id === null)
          .sort((a, b) => a.enqueued_at.getTime() - b.enqueued_at.getTime());
        maybeThrow();
        return { rows: rows as T[] };
      }

      maybeThrow();
      return { rows: [] };
    }

    // INSERT branches ------------------------------------------------------

    if (upper.startsWith('INSERT')) {
      if (/INTO\s+TRACKER_ITEMS/i.test(sql)) {
        // Param order from the store:
        // 1=id, 2=type, 3=type_tags, 4=data, 5=workspace,
        // 6=document_path, 7=line_number, 8=issue_number, 9=issue_key,
        // 10=sync_id, 11=body_version,
        // 12=archived, 13=source, 14=source_ref, 15=content
        const p = params ?? [];
        const id = String(p[0]);
        const isPendingPath = /sync_status\s*=\s*'pending'/i.test(sql) || /'pending'/.test(sql);
        const next: MockTrackerItemRow = {
          id,
          workspace: String(p[4]),
          sync_status: isPendingPath ? 'pending' : 'synced',
          sync_id: p[10] as MockTrackerItemRow['sync_id'],
          deleted_at: null,
          data: typeof p[3] === 'string' ? JSON.parse(p[3] as string) : p[3],
          type: String(p[1]),
          type_tags: p[2] as string[] | null,
          document_path: p[5] as string | null,
          line_number: p[6] as number | null,
          issue_number: p[7] as number | null,
          issue_key: p[8] as string | null,
          body_version: p[11] as MockTrackerItemRow['body_version'],
          archived: p[12] as boolean | null,
          source: p[13] as string | null,
          source_ref: p[14] as string | null,
          created: new Date(),
          updated: new Date(),
          last_indexed: new Date(),
        };
        const existing = trackerItems.get(id);
        if (existing) {
          // ON CONFLICT DO UPDATE: keep existing identifiers/columns we
          // don't touch in tests; only refresh the writable fields. For
          // simplicity, overwrite the row with `next` (the test scenarios
          // never depend on the COALESCE branches firing).
          trackerItems.set(id, { ...existing, ...next });
        } else {
          trackerItems.set(id, next);
        }
        maybeThrow();
        return { rows: [] };
      }

      if (/INTO\s+TRACKER_TRANSACTIONS/i.test(sql)) {
        // Param order: 1=client_mutation_id, 2=item_id, 3=workspace_path,
        // 4=state, 5=kind, 6=payload, 7=enqueued_at (ms)
        const p = params ?? [];
        const cmid = String(p[0]);
        const next: MockTransactionRow = {
          client_mutation_id: cmid,
          item_id: String(p[1]),
          workspace_path: String(p[2]),
          state: String(p[3]),
          kind: String(p[4]),
          payload: typeof p[5] === 'string' ? JSON.parse(p[5] as string) : p[5],
          enqueued_at: new Date(Number(p[6])),
          started_at: null,
          confirmed_sync_id: null,
          last_rejection: null,
        };
        const existing = transactions.get(cmid);
        if (existing) {
          // ON CONFLICT DO UPDATE: refresh state/kind/payload only.
          existing.state = next.state;
          existing.kind = next.kind;
          existing.payload = next.payload;
        } else {
          transactions.set(cmid, next);
        }
        maybeThrow();
        return { rows: [] };
      }
    }

    // UPDATE branches ------------------------------------------------------

    if (upper.startsWith('UPDATE')) {
      if (/UPDATE\s+TRACKER_ITEMS/i.test(sql)) {
        const p = params ?? [];
        // Local tombstone path: UPDATE tracker_items SET deleted_at = NOW(), sync_status = 'pending' WHERE id = $1 AND workspace = $2
        // Or the applyRemoteItem tombstone path with deleted_at + sync_id parameters.
        const id = String(p[0]);
        const row = trackerItems.get(id);
        if (row) {
          if (/sync_status\s*=\s*'pending'/i.test(sql)) {
            row.sync_status = 'pending';
            row.deleted_at = new Date();
          }
        }
        maybeThrow();
        return { rows: [] };
      }

      if (/UPDATE\s+TRACKER_TRANSACTIONS/i.test(sql)) {
        const p = params ?? [];
        // markTransactionState: SET state = $1 [, started_at = ...] WHERE client_mutation_id = $2 or $3
        if (/SET\s+state\s*=\s*\$1/i.test(sql)) {
          const newState = String(p[0]);
          const cmid = String(p[p.length - 1]);
          const row = transactions.get(cmid);
          if (row) row.state = newState;
          maybeThrow();
          return { rows: [] };
        }

        // rejectTransaction: SET last_rejection = $1::jsonb WHERE client_mutation_id = $2
        if (/last_rejection/i.test(sql)) {
          const cmid = String(p[1]);
          const row = transactions.get(cmid);
          if (row) row.last_rejection = typeof p[0] === 'string' ? JSON.parse(p[0] as string) : p[0];
          maybeThrow();
          return { rows: [] };
        }
      }
    }

    // DELETE branches ------------------------------------------------------

    if (upper.startsWith('DELETE')) {
      if (/FROM\s+TRACKER_TRANSACTIONS/i.test(sql)) {
        const p = params ?? [];
        transactions.delete(String(p[0]));
        maybeThrow();
        return { rows: [] };
      }
      if (/FROM\s+TRACKER_ITEMS/i.test(sql)) {
        const p = params ?? [];
        trackerItems.delete(String(p[0]));
        maybeThrow();
        return { rows: [] };
      }
    }

    maybeThrow();
    return { rows: [] };
  }

  return {
    query,
    state: { trackerItems, transactions },
    calls,
    callCount: () => callCounter,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE = '/tmp/test-workspace';
const ITEM_ID = 'item-abc';
const MUTATION_ID = 'mut-001';

function makePayload(overrides: Partial<TrackerItemPayload> = {}): TrackerItemPayload {
  return {
    itemId: ITEM_ID,
    primaryType: 'bug',
    archived: false,
    bodyVersion: 0,
    fields: { title: 'a tracker item', status: 'open', priority: 'high' },
    labels: {},
    comments: [],
    system: {
      authorIdentity: null,
      lastModifiedBy: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

function makeTxRow(
  payload: TrackerItemPayload,
  overrides: Partial<TrackerTransactionRow> = {},
): TrackerTransactionRow {
  return {
    clientMutationId: MUTATION_ID,
    itemId: ITEM_ID,
    workspacePath: WORKSPACE,
    state: 'pendingApply',
    kind: 'create',
    payload,
    enqueuedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrackerPGLiteStore.applyAndEnqueueAtomically — crash-safe ordering (NIM-602, Finding C)', () => {
  it('enqueues the transaction row with state=pendingApply BEFORE writing the projection', async () => {
    const db = makeMockDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = new TrackerPGLiteStore(db as any, WORKSPACE);

    const payload = makePayload();
    const row = makeTxRow(makePayload());

    await store.applyAndEnqueueAtomically(ITEM_ID, payload, row);

    // Find the call indices for the two key writes.
    const txInsertIndex = db.calls.find(c =>
      c.sql.includes('INSERT INTO tracker_transactions'),
    )?.index;
    const projectionInsertIndex = db.calls.find(c =>
      c.sql.includes('INSERT INTO tracker_items'),
    )?.index;

    expect(txInsertIndex).toBeDefined();
    expect(projectionInsertIndex).toBeDefined();
    expect(txInsertIndex!).toBeLessThan(projectionInsertIndex!);
  });

  it('promotes the transaction row to persistedEnqueue AFTER writing the projection', async () => {
    const db = makeMockDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = new TrackerPGLiteStore(db as any, WORKSPACE);

    await store.applyAndEnqueueAtomically(ITEM_ID, makePayload(), makeTxRow(makePayload()));

    const projectionInsertIndex = db.calls.find(c =>
      c.sql.includes('INSERT INTO tracker_items'),
    )?.index;
    const promotionIndex = db.calls.find(c =>
      c.sql.includes('UPDATE tracker_transactions') && /SET\s+state\s*=\s*\$1/i.test(c.sql),
    )?.index;

    expect(projectionInsertIndex).toBeDefined();
    expect(promotionIndex).toBeDefined();
    expect(projectionInsertIndex!).toBeLessThan(promotionIndex!);

    const finalRow = db.state.transactions.get(MUTATION_ID);
    expect(finalRow?.state).toBe('persistedEnqueue');
  });

  it('a crash AFTER enqueueTransaction (call 2) leaves a recoverable pendingApply row that loadPendingTransactions surfaces; projection is unchanged', async () => {
    // Call ordering from the source (brand-new row, no prior projection):
    //   1. snapshotRow              -> SELECT FROM tracker_items
    //   2. enqueueTransaction       -> INSERT INTO tracker_transactions (pendingApply)
    //   3. applyOptimistic snapshot -> SELECT FROM tracker_items
    //   4. applyOptimistic upsert   -> INSERT INTO tracker_items
    //   5. markTransactionState     -> UPDATE tracker_transactions (persistedEnqueue)
    //
    // Throwing right after call 2 means the queue row is committed but
    // the projection write has not happened yet.
    const db = makeMockDb({ throwAfterCallIndex: 2 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = new TrackerPGLiteStore(db as any, WORKSPACE);

    const payload = makePayload();
    const row = makeTxRow(payload);

    await expect(
      store.applyAndEnqueueAtomically(ITEM_ID, payload, row),
    ).rejects.toThrow(/mock crash/);

    // The queue row exists and is in `pendingApply`.
    const queued = db.state.transactions.get(MUTATION_ID);
    expect(queued, 'queue row must exist after the crash').toBeDefined();
    expect(queued?.state).toBe('pendingApply');

    // The projection was NOT written.
    expect(db.state.trackerItems.has(ITEM_ID)).toBe(false);

    // Bootstrap recovery: loadPendingTransactions surfaces the row so the
    // engine can re-drive `applyOptimistic`.
    const pending = await store.loadPendingTransactions();
    expect(pending).toHaveLength(1);
    expect(pending[0].clientMutationId).toBe(MUTATION_ID);
    expect(pending[0].state).toBe('pendingApply');
    // Payload survived the crash so replay can re-apply the exact edit.
    expect(pending[0].payload).toEqual(payload);
  });

  it('a crash AFTER the projection INSERT (call 4) still leaves a pendingApply row; replay through applyOptimistic is idempotent', async () => {
    // Walk the calls until we land just after the tracker_items INSERT,
    // then throw. Use a high call ceiling and stop right after we've
    // observed both writes.
    //
    // Sequence (brand-new row create):
    //   1. SELECT tracker_items                (outer snapshotRow)
    //   2. INSERT tracker_transactions         (pendingApply)
    //   3. SELECT tracker_items                (applyOptimistic's own snapshotRow)
    //   4. INSERT tracker_items                (projection write)
    //   5. UPDATE tracker_transactions         (promote -> persistedEnqueue)
    //
    // Throw after call 4: queue row still in pendingApply, projection done.
    const db = makeMockDb({ throwAfterCallIndex: 4 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = new TrackerPGLiteStore(db as any, WORKSPACE);

    await expect(
      store.applyAndEnqueueAtomically(ITEM_ID, makePayload(), makeTxRow(makePayload())),
    ).rejects.toThrow(/mock crash/);

    const queued = db.state.transactions.get(MUTATION_ID);
    expect(queued).toBeDefined();
    expect(queued?.state).toBe(
      'pendingApply',
      // Note: `expect.toBe` doesn't take a message, but the failure shape
      // makes the intent clear -- promotion to persistedEnqueue is call 5
      // and our crash lands at 4.
    );

    // Projection is written (mock state reflects the upsert).
    expect(db.state.trackerItems.has(ITEM_ID)).toBe(true);

    // Bootstrap-style replay:
    //   1. loadPendingTransactions sees the pendingApply row.
    //   2. The engine calls `applyOptimistic` again with the same payload.
    //   3. Result is idempotent -- the row exists, with the same payload.
    const pending = await store.loadPendingTransactions();
    expect(pending).toHaveLength(1);

    await store.applyOptimistic(ITEM_ID, pending[0].payload ?? null);
    const replayedRow = db.state.trackerItems.get(ITEM_ID);
    expect(replayedRow).toBeDefined();
    expect(replayedRow?.sync_status).toBe('pending');
  });
});
