// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
vi.mock('electron', async () => ({ app: (await import('../../../../test-stubs/privateUserData')).testApp }));
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createPGLiteSessionStore } from '../PGLiteSessionStore';
import { withHierarchyWrite } from '../sessionHierarchy';
import { migrateSessionTrees } from '../sessionTreeMigration';
import { createSyncedSessionStore } from '../../../../../runtime/src/sync/SyncedSessionStore';
let root: string;
let db: SQLiteDatabase;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-hierarchy-sync-'));
  db = new SQLiteDatabase({ dbDir: root, schemaDir: path.resolve(__dirname, '../../database/sqlite/schemas'), sampleRate: 0 });
  await db.initialize();
});
afterEach(async () => { await db.close(); fs.rmSync(root, { recursive: true, force: true }); });

it('checks remote freshness after waiting for the hierarchy write lane', async () => {
  const store = createPGLiteSessionStore(db);
  for (const id of ['child', 'target']) await store.create({ id, provider: 'claude-code', workspaceId: '/p' });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const blocker = withHierarchyWrite(() => blocked);
  let current = true;
  const move = store.updateMetadata('child', { parentSessionId: 'target', hierarchySync: { source: 'remote', isCurrent: () => current } });
  current = false; release(); await blocker;
  await expect(move).rejects.toThrow(/superseded/i);
  expect((await store.get('child'))?.parentSessionId).toBeNull();
});

it('persists local intent with the move across store recreation and clears only the matching echo', async () => {
  const store = createPGLiteSessionStore(db);
  for (const id of ['child', 'target']) await store.create({ id, provider: 'claude-code', workspaceId: '/p' });
  await store.updateMetadata('child', { parentSessionId: 'target' });
  const reopened = createPGLiteSessionStore(db);
  const [intent] = await reopened.listPendingHierarchyIntents!();
  expect(intent).toMatchObject({ sessionId: 'child', parentSessionId: 'target', createdBySessionId: 'target', revision: expect.any(String) });
  expect(await reopened.acknowledgeHierarchyIntent!('child', 'wrong', 'target', 'target')).toBe(false);
  expect(await reopened.acknowledgeHierarchyIntent!('child', intent.revision, null, null)).toBe(false);
  expect(await reopened.acknowledgeHierarchyIntent!('child', intent.revision, 'target', 'target')).toBe(true);
  expect(await reopened.listPendingHierarchyIntents!()).toEqual([]);
});

it('applies a final graph reversal atomically and protects an offline local intent from stale bootstrap', async () => {
  const store = createPGLiteSessionStore(db);
  await store.create({ id: 'A', provider: 'claude-code', workspaceId: '/p' });
  await store.create({ id: 'B', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'A', createdBySessionId: 'A' });
  await store.create({ id: 'target', provider: 'claude-code', workspaceId: '/p' });
  const results = await store.applyRemoteHierarchySnapshot!([
    { sessionId: 'A', parentSessionId: 'B', createdBySessionId: 'B' },
    { sessionId: 'B', parentSessionId: null, createdBySessionId: null },
  ], () => true);
  expect(results.every(row => row.accepted)).toBe(true);
  expect((await store.get('A'))?.parentSessionId).toBe('B');
  expect((await store.get('B'))?.parentSessionId).toBeNull();
  expect(await store.listPendingHierarchyIntents!()).toEqual([]);
  await store.updateMetadata('A', { parentSessionId: 'target' });
  const stale = await store.applyRemoteHierarchySnapshot!([{ sessionId: 'A', parentSessionId: 'B', createdBySessionId: 'B' }], () => true);
  expect(stale[0]).toMatchObject({ accepted: false, parentSessionId: 'target', createdBySessionId: 'target' });
  expect(await store.listPendingHierarchyIntents!()).toHaveLength(1);
  await store.applyRemoteHierarchySnapshot!([{ sessionId: 'A', parentSessionId: 'target', createdBySessionId: 'target' }], () => true);
  expect(await store.listPendingHierarchyIntents!()).toEqual([]);
});

it('rechecks remote freshness after base-store metadata awaits immediately before SQL', async () => {
  let current = true;
  let armed = false;
  const intercepted = { query: async <T = any>(sql: string, params?: any[]) => {
    const result = await db.query<T>(sql, params);
    if (armed && sql.includes('SELECT metadata FROM ai_sessions')) current = false;
    return result;
  }, runTransaction: db.runTransaction.bind(db) };
  const store = createPGLiteSessionStore(intercepted);
  for (const id of ['child', 'target']) await store.create({ id, provider: 'claude-code', workspaceId: '/p' });
  armed = true;
  await expect(store.updateMetadata('child', { parentSessionId: 'target', hierarchySync: { source: 'remote', isCurrent: () => current } })).rejects.toThrow(/superseded/i);
  expect((await store.get('child'))?.parentSessionId).toBeNull();
});

it('rolls back a remote final-graph transaction completely when a later row fails', async () => {
  const store = createPGLiteSessionStore(db);
  await store.create({ id: 'A', provider: 'claude-code', workspaceId: '/p' });
  await store.create({ id: 'B', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'A' });
  await db.exec("CREATE TRIGGER refuse_remote BEFORE UPDATE ON ai_sessions WHEN OLD.id = 'B' BEGIN SELECT RAISE(ABORT, 'refused remote'); END");
  await expect(store.applyRemoteHierarchySnapshot!([{ sessionId: 'A', parentSessionId: 'B' }, { sessionId: 'B', parentSessionId: null }], () => true)).rejects.toThrow('refused remote');
  expect((await store.get('A'))?.parentSessionId).toBeNull();
  expect((await store.get('B'))?.parentSessionId).toBe('A');
  expect(await store.listPendingHierarchyIntents!()).toEqual([]);
});


it('requires an explicit manager field before confirming a detached local intent', async () => {
  const store = createPGLiteSessionStore(db);
  await store.create({ id: 'parent', provider: 'claude-code', workspaceId: '/p' });
  await store.create({ id: 'child', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'parent', createdBySessionId: 'parent' });
  await store.updateMetadata('child', { parentSessionId: null });
  await store.applyRemoteHierarchySnapshot!([{ sessionId: 'child', parentSessionId: null }], () => true);
  expect(await store.listPendingHierarchyIntents!()).toHaveLength(1);
  await store.applyRemoteHierarchySnapshot!([{ sessionId: 'child', parentSessionId: null, createdBySessionId: null }], () => true);
  expect(await store.listPendingHierarchyIntents!()).toEqual([]);
});

it('persists migration and delete-lift/manager-clear intents across database reopen', async () => {
  let store = createPGLiteSessionStore(db);
  await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p' });
  await store.create({ id: 'flat', provider: 'claude-code', workspaceId: '/p', createdBySessionId: 'root' });
  await store.create({ id: 'direct', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'root', createdBySessionId: 'root' });
  await store.create({ id: 'isolated', provider: 'claude-code', workspaceId: '/p', createdBySessionId: 'root', metadata: { isolated: true } });
  await migrateSessionTrees(db);
  await db.close(); await db.initialize(); store = createPGLiteSessionStore(db);
  expect(await store.listPendingHierarchyIntents!()).toEqual([expect.objectContaining({ sessionId: 'flat', parentSessionId: 'root', createdBySessionId: 'root' })]);
  await store.delete('root');
  await db.close(); await db.initialize(); store = createPGLiteSessionStore(db);
  expect(await store.listPendingHierarchyIntents!()).toEqual(expect.arrayContaining(['flat', 'direct', 'isolated'].map(sessionId => expect.objectContaining({ sessionId, parentSessionId: null, createdBySessionId: null }))));
  const rejected = await store.applyRemoteHierarchySnapshot!([{ sessionId: 'flat', parentSessionId: 'root', createdBySessionId: 'root' }], () => true);
  expect(rejected[0]).toMatchObject({ accepted: false, parentSessionId: null, createdBySessionId: null });
});

it('exposes hierarchy methods through the production sync wrapper and suppresses remote echoes', async () => {
  const base = createPGLiteSessionStore(db);
  for (const id of ['child', 'target']) await base.create({ id, provider: 'claude-code', workspaceId: '/p' });
  const pushChange = vi.fn(async () => ({ published: true }));
  const store = createSyncedSessionStore(base, { pushChange } as any, { autoConnect: false });
  expect(store.applyRemoteHierarchySnapshot).toBeTypeOf('function');
  await store.updateMetadata('child', { parentSessionId: 'target', hierarchySync: { source: 'remote', isCurrent: () => true } });
  expect(pushChange).not.toHaveBeenCalled();
  await store.updateMetadata('child', { parentSessionId: null });
  expect(pushChange).toHaveBeenLastCalledWith('child', expect.objectContaining({ metadata: expect.objectContaining({ parentSessionId: null, createdBySessionId: null }) }), { isCurrent: expect.any(Function) });
  const [intent] = await store.listPendingHierarchyIntents!();
  expect(await store.acknowledgeHierarchyIntent!('child', intent.revision, null, null)).toBe(true);
  expect(await store.applyRemoteHierarchySnapshot!([{ sessionId: 'child', parentSessionId: 'target', createdBySessionId: 'target' }], () => true)).toEqual([expect.objectContaining({ accepted: true })]);
});


it('guards a delayed wrapper publication after a newer local hierarchy move', async () => {
  const base = createPGLiteSessionStore(db);
  for (const id of ['child', 'A', 'B']) await base.create({ id, provider: 'claude-code', workspaceId: '/p' });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const sent: unknown[] = [];
  const pushChange = vi.fn(async (_id, change, options) => {
    if (change.metadata.parentSessionId === 'A') await blocked;
    if (options?.isCurrent && !options.isCurrent()) return { published: false, retryable: false };
    sent.push(change.metadata.parentSessionId);
    return { published: true };
  });
  const store = createSyncedSessionStore(base, { pushChange } as any, { autoConnect: false });
  await store.updateMetadata('child', { parentSessionId: 'A' });
  await store.updateMetadata('child', { parentSessionId: 'B' });
  release();
  await pushChange.mock.results[0].value;
  expect(sent).toEqual(['B']);
});


it('invalidates delayed wrapper sends when a confirmed local intent is followed by a remote batch move', async () => {
  const base = createPGLiteSessionStore(db);
  for (const id of ['child', 'A', 'B']) await base.create({ id, provider: 'claude-code', workspaceId: '/p' });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const sent: unknown[] = [];
  const pushChange = vi.fn(async (_id, change, options) => {
    await blocked;
    if (options?.isCurrent && !options.isCurrent()) return { published: false, retryable: false };
    sent.push(change.metadata.parentSessionId);
    return { published: true };
  });
  const store = createSyncedSessionStore(base, { pushChange } as any, { autoConnect: false });
  await store.updateMetadata('child', { parentSessionId: 'A' });
  await store.applyRemoteHierarchySnapshot!([{ sessionId: 'child', parentSessionId: 'A', createdBySessionId: 'A' }], () => true);
  await store.applyRemoteHierarchySnapshot!([{ sessionId: 'child', parentSessionId: 'B', createdBySessionId: 'B' }], () => true);
  release(); await pushChange.mock.results[0].value;
  expect(sent).toEqual([]);
  expect((await store.get('child'))?.parentSessionId).toBe('B');
});
