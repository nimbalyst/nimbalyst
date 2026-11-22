// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';

vi.mock('../../../utils/logger', () => ({ logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } }));

import {
  runTrackerBodyCacheRetention,
  writeTrackerBodyCacheVersion,
  type TrackerBodyCacheDb,
} from '../trackerBodyCacheRetention';

function makeDb(): SqliteDatabase {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tracker_items (id TEXT PRIMARY KEY, body_version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE tracker_body_cache (
      item_id TEXT NOT NULL,
      body_version INTEGER NOT NULL,
      content TEXT NOT NULL,
      cached_at TEXT,
      PRIMARY KEY (item_id, body_version)
    );
  `);
  return db;
}

/** The proxy's `$N` dialect over positional `?`; every statement binds in order. */
function adapter(db: SqliteDatabase): TrackerBodyCacheDb {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const stmt = db.prepare(sql.replace(/\$\d+/g, '?').replace(/\bNOW\(\)/g, "datetime('now')"));
      if (stmt.reader) return { rows: stmt.all(...params) as T[] };
      stmt.run(...params);
      return { rows: [] as T[] };
    },
  };
}

function versions(db: SqliteDatabase, itemId: string): number[] {
  return (db.prepare('SELECT body_version FROM tracker_body_cache WHERE item_id = ? ORDER BY body_version').all(itemId) as { body_version: number }[])
    .map((row) => row.body_version);
}

function seed(db: SqliteDatabase, itemId: string, versionList: number[], current: number | null): void {
  if (current !== null) db.prepare('INSERT INTO tracker_items (id, body_version) VALUES (?, ?)').run(itemId, current);
  const insert = db.prepare('INSERT INTO tracker_body_cache (item_id, body_version, content) VALUES (?, ?, ?)');
  for (const v of versionList) insert.run(itemId, v, JSON.stringify(`body ${v}`));
}

describe('tracker body cache retention', () => {
  it('a save leaves version 1 and the new version, and keeps the new body', async () => {
    const db = makeDb();
    const q = adapter(db);
    for (let v = 1; v <= 5; v += 1) await writeTrackerBodyCacheVersion(q, 'a', v, JSON.stringify(`body ${v}`));
    expect(versions(db, 'a')).toEqual([1, 5]);
    expect(db.prepare('SELECT content FROM tracker_body_cache WHERE item_id = ? AND body_version = 5').get('a'))
      .toEqual({ content: JSON.stringify('body 5') });
  });

  it('the background pass keeps version 1, the newest and the current version, and a second run deletes nothing', async () => {
    const db = makeDb();
    seed(db, 'a', [1, 2, 3, 4, 5], 5);
    seed(db, 'b', [2, 3, 7], 3); // current version is not the newest cached row
    seed(db, 'c', [1], 1);
    seed(db, 'orphan', [4, 9], null);
    const q = adapter(db);
    const sleep = vi.fn(async () => undefined);

    // Chunks of 2 items exercise the cursor across chunk boundaries.
    const first = await runTrackerBodyCacheRetention(q, { itemsPerChunk: 2, sleep });

    expect(versions(db, 'a')).toEqual([1, 5]);
    expect(versions(db, 'b')).toEqual([3, 7]);
    expect(versions(db, 'c')).toEqual([1]);
    expect(versions(db, 'orphan')).toEqual([9]);
    expect(first).toEqual({ itemsPruned: 3, rowsDeleted: 5 });
    expect(sleep).toHaveBeenCalled();

    const second = await runTrackerBodyCacheRetention(q, { itemsPerChunk: 2, sleep });
    expect(second).toEqual({ itemsPruned: 0, rowsDeleted: 0 });
    expect(versions(db, 'a')).toEqual([1, 5]);
  });
});
