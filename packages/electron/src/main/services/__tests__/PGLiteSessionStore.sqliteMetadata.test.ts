// @vitest-environment node
/**
 * updateMetadata's in-SQL merge against a real better-sqlite3 backend, where
 * `metadata || $n` is translated to json_patch. The fake-db tests cannot show
 * that the translated statement actually runs and merges.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

vi.mock('../ai/sessionHostAttribution', () => ({ getLocalHostDeviceId: () => 'desktop' }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: vi.fn(), getStore: vi.fn(), updateMetadata: vi.fn() } }));
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createPGLiteSessionStore } from '../PGLiteSessionStore';
import { OWNER_METADATA_MERGE_SQL } from '../extensionSessions/sessionOwnership';
import { migrateSessionTrees } from '../sessionTreeMigration';
import { readSessionSubtree, findSessionTreeRoot, onHierarchyMove } from '../sessionHierarchy';
import { applyMobileSessionParent } from '../ai/mobileSessionHierarchy';

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { registerMobileHierarchyAuthority } from '../ai/mobileHierarchySync';
import { registerSessionHierarchyPublication } from '../sync/sessionHierarchyPublication';
import { getLocalHostDeviceId } from '../ai/sessionHostAttribution';

let tmpDir: string;
let sqlite: SQLiteDatabase;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-meta-'));
  sqlite = new SQLiteDatabase({
    dbDir: tmpDir,
    schemaDir: path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas'),
    slowQueryThresholdMs: 1000,
    sampleRate: 0,
  });
  await sqlite.initialize();
});

afterEach(async () => {
  await sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

it('merges overlapping metadata updates without losing either key', async () => {
  await sqlite.query(
    `INSERT INTO ai_sessions (id, provider, workspace_id, metadata) VALUES ('s1', 'claude-code', '/p', $1)`,
    [JSON.stringify({ tags: ['ai'] })],
  );
  const store = createPGLiteSessionStore(sqlite);
  await Promise.all([
    store.updateMetadata('s1', { metadata: { hasPendingPrompt: true } }),
    store.updateMetadata('s1', { metadata: { tokenUsage: { totalTokens: 5 } } }),
    store.updateMetadata('s1', { metadata: { phase: 'implementing' } }),
  ]);
  const { rows } = await sqlite.query<{ metadata: string }>(`SELECT metadata FROM ai_sessions WHERE id = 's1'`);
  const metadata = JSON.parse(rows[0].metadata);
  expect(metadata).toMatchObject({ tags: ['ai'], hasPendingPrompt: true, tokenUsage: { totalTokens: 5 }, phase: 'implementing' });
  expect(metadata.activity).toHaveLength(1);
});

it('archives every descendant and lifts children transactionally when deleting an interior session', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p' });
  await store.create({ id: 'child', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'root' });
  await store.create({ id: 'leaf', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'child' });
  await store.updateMetadata('root', { isArchived: true });
  expect((await store.get('leaf'))?.isArchived).toBeTruthy();
  await store.updateMetadata('root', { isArchived: false });
  expect((await store.get('leaf'))?.isArchived).toBeFalsy();
  await store.delete('child');
  expect((await store.get('leaf'))?.parentSessionId).toBe('root');
});

it('rolls back lifted children if deletion fails, and rejects stale undo snapshots', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p' });
  await store.create({ id: 'child', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'root' });
  await store.create({ id: 'leaf', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'child', createdBySessionId: 'child' });
  await sqlite.exec("CREATE TRIGGER refuse_delete BEFORE DELETE ON ai_sessions WHEN OLD.id = 'child' BEGIN SELECT RAISE(ABORT, 'blocked delete'); END");
  await expect(store.delete('child')).rejects.toThrow('blocked delete');
  expect((await store.get('leaf'))?.parentSessionId).toBe('child');
  expect((await store.get('leaf'))?.createdBySessionId).toBe('child');
  await store.updateMetadata('leaf', { parentSessionId: 'root' });
  await expect(store.updateMetadata('leaf', { parentSessionId: null, expectedParentSessionId: 'child' })).rejects.toThrow(/parent changed/i);
  expect((await store.get('leaf'))?.parentSessionId).toBe('root');
});

it('rejects cycles and moves whose whole subtree would exceed depth eight', async () => {
  const store = createPGLiteSessionStore(sqlite);
  for (let i = 0; i <= 8; i++) {
    await store.create({ id: `n${i}`, provider: 'claude-code', workspaceId: '/p', parentSessionId: i ? `n${i - 1}` : null });
  }
  await expect(store.updateMetadata('n0', { parentSessionId: 'n8' })).rejects.toThrow(/cycle/i);
  await store.create({ id: 'branch', provider: 'claude-code', workspaceId: '/p' });
  await store.create({ id: 'tip', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'branch' });
  await expect(store.updateMetadata('branch', { parentSessionId: 'n7' })).rejects.toThrow(/depth/i);
  expect((await store.get('branch'))?.parentSessionId).toBeNull();
});

it('migrates flat managed siblings ancestors first, keeps reversible metadata, and runs only once', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'wrapper', provider: 'claude-code', workspaceId: '/p', sessionType: 'workstream' });
  await store.create({ id: 'orchestrator', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'wrapper' });
  await store.create({ id: 'worker', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'wrapper', createdBySessionId: 'orchestrator' });
  await store.create({ id: 'nested', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'wrapper', createdBySessionId: 'worker' });
  expect((await migrateSessionTrees(sqlite)).moved).toBe(2);
  expect((await store.get('nested'))?.parentSessionId).toBe('worker');
  expect((await store.get('worker'))?.metadata).toMatchObject({ preTreeParentSessionId: 'wrapper' });
  expect((await migrateSessionTrees(sqlite)).moved).toBe(0);
  expect((await store.list('/p')).find(s => s.id === 'wrapper')).toMatchObject({ childCount: 1, descendantCount: 3 });
  expect((await readSessionSubtree(sqlite, 'wrapper', '/p')).map(row => [row.id, Number(row.depth)])).toEqual([
    ['wrapper', 0], ['orchestrator', 1], ['worker', 2], ['nested', 3],
  ]);
  expect(await findSessionTreeRoot(sqlite, 'nested', '/p')).toBe('wrapper');
});

it('applies a phone move through desktop invariants and republishes both accepted and rejected placement with its manager', async () => {
  const store = createPGLiteSessionStore(sqlite);
  for (const id of ['first', 'second']) await store.create({ id, provider: 'claude-code', workspaceId: '/p' });
  await store.create({ id: 'worker', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'first', createdBySessionId: 'first' });
  const publish = vi.fn(async () => {});
  const authority = { get: store.get.bind(store), updateMetadata: store.updateMetadata.bind(store), publish };
  expect(await applyMobileSessionParent(authority, 'worker', 'second')).toEqual({ accepted: true });
  expect(publish).toHaveBeenLastCalledWith('worker', { parentSessionId: 'second', createdBySessionId: 'second' });
  expect(await applyMobileSessionParent(authority, 'second', 'worker')).toMatchObject({ accepted: false });
  expect(publish).toHaveBeenLastCalledWith('second', { parentSessionId: null, createdBySessionId: null });
  expect((await store.get('worker'))?.metadata).toMatchObject({ originalSpawnerSessionId: 'first', managerReassignedByUser: true });
});

// Ownership is assigned by the host at creation and is immutable afterwards;
// only the owning extension (through extensionSessionsService) edits its bag.
it('keeps extension ownership out of reach of ordinary metadata writes and re-creates', async () => {
  const owned = { sessionOwner: { extensionId: 'com.example.owner', key: 'ada' }, ownerMetadata: { chapter: 1 } };
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 's2', provider: 'claude-code', workspaceId: '/p', metadata: owned });

  await store.updateMetadata('s2', {
    metadata: { sessionOwner: { extensionId: 'com.evil', key: 'x' }, ownerMetadata: { chapter: 99 }, phase: 'planning' },
  });
  // A renderer re-issuing sessions:create for an existing id must not wipe the owner.
  await store.create({ id: 's2', provider: 'claude-code', workspaceId: '/p', metadata: { phase: 'implementing' } });

  const { rows } = await sqlite.query<{ metadata: string }>(`SELECT metadata FROM ai_sessions WHERE id = 's2'`);
  expect(JSON.parse(rows[0].metadata)).toMatchObject({ ...owned, phase: 'implementing' });

  // The owner's own bag write (merged in SQL) runs on this backend.
  await sqlite.query(OWNER_METADATA_MERGE_SQL, [JSON.stringify({ ownerMetadata: { chapter: 2 } }), 's2']);
  const after = await sqlite.query<{ metadata: string }>(`SELECT metadata FROM ai_sessions WHERE id = 's2'`);
  expect(JSON.parse(after.rows[0].metadata)).toMatchObject({ sessionOwner: owned.sessionOwner, ownerMetadata: { chapter: 2 } });
});

it('routes phone snapshots through production authority and publishes canonical accepted and rejected rows', async () => {
  const store = createPGLiteSessionStore(sqlite);
  for (const id of ['root', 'other']) await store.create({ id, provider: 'claude-code', workspaceId: '/p' });
  await store.create({ id: 'child', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'root', createdBySessionId: 'root' });
  await sqlite.query("INSERT INTO worktrees (id, workspace_id, name, path, branch) VALUES ('wt', '/p', 'wt', '/p/wt', 'tree-test')");
  await store.create({ id: 'foreign', provider: 'claude-code', workspaceId: '/p', worktreeId: 'wt' });
  for (let depth = 0; depth <= 8; depth++) await store.create({ id: `deep-${depth}`, provider: 'claude-code', workspaceId: '/p', parentSessionId: depth ? `deep-${depth - 1}` : null });
  vi.mocked(AISessionsRepository.getStore).mockReturnValue(store);
  vi.mocked(AISessionsRepository.get).mockImplementation(id => store.get(id));
  vi.mocked(AISessionsRepository.updateMetadata).mockImplementation((id, patch) => store.updateMetadata(id, patch));
  const cache = new Map<string, any>();
  const listeners = new Set<(entries: any[], isCurrent: () => boolean) => void | Promise<void>>();
  const provider = {
    onHierarchySnapshot: (callback: any) => { listeners.add(callback); return () => listeners.delete(callback); },
    getCachedIndexEntry: (id: string) => cache.get(id),
    pushChange: vi.fn(async (id: string, change: any) => { cache.set(id, { ...cache.get(id), ...change.metadata }); return { published: true }; }),
  };
  const publishUnsubscribe = registerSessionHierarchyPublication(provider as any);
  const authorityUnsubscribe = registerMobileHierarchyAuthority(provider as any);
  async function phoneMove(id: string, parentSessionId: string | null) {
    const entry = { sessionId: id, hostDeviceId: getLocalHostDeviceId(), parentSessionId, createdBySessionId: 'stale-phone-manager', updatedAt: Date.now() };
    cache.set(id, entry);
    await Promise.all([...listeners].map(listener => listener([entry], () => true)));
    return provider.pushChange.mock.calls.filter(([sessionId]) => sessionId === id).at(-1)?.[1].metadata;
  }
  try {
    expect(await phoneMove('child', 'root')).toMatchObject({ parentSessionId: 'root', createdBySessionId: 'root' });
    expect(await phoneMove('child', 'other')).toMatchObject({ parentSessionId: 'other', createdBySessionId: 'other' });
    expect((await store.get('child'))?.createdBySessionId).toBe('other');
    expect(await phoneMove('other', 'child')).toMatchObject({ parentSessionId: null, createdBySessionId: null });
    expect((await store.get('other'))?.parentSessionId).toBeNull();
    expect(await phoneMove('child', 'foreign')).toMatchObject({ parentSessionId: 'other', createdBySessionId: 'other' });
    expect(await phoneMove('child', null)).toMatchObject({ parentSessionId: null, createdBySessionId: null });
    expect((await store.get('child'))?.createdBySessionId).toBeNull();
    expect(await phoneMove('child', 'deep-8')).toMatchObject({ parentSessionId: null, createdBySessionId: null });
    expect((await store.get('child'))?.parentSessionId).toBeNull();
  } finally { authorityUnsubscribe(); publishUnsubscribe(); }
});

it('republishes manager removal when deleting the spawner of a separate-container root', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'manager', provider: 'claude-code', workspaceId: '/p' });
  await store.create({ id: 'separate-root', provider: 'claude-code', workspaceId: '/p', createdBySessionId: 'manager' });
  const moves = vi.fn(async () => {});
  const unsubscribe = onHierarchyMove(moves);
  try {
    await store.delete('manager');
    expect((await store.get('separate-root'))?.createdBySessionId).toBeNull();
    expect(moves).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'separate-root', parentId: null, previousManagerId: 'manager', managerId: null }));
  } finally { unsubscribe(); }
});

it('rejects a moved subtree containing a legacy child from another workspace', async () => {
  const store = createPGLiteSessionStore(sqlite);
  for (const id of ['root', 'target']) await store.create({ id, provider: 'claude-code', workspaceId: '/p' });
  await store.create({ id: 'child', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'root' });
  await sqlite.query("INSERT INTO ai_sessions (id, provider, workspace_id, parent_session_id) VALUES ('foreign-descendant', 'claude-code', '/other', 'child')");
  await expect(store.updateMetadata('child', { parentSessionId: 'target' })).rejects.toThrow(/workspace/i);
  expect((await store.get('child'))?.parentSessionId).toBe('root');
});

it('keeps manager ownership and workspace identity in the authoritative workspace', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'manager', provider: 'claude-code', workspaceId: '/other' });
  await expect(store.create({ id: 'bad-manager', provider: 'claude-code', workspaceId: '/p', createdBySessionId: 'manager' })).rejects.toThrow(/manager/i);
  await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p' });
  await expect(store.updateMetadata('root', { workspaceId: '/other' })).rejects.toThrow(/workspace/i);
});

it('preserves explicit null provenance on migration and repeated user reassignments', async () => {
  const store = createPGLiteSessionStore(sqlite);
  for (const id of ['manager', 'A', 'B', 'unspawned']) await store.create({ id, provider: 'claude-code', workspaceId: '/p' });
  await store.create({ id: 'escaped', provider: 'claude-code', workspaceId: '/p', createdBySessionId: 'manager' });
  await migrateSessionTrees(sqlite);
  expect(Object.prototype.hasOwnProperty.call((await store.get('escaped'))!.metadata!, 'preTreeParentSessionId')).toBe(true);
  expect((await store.get('escaped'))?.metadata?.preTreeParentSessionId).toBeNull();
  for (const parentSessionId of ['A', 'B', 'A']) await store.updateMetadata('unspawned', { parentSessionId });
  expect(Object.prototype.hasOwnProperty.call((await store.get('unspawned'))!.metadata!, 'originalSpawnerSessionId')).toBe(true);
  expect((await store.get('unspawned'))?.metadata?.originalSpawnerSessionId).toBeNull();
});

it('resumes interrupted migration using backed-up original manager containers', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'wrapper', provider: 'claude-code', workspaceId: '/p', sessionType: 'workstream' });
  await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'wrapper' });
  for (let index = 0; index < 100; index++) await store.create({ id: `m${index}`, provider: 'claude-code', workspaceId: '/p', parentSessionId: 'wrapper', createdBySessionId: 'root' });
  await store.create({ id: 'leaf', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'wrapper', createdBySessionId: 'm0' });
  let calls = 0;
  const interrupted = { query: sqlite.query.bind(sqlite), runTransaction: async (statements: any[]) => {
    if (++calls === 2) throw new Error('interrupted migration');
    await sqlite.runTransaction(statements);
  } };
  await expect(migrateSessionTrees(interrupted)).rejects.toThrow('interrupted migration');
  expect((await store.get('leaf'))?.parentSessionId).toBe('wrapper');
  expect(await migrateSessionTrees(sqlite)).toEqual({ moved: 1 });
  expect((await store.get('leaf'))?.parentSessionId).toBe('m0');
  expect((await store.get('leaf'))?.metadata?.preTreeParentSessionId).toBe('wrapper');
});
