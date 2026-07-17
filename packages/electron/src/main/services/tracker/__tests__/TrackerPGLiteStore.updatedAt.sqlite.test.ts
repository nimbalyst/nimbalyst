/**
 * NIM-1559: `applyRemoteItem` must NOT re-stamp `updated` on a no-op
 * re-apply of an unchanged envelope.
 *
 * A reconnect/bootstrap re-drives `applyRemoteItem` for every synced item.
 * The old code set `updated = NOW()` on every accepted delta, so every
 * reconnect advanced every item's `updated` to the receive time -- exactly
 * the "trackers randomly update their timestamp" symptom. The fix honors the
 * envelope's authoritative `updatedAt`, so re-applying the SAME envelope
 * writes back the SAME timestamp.
 *
 * Runs against a real in-memory better-sqlite3 backend so the dialect
 * translation of `to_timestamp($n / 1000.0)` and `updated = EXCLUDED.updated`
 * is exercised, not a hand-rolled mock.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { TrackerPGLiteStore } from '../TrackerPGLiteStore';
import type {
  EncryptedTrackerItemEnvelope,
  TrackerItemPayload,
} from '@nimbalyst/runtime/sync';

const WS = '/ws/project';

function makePayload(overrides: Partial<TrackerItemPayload> = {}): TrackerItemPayload {
  return {
    itemId: 'bug-1',
    primaryType: 'bug',
    archived: false,
    bodyVersion: 0,
    fields: { title: 'A bug', status: 'to-do', priority: 'high' },
    labels: {},
    comments: [],
    system: {},
    ...overrides,
  };
}

function makeEnvelope(
  overrides: Partial<EncryptedTrackerItemEnvelope> = {},
): EncryptedTrackerItemEnvelope {
  return {
    itemId: 'bug-1',
    syncId: 1,
    encryptedPayload: 'x',
    iv: 'iv',
    updatedAt: 1_700_000_000_000, // fixed ms timestamp
    deletedAt: null,
    orgKeyFingerprint: null,
    ...overrides,
  };
}

describe('TrackerPGLiteStore.applyRemoteItem updated timestamp (SQLite)', () => {
  let tmpDir: string;
  let sqlite: SQLiteDatabase;
  let store: TrackerPGLiteStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-tracker-upd-'));
    const schemaDir = path.resolve(__dirname, '..', '..', '..', 'database', 'sqlite', 'schemas');
    sqlite = new SQLiteDatabase({
      dbDir: tmpDir,
      schemaDir,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await sqlite.initialize();
    store = new TrackerPGLiteStore(sqlite as any, WS);
  });

  afterEach(async () => {
    await sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function readUpdated(id: string): Promise<string> {
    const res = await sqlite.query<any>(
      `SELECT updated FROM tracker_items WHERE id = $1`,
      [id],
    );
    return String(res.rows[0].updated);
  }

  it('honors envelope.updatedAt instead of stamping receive time', async () => {
    await store.applyRemoteItem(makeEnvelope(), makePayload());
    const updated = await readUpdated('bug-1');
    // to_timestamp(1_700_000_000_000 / 1000) === 2023-11-14T22:13:20Z
    expect(updated.startsWith('2023-11-14')).toBe(true);
  });

  it('does NOT advance updated when the SAME envelope is re-applied', async () => {
    await store.applyRemoteItem(makeEnvelope(), makePayload());
    const first = await readUpdated('bug-1');

    // Reconnect/bootstrap re-applies the identical envelope (same updatedAt).
    await store.applyRemoteItem(makeEnvelope({ syncId: 2 }), makePayload());
    const second = await readUpdated('bug-1');

    expect(second).toBe(first);
  });

  it('applyOptimistic honors payload.system.updatedAt across re-pushes', async () => {
    // The real producer (trackerItemToPayload -> trackerItemToRecord) sets
    // system.updatedAt to the item's existing `updated` as an ISO string.
    // backfillSharedLocalItems re-pushes pending items on every connect via
    // engine.upsertItem -> applyOptimistic; honoring this timestamp keeps the
    // re-push idempotent instead of stamping the connect time.
    const editedAtIso = '2023-11-14T22:17:30.000Z';
    await store.applyOptimistic('bug-1', makePayload({ system: { updatedAt: editedAtIso } as any }));
    const first = await readUpdated('bug-1');
    expect(new Date(first).getTime()).toBe(new Date(editedAtIso).getTime());

    // Reconnect re-pushes with the SAME (now the stored) updatedAt.
    await store.applyOptimistic('bug-1', makePayload({ system: { updatedAt: editedAtIso } as any }));
    const second = await readUpdated('bug-1');
    expect(second).toBe(first);
  });

  it('advances updated when a newer envelope carries a later updatedAt', async () => {
    await store.applyRemoteItem(makeEnvelope(), makePayload());
    const first = await readUpdated('bug-1');

    await store.applyRemoteItem(
      makeEnvelope({ syncId: 3, updatedAt: 1_700_000_500_000 }),
      makePayload({ fields: { title: 'A bug', status: 'in-progress', priority: 'high' } }),
    );
    const second = await readUpdated('bug-1');

    expect(new Date(second).getTime()).toBeGreaterThan(new Date(first).getTime());
  });

  it('rollbackOptimistic restores the snapshot timestamp instead of stamping rollback time', async () => {
    const originalUpdatedAt = '2023-11-14T22:13:20.000Z';
    await store.applyRemoteItem(
      makeEnvelope({ updatedAt: new Date(originalUpdatedAt).getTime() }),
      makePayload({
        fields: { title: 'Before rejection', status: 'to-do', priority: 'high' },
        system: { updatedAt: originalUpdatedAt } as any,
      }),
    );
    const original = await readUpdated('bug-1');

    const snapshot = await store.applyOptimistic(
      'bug-1',
      makePayload({
        fields: { title: 'Rejected edit', status: 'in-progress', priority: 'high' },
        system: { updatedAt: '2023-11-14T23:13:20.000Z' } as any,
      }),
    );
    const optimistic = await readUpdated('bug-1');
    expect(optimistic).not.toBe(original);

    await store.rollbackOptimistic('bug-1', snapshot);
    const restored = await readUpdated('bug-1');

    expect(restored).toBe(original);
    expect(new Date(restored).getTime()).toBe(new Date(originalUpdatedAt).getTime());
  });
});
