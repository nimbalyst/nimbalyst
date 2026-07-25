import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createSQLiteStoreAdapter } from '../../database/sqlite/SQLiteStoreAdapter';
import {
  createTrackerPersonalStateStore,
  type TrackerPersonalStateStore,
} from '../TrackerPersonalStateStore';

type CloseableDb = { query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>; close?: () => Promise<void> | void };

const sqliteSchema = `
  CREATE TABLE tracker_personal_state (
    user_email TEXT NOT NULL,
    scope TEXT NOT NULL,
    item_id TEXT NOT NULL,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    favorite_updated_at INTEGER NOT NULL DEFAULT 0,
    last_opened_at INTEGER,
    snoozed_until INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_email, scope, item_id)
  )`;

const pgSchema = sqliteSchema
  .replace('is_favorite INTEGER', 'is_favorite BOOLEAN')
  .replace('DEFAULT 0', 'DEFAULT FALSE')
  .replace(/ INTEGER/g, ' BIGINT');

describe.each(['sqlite', 'pglite'] as const)('TrackerPersonalStateStore (%s)', (backend) => {
  let db: CloseableDb | null = null;
  let sqlite: SQLiteDatabase | null = null;
  let tmpDir: string | null = null;
  let store: TrackerPersonalStateStore;

  afterEach(async () => {
    await db?.close?.();
    await sqlite?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    db = null;
    sqlite = null;
    tmpDir = null;
  });

  async function setup(): Promise<void> {
    if (backend === 'sqlite') {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-personal-state-'));
      sqlite = new SQLiteDatabase({
        dbDir: tmpDir,
        schemaDir: path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas'),
        slowQueryThresholdMs: 1000,
        sampleRate: 0,
      });
      await sqlite.initialize();
      db = createSQLiteStoreAdapter(sqlite) as unknown as CloseableDb;
    } else {
      const pglite = new PGlite();
      await pglite.exec(pgSchema);
      db = pglite as unknown as CloseableDb;
    }
    store = createTrackerPersonalStateStore(db);
  }

  it('isolates rows by identity and scope', async () => {
    await setup();
    await store.setFavorite({ userEmail: 'me@example.com', scope: '/a', itemId: 'x', isFavorite: true, favoriteUpdatedAt: 10 });
    await store.setFavorite({ userEmail: 'other@example.com', scope: '/a', itemId: 'x', isFavorite: true, favoriteUpdatedAt: 11 });
    await store.setFavorite({ userEmail: 'me@example.com', scope: '/b', itemId: 'x', isFavorite: true, favoriteUpdatedAt: 12 });

    expect(await store.getForScope('me@example.com', '/a')).toHaveLength(1);
    expect((await store.getForScope('me@example.com', '/a'))[0]).toMatchObject({ itemId: 'x', isFavorite: true });
  });

  it('keeps an unstar tombstone and rejects a stale favorite update', async () => {
    await setup();
    await store.setFavorite({ userEmail: 'me@example.com', scope: '/a', itemId: 'x', isFavorite: true, favoriteUpdatedAt: 10 });
    await store.setFavorite({ userEmail: 'me@example.com', scope: '/a', itemId: 'x', isFavorite: false, favoriteUpdatedAt: 20 });
    const stale = await store.setFavorite({ userEmail: 'me@example.com', scope: '/a', itemId: 'x', isFavorite: true, favoriteUpdatedAt: 15 });

    expect(stale).toBeNull();
    expect((await store.getForScope('me@example.com', '/a'))[0]).toMatchObject({
      isFavorite: false,
      favoriteUpdatedAt: 20,
    });
  });

  it('advances last-opened independently and never regresses it', async () => {
    await setup();
    await store.setFavorite({ userEmail: 'me@example.com', scope: '/a', itemId: 'x', isFavorite: true, favoriteUpdatedAt: 50 });
    await store.recordOpened({ userEmail: 'me@example.com', scope: '/a', itemId: 'x', lastOpenedAt: 100 });
    const stale = await store.recordOpened({ userEmail: 'me@example.com', scope: '/a', itemId: 'x', lastOpenedAt: 90 });
    const advanced = await store.recordOpened({ userEmail: 'me@example.com', scope: '/a', itemId: 'x', lastOpenedAt: 200 });

    expect(stale).toBeNull();
    expect(advanced).toMatchObject({ isFavorite: true, favoriteUpdatedAt: 50, lastOpenedAt: 200 });
  });

  it('snoozes and un-snoozes an item without disturbing its favorite state', async () => {
    await setup();
    await store.setFavorite({ userEmail: 'me@example.com', scope: '/a', itemId: 'x', isFavorite: true, favoriteUpdatedAt: 50 });
    const snoozed = await store.setSnooze({
      userEmail: 'me@example.com', scope: '/a', itemId: 'x', snoozedUntil: 5_000, updatedAt: 100,
    });
    expect(snoozed).toMatchObject({ snoozedUntil: 5_000, isFavorite: true });

    const cleared = await store.setSnooze({
      userEmail: 'me@example.com', scope: '/a', itemId: 'x', snoozedUntil: null, updatedAt: 200,
    });
    expect(cleared).toMatchObject({ snoozedUntil: null, isFavorite: true });
  });

  it('ignores a snooze write that lost the race', async () => {
    await setup();
    await store.setSnooze({
      userEmail: 'me@example.com', scope: '/a', itemId: 'x', snoozedUntil: null, updatedAt: 200,
    });
    const stale = await store.setSnooze({
      userEmail: 'me@example.com', scope: '/a', itemId: 'x', snoozedUntil: 9_000, updatedAt: 100,
    });

    expect(stale).toBeNull();
    expect((await store.getForScope('me@example.com', '/a'))[0]).toMatchObject({ snoozedUntil: null });
  });

  it('snoozes an item it has never seen before', async () => {
    await setup();
    const row = await store.setSnooze({
      userEmail: 'me@example.com', scope: '/a', itemId: 'fresh', snoozedUntil: 7_000, updatedAt: 10,
    });
    expect(row).toMatchObject({ itemId: 'fresh', snoozedUntil: 7_000, isFavorite: false });
  });
});
