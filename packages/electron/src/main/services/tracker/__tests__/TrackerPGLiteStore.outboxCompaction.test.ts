// @vitest-environment node
/**
 * NIM-7336: stacked update rows in `tracker_transactions` are hidden from
 * replay behind one replayable replacement, rebuilt from the item's local row
 * at engine start when that row is the newest local state, and deleted only
 * once the room accepts the replacement.
 *
 * Runs on both live backends: better-sqlite3 through `SQLiteDatabase` (the
 * class the SQLite worker wraps) and PGLite through the worker's own
 * `runTransactionStatements`. Each reopens its database to cover a second
 * launch.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PGlite } from '@electric-sql/pglite';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { TrackerPGLiteStore } from '../TrackerPGLiteStore';
import type { TrackerItemPayload } from '@nimbalyst/runtime/sync';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runTransactionStatements } = require('../../../database/transactionStatements');

const WS = '/ws/project';
const OTHER_WS = '/ws/other';

interface Backend {
  open(dir: string): Promise<{ db: any; close: () => Promise<void> }>;
}

const backends: Record<string, Backend> = {
  sqlite: {
    async open(dir) {
      const db = new SQLiteDatabase({
        dbDir: dir,
        schemaDir: path.resolve(__dirname, '..', '..', '..', 'database', 'sqlite', 'schemas'),
        slowQueryThresholdMs: 1000,
        sampleRate: 0,
      });
      await db.initialize();
      return { db, close: () => db.close() };
    },
  },
  pglite: {
    async open(dir) {
      const pg = new PGlite({ dataDir: dir });
      await pg.waitReady;
      // Same DDL as the PGLite worker (worker.js).
      await pg.exec(`
        CREATE TABLE IF NOT EXISTS tracker_transactions (
          client_mutation_id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('created','queued','executing','persistedEnqueue')),
          kind TEXT NOT NULL CHECK (kind IN ('create','update','delete')),
          payload JSONB,
          enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          started_at TIMESTAMPTZ,
          confirmed_sync_id BIGINT,
          last_rejection JSONB
        );
        CREATE TABLE IF NOT EXISTS tracker_items (
          id TEXT PRIMARY KEY,
          issue_number INTEGER,
          issue_key TEXT,
          type TEXT NOT NULL,
          data JSONB NOT NULL,
          workspace TEXT NOT NULL,
          document_path TEXT,
          line_number INTEGER,
          content JSONB,
          archived BOOLEAN NOT NULL DEFAULT FALSE,
          source TEXT DEFAULT 'inline',
          source_ref TEXT,
          type_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          sync_status TEXT DEFAULT 'local',
          sync_id BIGINT,
          body_version INTEGER NOT NULL DEFAULT 0,
          deleted_at TIMESTAMPTZ,
          created TIMESTAMPTZ DEFAULT NOW(),
          updated TIMESTAMPTZ DEFAULT NOW(),
          last_indexed TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      const db = {
        query: (sql: string, params?: unknown[]) => pg.query(sql, params),
        runTransaction: (statements: unknown[]) =>
          pg.transaction(tx => runTransactionStatements(tx, statements)),
      };
      return { db, close: () => pg.close() };
    },
  },
};

function payload(itemId: string, title: string): TrackerItemPayload {
  return {
    itemId,
    primaryType: 'plan',
    archived: false,
    bodyVersion: 0,
    fields: { title },
    labels: {},
    comments: [],
    system: {},
  };
}

describe.each(Object.entries(backends))('tracker outbox compaction (%s)', (_name, backend) => {
  let dir: string;
  let close: () => Promise<void> = async () => {};

  async function closeOpen(): Promise<void> {
    const closing = close;
    close = async () => {};
    await closing();
  }

  afterEach(async () => {
    await closeOpen();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function launch(): Promise<{ db: any; store: TrackerPGLiteStore }> {
    await closeOpen();
    const opened = await backend.open(dir);
    close = opened.close;
    return { db: opened.db, store: new TrackerPGLiteStore(opened.db, WS) };
  }

  async function enqueue(store: TrackerPGLiteStore, id: string, itemId: string, kind: 'create' | 'update' | 'delete', at: number, workspacePath = WS) {
    await store.enqueueTransaction({
      clientMutationId: id,
      itemId,
      workspacePath,
      state: 'executing',
      kind,
      payload: kind === 'delete' ? undefined : payload(itemId, id),
      enqueuedAt: at,
    });
  }

  async function ids(db: any): Promise<string[]> {
    const rows = await db.query('SELECT client_mutation_id FROM tracker_transactions ORDER BY client_mutation_id');
    return rows.rows.map((row: { client_mutation_id: string }) => row.client_mutation_id).sort();
  }

  async function seed(db: any, store: TrackerPGLiteStore) {
    await enqueue(store, 'a-create', 'A', 'create', 500);
    await enqueue(store, 'a-1', 'A', 'update', 1000);
    await enqueue(store, 'a-2', 'A', 'update', 2000);
    await enqueue(store, 'a-3', 'A', 'update', 3000);
    await enqueue(store, 'b-1', 'B', 'update', 1000);
    await enqueue(store, 'c-confirmed', 'C', 'update', 1000);
    await enqueue(store, 'c-2', 'C', 'update', 2000);
    await enqueue(store, 'other-1', 'A', 'update', 1000, OTHER_WS);
    await enqueue(store, 'other-2', 'A', 'update', 2000, OTHER_WS);
    await db.query(`UPDATE tracker_transactions SET confirmed_sync_id = 7 WHERE client_mutation_id = 'c-confirmed'`);
  }

  /** The engine-start step, as the engine calls it. */
  async function startup(store: TrackerPGLiteStore): Promise<void> {
    await store.consolidatePendingUpdates();
  }

  /** A row written before the enqueue clock: its time is whatever the wall clock said. */
  async function insertLegacyRow(db: any, id: string, itemId: string, title: string, at: string) {
    await db.query(
      `INSERT INTO tracker_transactions (client_mutation_id, item_id, workspace_path, state, kind, payload, enqueued_at)
       VALUES ($1, $2, $3, 'executing', 'update', $4::jsonb, $5::timestamptz)`,
      [id, itemId, WS, JSON.stringify(payload(itemId, title)), at],
    );
  }

  it('rebuilds one update from the pending local item when legacy rows contradict the clock, and deletes nothing before the room accepts it', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-outbox-'));
    const first = await launch();
    // Edit A, then the clock was set back an hour, then edit B. The local row
    // holds B, the newest local state.
    await insertLegacyRow(first.db, 'p-edit-a', 'P', 'edit A', '2026-09-09T10:00:00.000Z');
    await insertLegacyRow(first.db, 'p-edit-b', 'P', 'edit B', '2026-09-09T09:00:00.000Z');
    await first.store.applyOptimistic('P', payload('P', 'edit B'));
    // Q's local row was since overwritten by the room, so it says nothing about
    // which of Q's rows is newer. Q is left alone.
    await insertLegacyRow(first.db, 'q-edit-a', 'Q', 'edit A', '2026-09-09T10:00:00.000Z');
    await insertLegacyRow(first.db, 'q-edit-b', 'Q', 'edit B', '2026-09-09T09:00:00.000Z');
    await first.store.applyRemoteItem(
      { itemId: 'Q', syncId: 3, encryptedPayload: 'x', iv: '', updatedAt: 1, deletedAt: null, orgKeyFingerprint: null },
      payload('Q', 'from a teammate'),
    );
    const legacy = ['p-edit-a', 'p-edit-b', 'q-edit-a', 'q-edit-b'];

    await startup(first.store);
    const rebuilt = (await ids(first.db)).filter(id => !legacy.includes(id));
    expect(rebuilt).toHaveLength(1);
    expect(await ids(first.db)).toEqual([...legacy, ...rebuilt].sort());
    const firstReplay = await first.store.loadPendingTransactions();
    expect(firstReplay.find(row => row.itemId === 'P')).toMatchObject({ clientMutationId: rebuilt[0] });
    expect(firstReplay.filter(row => row.itemId === 'P').map(row => row.payload?.fields.title)).toEqual(['edit B']);

    const second = await launch();
    await startup(second.store);
    expect(await ids(second.db)).toEqual([...legacy, ...rebuilt].sort());
    expect((await second.store.loadPendingTransactions()).filter(row => row.itemId === 'P').map(row => row.clientMutationId))
      .toEqual(rebuilt);

    await second.store.ackTransaction(rebuilt[0], 9);
    expect(await ids(second.db)).toEqual(['q-edit-a', 'q-edit-b']);
  });

  it('brings the replaced rows back when the room permanently refuses the rebuilt update', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-outbox-'));
    const first = await launch();
    await insertLegacyRow(first.db, 'p-edit-a', 'P', 'edit A', '2026-09-09T09:00:00.000Z');
    await insertLegacyRow(first.db, 'p-edit-b', 'P', 'edit B', '2026-09-09T10:00:00.000Z');
    await first.store.applyOptimistic('P', payload('P', 'edit B'));
    await startup(first.store);
    const [rebuilt] = (await ids(first.db)).filter(id => !id.startsWith('p-edit-'));

    await first.store.rejectTransaction(rebuilt, { code: 'malformed', message: 'no', occurredAt: 1 });

    const second = await launch();
    await startup(second.store);
    expect(await ids(second.db)).toEqual(['p-edit-a', 'p-edit-b', rebuilt].sort());
    expect((await second.store.loadPendingTransactions()).map(row => row.clientMutationId))
      .toEqual(['p-edit-b', rebuilt]);
  });

  it('orders by local enqueue order, not the wall clock, across a relaunch', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-outbox-'));
    const first = await launch();
    // The clock moved back between two offline edits: the later edit carries
    // the smaller wall-clock time.
    await enqueue(first.store, 'a-before', 'A', 'update', 5000);
    await enqueue(first.store, 'a-after', 'A', 'update', 1000);
    await enqueue(first.store, 'b-before', 'B', 'update', 5000);
    await enqueue(first.store, 'b-after', 'B', 'update', 1000);

    // Acking the earlier edit must not retire the later one.
    await first.store.ackTransaction('b-before', 1);
    expect(await ids(first.db)).toEqual(['a-after', 'a-before', 'b-after']);

    const second = await launch();
    expect((await second.store.loadPendingTransactions()).map(row => row.clientMutationId))
      .toEqual(['a-after', 'b-after']);
    await startup(second.store);
    expect(await ids(second.db)).toEqual(['a-after', 'a-before', 'b-after']);

    const third = await launch();
    await startup(third.store);
    expect((await third.store.loadPendingTransactions()).map(row => row.payload?.fields.title))
      .toEqual(['a-after', 'b-after']);
  });

  it('keeps a predecessor whose replacement was rejected or is separated by a delete', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-outbox-'));
    const first = await launch();
    await enqueue(first.store, 'a-1', 'A', 'update', 1000);
    await enqueue(first.store, 'a-2', 'A', 'update', 2000);
    await first.store.rejectTransaction('a-2', { code: 'malformed', message: 'no', occurredAt: 2500 });
    await enqueue(first.store, 'b-1', 'B', 'update', 1000);
    await enqueue(first.store, 'b-delete', 'B', 'delete', 1500);
    await enqueue(first.store, 'b-2', 'B', 'update', 2000);

    await startup(first.store);

    const second = await launch();
    await startup(second.store);
    expect(await ids(second.db)).toEqual(['a-1', 'a-2', 'b-1', 'b-2', 'b-delete']);
    expect((await second.store.loadPendingTransactions()).map(row => row.clientMutationId))
      .toEqual(['a-1', 'b-1', 'b-delete', 'a-2', 'b-2']);
  });

  it('retires older updates of the same item when the newest is acked', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-outbox-'));
    const { db, store } = await launch();
    await seed(db, store);

    await store.ackTransaction('a-3', 42);

    expect(await ids(db)).toEqual(['a-create', 'b-1', 'c-2', 'c-confirmed', 'other-1', 'other-2']);
    expect((await store.loadPendingTransactions()).map(row => row.clientMutationId))
      .toEqual(['a-create', 'b-1', 'c-2']);
  });
});
