/**
 * ReadReceiptsStore against a real in-memory better-sqlite3 backend.
 *
 * Exercises the actual `read_receipts` migration SQL + the store's
 * `$N`-placeholder / ON CONFLICT upsert path on the SQLite dialect, including
 * the advance-only merge and the BIGINT/INTEGER round-trip.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createReadReceiptsStore, type ReadReceiptsStore } from '../ReadReceiptsStore';

const ME = 'me@example.com';

describe('ReadReceiptsStore (SQLite)', () => {
  let tmpDir: string;
  let sqlite: SQLiteDatabase;
  let store: ReadReceiptsStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-rr-'));
    const schemaDir = path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas');
    sqlite = new SQLiteDatabase({
      dbDir: tmpDir,
      schemaDir,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await sqlite.initialize();
    store = createReadReceiptsStore(sqlite as unknown as { query: SQLiteDatabase['query'] });
  });

  afterEach(async () => {
    await sqlite.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('created the read_receipts table via migration 0016', () => {
    const handle = sqlite.getRawHandle()!;
    const cols = handle.prepare(`PRAGMA table_info(read_receipts)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'user_email',
        'entity_kind',
        'entity_id',
        'scope',
        'last_viewed_at',
        'last_seen_version',
        'updated_at',
      ]),
    );
  });

  it('marks viewed then reads it back for the scope', async () => {
    const row = await store.markViewed({
      userEmail: ME,
      entityKind: 'tracker',
      entityId: 'item-1',
      scope: '/ws',
      lastViewedAt: 1000,
      lastSeenVersion: 5,
    });
    expect(row).not.toBeNull();
    expect(row!.lastSeenVersion).toBe(5);

    const scoped = await store.getForScope(ME, 'tracker', '/ws');
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatchObject({
      entityId: 'item-1',
      lastViewedAt: 1000,
      lastSeenVersion: 5,
    });
  });

  it('advances forward and never regresses on a stale mark', async () => {
    await store.markViewed({
      userEmail: ME,
      entityKind: 'tracker',
      entityId: 'item-1',
      scope: '/ws',
      lastViewedAt: 1000,
      lastSeenVersion: 5,
    });

    // Forward advance.
    const advanced = await store.markViewed({
      userEmail: ME,
      entityKind: 'tracker',
      entityId: 'item-1',
      scope: '/ws',
      lastViewedAt: 2000,
      lastSeenVersion: 8,
    });
    expect(advanced!.lastSeenVersion).toBe(8);

    // Stale mark — no-op (returns null), existing row unchanged.
    const stale = await store.markViewed({
      userEmail: ME,
      entityKind: 'tracker',
      entityId: 'item-1',
      scope: '/ws',
      lastViewedAt: 1500,
      lastSeenVersion: 6,
    });
    expect(stale).toBeNull();

    const scoped = await store.getForScope(ME, 'tracker', '/ws');
    expect(scoped[0].lastSeenVersion).toBe(8);
    expect(scoped[0].lastViewedAt).toBe(2000);
  });

  it('keeps receipts isolated by user, kind and scope', async () => {
    await store.markViewed({
      userEmail: ME,
      entityKind: 'tracker',
      entityId: 'item-1',
      scope: '/ws',
      lastViewedAt: 1000,
      lastSeenVersion: 1,
    });
    await store.markViewed({
      userEmail: 'other@example.com',
      entityKind: 'tracker',
      entityId: 'item-1',
      scope: '/ws',
      lastViewedAt: 1000,
      lastSeenVersion: 1,
    });
    await store.markViewed({
      userEmail: ME,
      entityKind: 'doc',
      entityId: 'doc-1',
      scope: 'org-1',
      lastViewedAt: 1000,
      lastSeenVersion: null,
    });

    expect(await store.getForScope(ME, 'tracker', '/ws')).toHaveLength(1);
    expect(await store.getForScope(ME, 'doc', 'org-1')).toHaveLength(1);
    const docRow = (await store.getForScope(ME, 'doc', 'org-1'))[0];
    expect(docRow.lastSeenVersion).toBeNull();
  });
});
