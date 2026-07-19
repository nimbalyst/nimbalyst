import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../database/sqlite/SQLiteStoreAdapter';
import {
  createHostControlReceiptsStore,
  type HostControlReceiptsStore,
} from '../HostControlReceiptsStore';

describe('HostControlReceiptsStore dual-backend contract', () => {
  let pglite: PGlite;
  let sqlite: SQLiteDatabase;
  let tempDir: string;
  let pgliteStore: HostControlReceiptsStore;
  let sqliteStore: HostControlReceiptsStore;

  beforeAll(async () => {
    pglite = new PGlite();
    await (pglite as unknown as { waitReady: Promise<void> }).waitReady;
    await pglite.exec(`
      CREATE TABLE host_control_receipts (
        id TEXT PRIMARY KEY,
        reservation_key TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation = 'inject_attention_reply'),
        session_id TEXT NOT NULL,
        event_identity TEXT NOT NULL,
        attention_generation TEXT,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'injected', 'already_resolved', 'failed')),
        receipt JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE native_winner_outbox (
        id TEXT PRIMARY KEY,
        reservation_key TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        event_identity TEXT NOT NULL,
        attention_generation TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        receipt JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_attempt_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ
      );
    `);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-control-receipts-'));
    sqlite = new SQLiteDatabase({
      dbDir: tempDir,
      schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'),
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await sqlite.initialize();
    pgliteStore = createHostControlReceiptsStore(pglite);
    sqliteStore = createHostControlReceiptsStore(createSQLiteStoreAdapter(sqlite));
  });

  beforeEach(async () => {
    await pglite.exec('DELETE FROM host_control_receipts; DELETE FROM native_winner_outbox;');
    const handle = sqlite.getRawHandle()!;
    handle.exec('DELETE FROM host_control_receipts; DELETE FROM native_winner_outbox;');
  });

  afterAll(async () => {
    await sqlite.close();
    await pglite.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function reserve(store: HostControlReceiptsStore, digest = 'digest-1') {
    return store.reserveReceipt({
      reservationKey: 'attention-reply:watch-1',
      requestDigest: digest,
      operation: 'inject_attention_reply',
      sessionId: 'session-1',
      eventIdentity: 'prompt-1',
      attentionGeneration: 'generation-1',
    });
  }

  it.each([
    ['PGLite', () => pgliteStore],
    ['SQLite', () => sqliteStore],
  ])('%s reserves once and same-digest replay is a no-op read', async (_name, getStore) => {
    const store = getStore();
    const first = await reserve(store);
    const replay = await reserve(store);

    expect(first.isNewReservation).toBe(true);
    expect(replay.isNewReservation).toBe(false);
    expect(replay.row.id).toBe(first.row.id);
    expect(replay.row.state).toBe('reserved');
  });

  it.each([
    ['PGLite', () => pgliteStore],
    ['SQLite', () => sqliteStore],
  ])('%s rejects a different digest under the unique reservation key', async (_name, getStore) => {
    const store = getStore();
    await reserve(store);
    await expect(reserve(store, 'digest-2')).rejects.toThrow('idempotency_conflict');
  });

  it.each([
    ['PGLite', () => pgliteStore],
    ['SQLite', () => sqliteStore],
  ])('%s rejects a receipt over the true 4096-byte cap before mutation', async (_name, getStore) => {
    const store = getStore();
    const reserved = await reserve(store);

    await expect(store.finalizeReceipt({
      id: reserved.row.id,
      state: 'failed',
      receipt: { error: 'é'.repeat(4096) },
    })).rejects.toThrow('exceeds 4096 bytes');
    await expect(store.getByReservationKey('attention-reply:watch-1'))
      .resolves.toMatchObject({ state: 'reserved', receipt: undefined });
  });

  it('decodes PGLite JSONB and SQLite TEXT receipts identically', async () => {
    const receipt = {
      outcome: 'injected',
      verified: true,
      receipt: { route: 'host-attention-answer', event_cleared: true },
    };
    const pgliteReserved = await reserve(pgliteStore);
    const sqliteReserved = await reserve(sqliteStore);
    const [pgliteFinal, sqliteFinal] = await Promise.all([
      pgliteStore.finalizeReceipt({ id: pgliteReserved.row.id, state: 'injected', receipt }),
      sqliteStore.finalizeReceipt({ id: sqliteReserved.row.id, state: 'injected', receipt }),
    ]);

    expect({
      reservationKey: pgliteFinal.reservationKey,
      requestDigest: pgliteFinal.requestDigest,
      operation: pgliteFinal.operation,
      sessionId: pgliteFinal.sessionId,
      eventIdentity: pgliteFinal.eventIdentity,
      attentionGeneration: pgliteFinal.attentionGeneration,
      state: pgliteFinal.state,
      receipt: pgliteFinal.receipt,
    }).toEqual({
      reservationKey: sqliteFinal.reservationKey,
      requestDigest: sqliteFinal.requestDigest,
      operation: sqliteFinal.operation,
      sessionId: sqliteFinal.sessionId,
      eventIdentity: sqliteFinal.eventIdentity,
      attentionGeneration: sqliteFinal.attentionGeneration,
      state: sqliteFinal.state,
      receipt: sqliteFinal.receipt,
    });
  });
});
