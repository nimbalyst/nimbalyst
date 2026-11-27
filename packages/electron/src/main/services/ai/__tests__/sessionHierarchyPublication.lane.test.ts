// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionStore } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import type { SyncProvider } from '@nimbalyst/runtime/sync';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { createPGLiteSessionStore } from '../../PGLiteSessionStore';
import { publishCanonicalHierarchy, registerSessionHierarchyPublication } from '../../sync/sessionHierarchyPublication';

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: vi.fn(), getStore: vi.fn() } }));
vi.mock('../../../utils/logger', () => ({ logger: { main: { warn: vi.fn() } } }));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn() } }));

let directory: string;
let db: SQLiteDatabase;
let store: SessionStore;
let ready: boolean;
let unregister: () => void;
let push: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-hierarchy-publication-'));
  db = new SQLiteDatabase({ dbDir: directory, schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas'), sampleRate: 0 });
  await db.initialize();
  store = createPGLiteSessionStore(db);
  for (const id of ['child', 'target']) await store.create({ id, provider: 'claude-code', workspaceId: '/p' });
  vi.mocked(AISessionsRepository.get).mockImplementation(id => store.get(id));
  vi.mocked(AISessionsRepository.getStore).mockReturnValue(store);
  // Register offline so startup discovery cannot consume the intent being tested.
  ready = false;
  push = vi.fn().mockResolvedValue({ published: true });
  unregister = registerSessionHierarchyPublication({
    isIndexReady: () => ready,
    pushChange: push,
    fetchIndex: vi.fn().mockResolvedValue(undefined),
  } as unknown as SyncProvider);
});

afterEach(async () => {
  unregister();
  await db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

it('moves a session outside index retention without deadlocking intent acknowledgement', async () => {
  const oldActivity = Date.UTC(2000, 0, 1);
  await db.query('UPDATE ai_sessions SET updated_at=$2 WHERE id=$1', ['child', new Date(oldActivity).toISOString()]);
  const acknowledge = vi.spyOn(store, 'acknowledgeHierarchyIntent');
  ready = true;
  const move = store.updateMetadata('child', { parentSessionId: 'target' });
  await vi.waitFor(() => expect(acknowledge).toHaveBeenCalled());
  await move;
  await vi.waitFor(async () => expect(await store.listPendingHierarchyIntents!()).toEqual([]));
  expect(await store.get('child')).toMatchObject({ parentSessionId: 'target', createdBySessionId: null, updatedAt: oldActivity });
  expect(push).not.toHaveBeenCalled();
  // A subsequent writer must be able to enter the same global lane.
  await store.create({ id: 'after-move', provider: 'claude-code', workspaceId: '/p' });
}, 2000);

it.each(['archive', 'delete-lift'] as const)('%s releases the lane before acknowledging an old descendant intent', async operation => {
  await store.updateMetadata('child', { parentSessionId: 'target' });
  await db.query('UPDATE ai_sessions SET updated_at=$2 WHERE id=$1', ['child', '2000-01-01T00:00:00.000Z']);
  const acknowledge = vi.spyOn(store, 'acknowledgeHierarchyIntent');
  ready = true;
  await (operation === 'archive' ? store.updateMetadata('target', { isArchived: true }) : store.delete('target'));
  await vi.waitFor(async () => {
    expect(acknowledge).toHaveBeenCalled();
    expect(await store.listPendingHierarchyIntents!()).toEqual([]);
  });
  expect(await store.get('child')).toMatchObject(operation === 'archive'
    ? { parentSessionId: 'target', isArchived: true }
    : { parentSessionId: null, createdBySessionId: null });
  await store.create({ id: 'after-write', provider: 'claude-code', workspaceId: '/p' });
}, 2000);

it('keeps local and remote writes moving during a stalled push and publishes the latest durable state next', async () => {
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  push.mockImplementationOnce(async () => { await stalled; return { published: true }; });
  ready = true;
  try {
    await store.updateMetadata('child', { parentSessionId: 'target' });
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    await store.updateMetadata('child', { parentSessionId: null });
    await store.updateMetadata('child', { isArchived: true });
    const intents = await store.listPendingHierarchyIntents!();
    expect(intents).toMatchObject([{ sessionId: 'child', parentSessionId: null, createdBySessionId: null }]);
    const remote = await store.applyRemoteHierarchySnapshot!([
      { sessionId: 'target', parentSessionId: 'child', createdBySessionId: 'child' },
    ], () => true);
    expect(remote[0]).toMatchObject({ accepted: true, parentSessionId: 'child' });
    await store.create({ id: 'while-pushing', provider: 'claude-code', workspaceId: '/p' });
    expect(push).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(3));
    for (const call of push.mock.calls.slice(1)) {
      expect(call[1]).toMatchObject({ metadata: { parentSessionId: null, createdBySessionId: null, isArchived: true } });
    }
    // Sending is not acknowledgement: only a matching authoritative echo clears intent.
    expect(await store.listPendingHierarchyIntents!()).toMatchObject(intents);
    await store.applyRemoteHierarchySnapshot!([
      { sessionId: 'child', parentSessionId: null, createdBySessionId: null },
    ], () => true);
    expect(await store.listPendingHierarchyIntents!()).toEqual([]);
  } finally {
    release();
    // Drain the per-ID publication lane before closing its isolated database.
    await publishCanonicalHierarchy('child');
  }
}, 2000);
