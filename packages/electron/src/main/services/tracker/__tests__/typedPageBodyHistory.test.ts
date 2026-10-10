// @vitest-environment node
/**
 * A Personal typed page's body lives only in this database, and an agent edit
 * replaces it with no review step, so every body write keeps a local history
 * snapshot. Team bodies are not snapshotted here: their history is the room's.
 *
 * Runs against a real SQLite database and a real HistoryManager, across a
 * relaunch: the history has to be there when the user comes back for it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../../utils/store', () => ({
  getWorkspaceRoots: (workspacePath: string) => [workspacePath],
  getAppSetting: vi.fn(() => undefined),
}));
const db = { current: null as any };
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({
  database: {
    isInitialized: () => db.current !== null,
    initialize: async () => {},
    getEngine: () => 'sqlite',
    query: (sql: string, params?: unknown[]) => db.current.query(sql, params),
  },
}));
vi.mock('@nimbalyst/tracker-schema', () => ({
  globalRegistry: { get: (type: string) => ({ module: { sharing: 'personal' }, decision: { sharing: 'team' } } as Record<string, unknown>)[type] },
}));

import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { HistoryManager } from '../../../HistoryManager';
import { recordTypedPageBodySnapshot } from '../typedPageBodyHistory';

const SCHEMA_DIR = path.resolve(__dirname, '../../../database/sqlite/schemas');
const KEY = 'personal-doc://tracker-content/item-1';

describe('recordTypedPageBodySnapshot', () => {
  let tmp: string;

  const launch = async () => {
    const sqlite = new SQLiteDatabase({ dbDir: path.join(tmp, 'sqlite-db'), schemaDir: SCHEMA_DIR, log: () => {} });
    await sqlite.initialize();
    db.current = sqlite;
    return sqlite;
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-typed-page-history-'));
  });
  afterEach(async () => {
    await db.current?.close();
    db.current = null;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps a Personal typed page body in local history across a relaunch, and no team body', async () => {
    let sqlite = await launch();
    const history = new HistoryManager();
    expect(await recordTypedPageBodySnapshot('item-1', 'module', '# Mine', { history })).toBe(true);
    expect(await recordTypedPageBodySnapshot('item-1', 'module', { markdown: '# Agent rewrite' }, { history })).toBe(true);
    expect(await recordTypedPageBodySnapshot('item-2', 'decision', '# Team body', { history })).toBe(false);
    await sqlite.close();

    sqlite = await launch();
    const relaunched = new HistoryManager();
    const snapshots = await relaunched.listSnapshots(KEY);
    const bodies = await Promise.all(snapshots.map((snapshot) => relaunched.loadSnapshot(KEY, snapshot.timestamp)));
    expect(bodies.sort()).toEqual(['# Agent rewrite', '# Mine']);
    expect(await relaunched.listSnapshots('personal-doc://tracker-content/item-2')).toEqual([]);
  });

  it('keeps the body an agent replaced when that text was never snapshotted', async () => {
    await launch();
    const history = new HistoryManager();
    // An MCP write stores `content` as JSON-encoded markdown; SQLite hands it back still encoded.
    await recordTypedPageBodySnapshot('item-1', 'module', '# Agent body', { history, replaced: JSON.stringify('# Hand-written body') });

    const snapshots = await history.listSnapshots(KEY);
    const byDescription = Object.fromEntries(await Promise.all(snapshots.map(async (snapshot) =>
      [snapshot.metadata?.description, await history.loadSnapshot(KEY, snapshot.timestamp)])));
    expect(byDescription).toEqual({ 'Before agent edit': '# Hand-written body', 'Auto-save': '# Agent body' });
  });

  it('never fails the body write it follows', async () => {
    const failing = { createSnapshot: vi.fn(async () => { throw new Error('disk full'); }) };
    await expect(recordTypedPageBodySnapshot('item-1', 'module', '# Body', { history: failing })).resolves.toBe(false);
  });
});
