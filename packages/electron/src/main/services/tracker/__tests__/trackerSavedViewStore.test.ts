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
  applyRemoteSharedSavedView,
  getMaxSharedSavedViewSyncId,
  listSharedSavedViews,
  listUnsyncedSharedSavedViews,
  removeSharedSavedView,
  upsertSharedSavedView,
} from '../trackerSavedViewStore';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', '..', 'database', 'sqlite', 'schemas');
const WS = '/ws/saved-views';

const view = (name: string): string => JSON.stringify({
  name,
  definition: { selectedType: 'bug', viewMode: 'grid' },
});

describe('trackerSavedViewStore', () => {
  let tmp: string;
  let db: SQLiteDatabase;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-tracker-saved-views-'));
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

  it('stores shared views in a workspace-scoped pending outbox', async () => {
    await upsertSharedSavedView(WS, { viewId: 'v1', payload: view('Sprint 7') }, db);
    await upsertSharedSavedView('/ws/other', { viewId: 'v2', payload: view('Other') }, db);

    const listed = await listSharedSavedViews(WS, db);
    expect(listed.map(v => v.viewId)).toEqual(['v1']);

    const pending = await listUnsyncedSharedSavedViews(WS, db);
    expect(pending).toEqual([{ viewId: 'v1', payload: view('Sprint 7'), deleted: false }]);
  });

  it('round-trips the payload byte-for-byte', async () => {
    const payload = view('Sprint 7 -- open bugs');
    await upsertSharedSavedView(WS, { viewId: 'v1', payload }, db);
    const [stored] = await listSharedSavedViews(WS, db);
    expect(stored.payload).toBe(payload);
  });

  it('rejects a payload that is not a JSON object', async () => {
    await expect(upsertSharedSavedView(WS, { viewId: 'v1', payload: 'not json' }, db)).rejects.toThrow();
    await expect(upsertSharedSavedView(WS, { viewId: 'v1', payload: '[1,2]' }, db)).rejects.toThrow();
  });

  it('tombstones an unshared view instead of dropping the row', async () => {
    await upsertSharedSavedView(WS, { viewId: 'v1', payload: view('Temp') }, db);
    await removeSharedSavedView(WS, 'v1', db);

    expect(await listSharedSavedViews(WS, db)).toEqual([]);
    // The tombstone must still be pushed so peers learn the view was unshared.
    expect(await listUnsyncedSharedSavedViews(WS, db)).toEqual([
      { viewId: 'v1', payload: null, deleted: true },
    ]);
  });

  it('applies a remote view and clears it from the outbox', async () => {
    const result = await applyRemoteSharedSavedView(WS, { viewId: 'v1', payload: view('Remote'), syncId: 5 }, db);
    expect(result).toMatchObject({ applied: true, deleted: false });

    expect(await listSharedSavedViews(WS, db)).toHaveLength(1);
    expect(await listUnsyncedSharedSavedViews(WS, db)).toEqual([]);
    expect(await getMaxSharedSavedViewSyncId(WS, db)).toBe(5);
  });

  it('applies a remote tombstone', async () => {
    await applyRemoteSharedSavedView(WS, { viewId: 'v1', payload: view('Remote'), syncId: 5 }, db);
    const result = await applyRemoteSharedSavedView(WS, { viewId: 'v1', payload: null, syncId: 6 }, db);

    expect(result).toMatchObject({ applied: true, deleted: true, view: null });
    expect(await listSharedSavedViews(WS, db)).toEqual([]);
  });

  it('ignores a replayed older syncId rather than clobbering newer state', async () => {
    await applyRemoteSharedSavedView(WS, { viewId: 'v1', payload: view('Newer'), syncId: 10 }, db);
    const stale = await applyRemoteSharedSavedView(WS, { viewId: 'v1', payload: view('Older'), syncId: 4 }, db);

    expect(stale).toEqual({ applied: false, reason: 'stale' });
    const [stored] = await listSharedSavedViews(WS, db);
    expect(JSON.parse(stored.payload).name).toBe('Newer');
  });

  it('rejects a malformed remote payload', async () => {
    const result = await applyRemoteSharedSavedView(WS, { viewId: 'v1', payload: 'nope', syncId: 1 }, db);
    expect(result).toEqual({ applied: false, reason: 'invalid' });
  });

  it('reports a zero cursor before anything has synced', async () => {
    expect(await getMaxSharedSavedViewSyncId(WS, db)).toBe(0);
    await upsertSharedSavedView(WS, { viewId: 'v1', payload: view('Local only') }, db);
    // A locally-pending view has no server syncId yet.
    expect(await getMaxSharedSavedViewSyncId(WS, db)).toBe(0);
  });
});
