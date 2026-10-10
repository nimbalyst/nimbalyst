// @vitest-environment node
import { expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { createPGLiteSessionStore } from '../../PGLiteSessionStore';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { withHierarchyWrite, publishSubtreeArchive } from '../../sessionHierarchy';
import { applyMobileSessionParent } from '../mobileSessionHierarchy';
import { registerMobileHierarchyAuthority } from '../mobileHierarchySync';
import { logger } from '../../../utils/logger';
import { createHierarchyPublisher, registerSessionHierarchyPublication } from '../../sync/sessionHierarchyPublication';
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn() } }));
vi.mock('../../../utils/logger', () => ({ logger: { main: { warn: vi.fn() } } }));
vi.mock('../sessionHostAttribution', () => ({getLocalHostDeviceId: () => 'desktop'}));

it('retains a newer queued publication after the earlier send succeeds and the newer send fails', async () => {
  let parentSessionId = 'A';
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const push = vi.fn(async () => ({published: true}));
  push.mockImplementationOnce(async () => { await blocked; return {published: true}; });
  push.mockImplementationOnce(async () => ({published: false, retryable: true}));
  const publisher = createHierarchyPublisher({
    get: async () => ({parentSessionId, createdBySessionId: parentSessionId}) as any,
    push, warn: vi.fn(),
  });
  try {
    const first = publisher.publish('child');
    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    parentSessionId = 'B';
    const second = publisher.publish('child');
    release();
    await Promise.all([first, second]);
    expect(push.mock.calls.map((call: any) => call[1].parentSessionId)).toEqual(['A', 'B']);
    expect(publisher.pendingCount()).toBe(1);
    await publisher.retry();
    expect(push).toHaveBeenCalledTimes(3);
    expect(publisher.pendingCount()).toBe(0);
  } finally { publisher.pause(); }
});

it('rechecks remote freshness after entering the real store hierarchy lane', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-hierarchy-race-'));
  const db = new SQLiteDatabase({dbDir: temporary, schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas'), sampleRate: 0});
  let release!: () => void;
  try {
    await db.initialize();
    const store = createPGLiteSessionStore(db);
    for (const id of ['child', 'A', 'B']) await store.create({id, provider: 'claude-code', workspaceId: '/p'});
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holding = withHierarchyWrite(() => gate);
    let current = true;
    const authority = {get: store.get, updateMetadata: vi.fn(store.updateMetadata), publish: vi.fn(async () => {})};
    const applying = applyMobileSessionParent(authority, 'child', 'A', () => current);
    await vi.waitFor(() => expect(authority.updateMetadata).toHaveBeenCalledTimes(1));
    current = false;
    release();
    await holding;
    await applying;
    expect((await store.get('child'))?.parentSessionId ?? null).toBeNull();
    expect(authority.publish).not.toHaveBeenCalled();
  } finally { release?.(); await db.close(); fs.rmSync(temporary, {recursive: true, force: true}); }
});

it('reconstructs publication retries from durable intent and never treats a successful send as acknowledgement', async () => {
  const row = {parentSessionId: 'B', createdBySessionId: 'B', metadata: {hierarchySyncIntent: {revision: 'local-B'}}};
  const push = vi.fn(async () => ({published: true}));
  const deps = {get: async () => row as any, push, listPending: async () => row.metadata.hierarchySyncIntent ? ['child'] : [], warn: vi.fn()};
  const first = createHierarchyPublisher(deps);
  await first.publish('child');
  expect(first.pendingCount()).toBe(1);
  first.pause();
  const recreated = createHierarchyPublisher(deps);
  try {
    await recreated.retry();
    expect(push).toHaveBeenCalledTimes(2);
    expect(recreated.pendingCount()).toBe(1);
    delete (row.metadata as any).hierarchySyncIntent;
    await recreated.retry();
    expect(recreated.pendingCount()).toBe(0);
  } finally { recreated.pause(); }
});

it('retries durable-intent discovery even when the in-memory pending map starts empty', async () => {
  vi.useFakeTimers();
  const push = vi.fn(async () => ({published: true}));
  const publisher = createHierarchyPublisher({
    get: async () => ({parentSessionId: 'B', createdBySessionId: 'B'}) as any,
    listPending: vi.fn().mockRejectedValueOnce(new Error('Database temporarily unavailable')).mockResolvedValue(['child']),
    push, warn: vi.fn(),
  });
  try {
    await publisher.retry();
    expect(push).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(push).toHaveBeenCalledOnce();
  } finally { publisher.pause(); vi.useRealTimers(); }
});


it('publishes every archived descendant through the registered subtree event without passing array indexes as guards', async () => {
  const get = vi.spyOn(AISessionsRepository, 'get').mockResolvedValue({parentSessionId: null, createdBySessionId: null, isArchived: true} as any);
  const getStore = vi.spyOn(AISessionsRepository, 'getStore').mockReturnValue({listPendingHierarchyIntents: async () => []} as any);
  const pushChange = vi.fn(async (_id: string, _change: unknown, _options?: unknown) => ({published: true}));
  const stop = registerSessionHierarchyPublication({pushChange} as any);
  try {
    await publishSubtreeArchive(['archive-root', 'archive-child'], true);
    expect(pushChange.mock.calls.map(call => call[0])).toEqual(['archive-root', 'archive-child']);
    for (const call of pushChange.mock.calls as any[]) expect(call[2].isCurrent()).toBe(true);
  } finally { stop(); get.mockRestore(); getStore.mockRestore(); }
});

it('retries an unsuccessful confirmation barrier without discarding durable intent', async () => {
  vi.useFakeTimers();
  const row = {parentSessionId: 'B', createdBySessionId: 'B', metadata: {hierarchySyncIntent: {revision: 'B'}}};
  const confirm = vi.fn().mockRejectedValueOnce(new Error('Pull interrupted')).mockImplementation(async () => { delete (row.metadata as any).hierarchySyncIntent; });
  const push = vi.fn(async () => ({published: true}));
  const publisher = createHierarchyPublisher({get: async () => row as any, push, confirm,
    listPending: async () => row.metadata.hierarchySyncIntent ? ['child'] : [], warn: vi.fn()});
  try {
    await publisher.publish('child');
    await vi.advanceTimersByTimeAsync(0);
    expect(publisher.pendingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenCalledTimes(2);
    expect(publisher.pendingCount()).toBe(0);
  } finally { publisher.pause(); vi.useRealTimers(); }
});

it('ignores index entries for sessions this desktop does not have instead of warning on every broadcast', async () => {
  let listener!: (entries: any[], isCurrent: () => boolean) => Promise<void>;
  const provider = {onHierarchySnapshot: (fn: typeof listener) => { listener = fn; return () => {}; }};
  const applyRemoteHierarchySnapshot = vi.fn(async () => [{sessionId: 'foreign', parentSessionId: 'p', createdBySessionId: null, accepted: false, error: 'Session not hosted on this desktop'}]);
  const getStore = vi.spyOn(AISessionsRepository, 'getStore').mockReturnValue({applyRemoteHierarchySnapshot} as any);
  const get = vi.spyOn(AISessionsRepository, 'get').mockResolvedValue(null);
  const stop = registerMobileHierarchyAuthority(provider as any);
  try {
    vi.mocked(logger.main.warn).mockClear();
    await listener([{sessionId: 'foreign', parentSessionId: 'p'}], () => true);
    expect(logger.main.warn).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  } finally { stop(); getStore.mockRestore(); get.mockRestore(); }
});
