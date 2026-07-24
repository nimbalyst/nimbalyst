import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'test'),
    getVersion: vi.fn(() => '1'),
    on: vi.fn(),
  },
}));

import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import {
  applyRemoteTrackerNavigationEntry,
  getMaxTrackerNavigationSyncId,
  listTrackerNavigationEntries,
  listUnsyncedTrackerNavigationEntries,
  removeTrackerNavigationEntry,
  upsertTrackerNavigationEntry,
} from '../trackerNavigationStore';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', '..', 'database', 'sqlite', 'schemas');
const WS = '/ws/navigation';

describe('trackerNavigationStore', () => {
  let tmp: string;
  let db: SQLiteDatabase;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-tracker-navigation-'));
    db = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'),
      schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await db.initialize();
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('persists folders and placements in a workspace-scoped pending outbox', async () => {
    await upsertTrackerNavigationEntry(WS, {
      entryId: 'folder:delivery', kind: 'folder', folderId: 'delivery', name: 'Delivery', sortKey: 'a0',
    }, db);
    await upsertTrackerNavigationEntry(WS, {
      entryId: 'type:task', kind: 'type-placement', trackerType: 'task', folderId: 'delivery', sortKey: 'a0',
    }, db);
    await upsertTrackerNavigationEntry('/ws/other', {
      entryId: 'folder:other', kind: 'folder', folderId: 'other', name: 'Other', sortKey: 'a0',
    }, db);

    expect((await listTrackerNavigationEntries(WS, db)).map((entry) => entry.entryId).sort()).toEqual([
      'folder:delivery', 'type:task',
    ]);
    const pending = await listUnsyncedTrackerNavigationEntries(WS, db);
    expect(pending).toHaveLength(2);
    expect(pending.every((entry) => entry.deleted === false && entry.payload !== null)).toBe(true);
  });

  it('applies newer remote versions, ignores stale versions, and retains tombstones', async () => {
    const folder = JSON.stringify({
      entryId: 'folder:delivery', kind: 'folder', folderId: 'delivery', name: 'Delivery', sortKey: 'a0',
    });
    expect(await applyRemoteTrackerNavigationEntry(WS, {
      entryId: 'folder:delivery', payload: folder, syncId: 5,
    }, db)).toMatchObject({ applied: true, deleted: false });
    expect(await applyRemoteTrackerNavigationEntry(WS, {
      entryId: 'folder:delivery', payload: folder.replace('Delivery', 'Old'), syncId: 3,
    }, db)).toEqual({ applied: false, reason: 'stale' });
    expect(await getMaxTrackerNavigationSyncId(WS, db)).toBe(5);

    expect(await applyRemoteTrackerNavigationEntry(WS, {
      entryId: 'folder:delivery', payload: null, syncId: 6,
    }, db)).toMatchObject({ applied: true, deleted: true });
    expect(await listTrackerNavigationEntries(WS, db)).toEqual([]);
    expect(await getMaxTrackerNavigationSyncId(WS, db)).toBe(6);
  });

  it('soft-deletes local entries without losing the outbox tombstone', async () => {
    await upsertTrackerNavigationEntry(WS, {
      entryId: 'folder:delivery', kind: 'folder', folderId: 'delivery', name: 'Delivery', sortKey: 'a0',
    }, db);
    await removeTrackerNavigationEntry(WS, 'folder:delivery', db);
    expect(await listTrackerNavigationEntries(WS, db)).toEqual([]);
    expect(await listUnsyncedTrackerNavigationEntries(WS, db)).toEqual([
      { entryId: 'folder:delivery', payload: null, deleted: true },
    ]);
  });
});
