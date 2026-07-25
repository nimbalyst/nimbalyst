import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const sent: Array<{ channel: string; payload: unknown }> = [];

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'test'),
    getVersion: vi.fn(() => '1'),
    on: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => [{
      webContents: {
        send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); },
      },
    }],
  },
}));

let currentDb: unknown = null;
vi.mock('../../database/initialize', () => ({
  getDatabase: () => currentDb,
}));

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { listSharedSavedViews } from '../tracker/trackerSavedViewStore';
import {
  applyRemoteWorkspaceSharedSavedView,
  registerTrackerSavedViewFlushHandler,
  shareWorkspaceTrackerView,
  unshareWorkspaceTrackerView,
} from '../TrackerSavedViewService';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas');
const WS = '/ws/saved-view-service';

const payload = (name: string): string => JSON.stringify({
  name,
  definition: { selectedType: 'bug', viewMode: 'grid' },
});

describe('TrackerSavedViewService', () => {
  let tmp: string;
  let db: SQLiteDatabase;
  let flushed: string[];

  beforeEach(async () => {
    sent.length = 0;
    flushed = [];
    registerTrackerSavedViewFlushHandler((workspacePath) => { flushed.push(workspacePath); });
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-saved-view-service-'));
    db = new SQLiteDatabase({
      dbDir: path.join(tmp, 'sqlite-db'),
      schemaDir: SCHEMA_DIR,
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await db.initialize();
    currentDb = db;
  });

  afterEach(async () => {
    currentDb = null;
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('shares a view, tells the renderer, and asks the engine to flush', async () => {
    const views = await shareWorkspaceTrackerView(WS, { viewId: 'v1', payload: payload('Sprint 7') });

    expect(views).toEqual([{ viewId: 'v1', payload: payload('Sprint 7') }]);
    expect(flushed).toEqual([WS]);
    expect(sent).toEqual([{ channel: 'tracker-saved-views:changed', payload: { workspacePath: WS } }]);
  });

  it('unshares a view so it disappears locally and tombstones for peers', async () => {
    await shareWorkspaceTrackerView(WS, { viewId: 'v1', payload: payload('Sprint 7') });
    const views = await unshareWorkspaceTrackerView(WS, 'v1');

    expect(views).toEqual([]);
    expect(flushed).toEqual([WS, WS]);
  });

  it('notifies the renderer when a peer view arrives, but not on a stale replay', async () => {
    const first = await applyRemoteWorkspaceSharedSavedView(WS, {
      viewId: 'peer',
      payload: payload('Their view'),
      syncId: 5,
    });
    expect(first).toMatchObject({ applied: true, deleted: false });
    expect(sent).toHaveLength(1);
    expect(await listSharedSavedViews(WS, db)).toEqual([
      { viewId: 'peer', payload: payload('Their view') },
    ]);

    const replay = await applyRemoteWorkspaceSharedSavedView(WS, {
      viewId: 'peer',
      payload: payload('Older name'),
      syncId: 4,
    });
    expect(replay).toEqual({ applied: false, reason: 'stale' });
    expect(sent).toHaveLength(1);
  });

  it('does not push a remotely-applied view back onto the wire', async () => {
    await applyRemoteWorkspaceSharedSavedView(WS, {
      viewId: 'peer',
      payload: payload('Their view'),
      syncId: 5,
    });
    // A remote apply is already synced; flushing it would echo the peer's own
    // write back at the room.
    expect(flushed).toEqual([]);
  });
});
