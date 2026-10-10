// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { withHierarchyWrite } from '../../sessionHierarchy';
import { createPGLiteSessionStore } from '../../PGLiteSessionStore';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { createSyncedSessionStore } from '@nimbalyst/runtime/sync/SyncedSessionStore';
import { createCollabV3Sync } from '@nimbalyst/runtime/sync/CollabV3Sync';
import { asPersonalJwt, asPersonalMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { registerMobileHierarchyAuthority } from '../mobileHierarchySync';
import { registerSessionHierarchyPublication } from '../../sync/sessionHierarchyPublication';
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn() } }));
vi.mock('../../../utils/logger', () => ({ logger: { main: { warn: vi.fn() } } }));
vi.mock('../sessionHostAttribution', () => ({getLocalHostDeviceId: () => 'desktop'}));

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: {data: string}) => unknown) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  constructor(readonly url: string) { Socket.instances.push(this); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message: unknown) { return this.onmessage?.({data: JSON.stringify(message)}); }
}
const entry = (id: string, parentSessionId: string | null, revision: number) => ({
  entity: 'session', id, revision, deleted: false,
  session: {sessionId: id, parentSessionId, createdBySessionId: parentSessionId, hostDeviceId: 'desktop',
    provider: 'claude-code', messageCount: 0, createdAt: Date.now(), updatedAt: Date.now(), lastMessageAt: Date.now()},
});
async function connect() {
  Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  const encryptionKey = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
  const provider = createCollabV3Sync({serverUrl: 'wss://sync.example.test', orgId: 'org',
    personalMemberId: asPersonalMemberId('user'), getJwt: async () => asPersonalJwt(`header.${btoa(JSON.stringify({sub: 'user'}))}.signature`), encryptionKey});
  await vi.waitFor(() => expect(Socket.instances).toHaveLength(1));
  const socket = Socket.instances[0]; socket.open();
  return {provider, socket};
}
async function bootstrap(provider: ReturnType<typeof createCollabV3Sync>, socket: Socket, entries: unknown[]) {
  const fetch = provider.fetchIndex!();
  await vi.waitFor(() => expect(socket.send.mock.calls.some(([p]) => JSON.parse(p).type === 'indexPageRequest')).toBe(true));
  const request = socket.send.mock.calls.map(([p]) => JSON.parse(p)).filter(p => p.type === 'indexPageRequest').at(-1);
  await socket.receive({type: 'indexPageResponse', protocolVersion: 2, requestId: request.requestId, mode: 'bootstrap', entries, complete: true, cursor: entries.length});
  await fetch;
}
async function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-hierarchy-bootstrap-'));
  const options = {dbDir: temporary, schemaDir: path.resolve(__dirname, '../../../database/sqlite/schemas'), sampleRate: 0};
  let db = new SQLiteDatabase(options);
  await db.initialize();
  const store = createPGLiteSessionStore(db);
  AISessionsRepository.setStore(store);
  return {store, reopen: async () => { await db.close(); db = new SQLiteDatabase(options); await db.initialize(); return createPGLiteSessionStore(db); }, cleanup: async () => { AISessionsRepository.clearStore(); await db.close(); fs.rmSync(temporary, {recursive: true, force: true}); }};
}
afterEach(() => vi.unstubAllGlobals());

it('applies a valid complete remote graph reversal independent of snapshot row order', async () => {
  const local = await fixture();
  const {provider, socket} = await connect();
  let stopHierarchy = () => {}; let stopPublication = () => {};
  try {
    await local.store.create({id: 'A', provider: 'claude-code', workspaceId: '/p'});
    await local.store.create({id: 'B', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'A'});
    AISessionsRepository.setStore(createSyncedSessionStore(local.store, provider, {autoConnect: false}));
    stopPublication = registerSessionHierarchyPublication(provider);
    stopHierarchy = registerMobileHierarchyAuthority(provider);
    await bootstrap(provider, socket, [entry('A', 'B', 1), entry('B', null, 2)]);
    expect((await local.store.get('A'))?.parentSessionId).toBe('B');
    expect((await local.store.get('B'))?.parentSessionId ?? null).toBeNull();
    expect(socket.send.mock.calls.map(([p]) => JSON.parse(p)).filter(p => p.type === 'indexUpdate')).toEqual([]);
  } finally { stopHierarchy(); stopPublication(); provider.disconnectAll(); await local.cleanup(); }
});

it('retains a durable offline desktop move across store/provider recreation and stale bootstrap', async () => {
  const local = await fixture();
  let provider: ReturnType<typeof createCollabV3Sync> | undefined;
  let stopHierarchy = () => {}; let stopPublication = () => {};
  try {
    for (const id of ['A', 'B']) await local.store.create({id, provider: 'claude-code', workspaceId: '/p'});
    await local.store.create({id: 'child', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'A'});
    const first = await connect();
    await bootstrap(first.provider, first.socket, [entry('A', null, 1), entry('B', null, 2), entry('child', 'A', 3)]);
    first.provider.disconnectAll();
    await local.store.updateMetadata('child', {parentSessionId: 'B'});
    // Recreate the store facade and the transport; neither in-memory queue can preserve the intent.
    const recreated = await local.reopen();
    AISessionsRepository.setStore(recreated);
    const connected = await connect(); provider = connected.provider;
    AISessionsRepository.setStore(createSyncedSessionStore(recreated, provider, {autoConnect: false}));
    stopPublication = registerSessionHierarchyPublication(provider);
    stopHierarchy = registerMobileHierarchyAuthority(provider);
    await bootstrap(provider, connected.socket, [entry('A', null, 1), entry('B', null, 2), entry('child', 'A', 3)]);
    expect((await recreated.get('child'))?.parentSessionId).toBe('B');
    expect((await recreated.get('child'))?.createdBySessionId).toBe('B');
    const intents = () => AISessionsRepository.getStore().listPendingHierarchyIntents!();
    expect(await intents()).toEqual([expect.objectContaining({sessionId: 'child', parentSessionId: 'B', createdBySessionId: 'B'})]);
    const published = () => connected.socket.send.mock.calls.map(([p]) => JSON.parse(p))
      .find(p => p.type === 'indexUpdate' && p.session.sessionId === 'child' && p.session.parentSessionId === 'B');
    await vi.waitFor(() => expect(published()).toBeDefined());
    // Sending B and caching it optimistically cannot acknowledge it.
    expect(await intents()).toHaveLength(1);
    await connected.socket.receive({type: 'indexBroadcast', session: {...published().session, createdBySessionId: 'A'}});
    expect(await intents()).toHaveLength(1);
    expect((await recreated.get('child'))?.parentSessionId).toBe('B');
    await connected.socket.receive({type: 'indexBroadcast', session: published().session});
    expect(await intents()).toHaveLength(0);
    await recreated.updateMetadata('child', {parentSessionId: null});
    expect(await intents()).toHaveLength(1);
    const detached = connected.socket.send.mock.calls.map(([p]) => JSON.parse(p))
      .reverse().find(p => p.type === 'indexUpdate' && p.session.sessionId === 'child' && p.session.parentSessionId === null).session;
    const {createdBySessionId: _manager, ...omittedManager} = detached;
    await connected.socket.receive({type: 'indexBroadcast', session: omittedManager});
    expect(await intents()).toHaveLength(1);
    await connected.socket.receive({type: 'indexBroadcast', session: detached});
    expect(await intents()).toHaveLength(0);


  } finally { stopHierarchy(); stopPublication(); provider?.disconnectAll(); await local.cleanup(); }
});


it('a newer incoming row wins while an older snapshot waits in the authoritative store lane', async () => {
  const local = await fixture();
  const {provider, socket} = await connect();
  let stopHierarchy = () => {}; let stopPublication = () => {}; let release = () => {};
  try {
    for (const id of ['A', 'B', 'child']) await local.store.create({id, provider: 'claude-code', workspaceId: '/p'});
    const synced = createSyncedSessionStore(local.store, provider, {autoConnect: false});
    AISessionsRepository.setStore(synced);
    stopPublication = registerSessionHierarchyPublication(provider);
    stopHierarchy = registerMobileHierarchyAuthority(provider);
    await bootstrap(provider, socket, [entry('A', null, 1), entry('B', null, 2), entry('child', null, 3)]);
    const apply = vi.spyOn(synced, 'applyRemoteHierarchySnapshot');
    const held = new Promise<void>(resolve => { release = resolve; });
    const lane = withHierarchyWrite(() => held);
    const older = socket.receive({type: 'indexBroadcast', session: entry('child', 'A', 4).session});
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    const newer = socket.receive({type: 'indexBroadcast', session: entry('child', 'B', 5).session});
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    release();
    await Promise.all([lane, older, newer]);
    expect((await local.store.get('child'))?.parentSessionId).toBe('B');
    expect((await local.store.get('child'))?.createdBySessionId).toBe('B');
    expect(provider.getCachedIndexEntry?.('child')?.parentSessionId).toBe('B');
    expect(socket.send.mock.calls.map(([p]) => JSON.parse(p)).filter(p => p.type === 'indexUpdate' && p.session.parentSessionId === 'A')).toEqual([]);
  } finally { release(); stopHierarchy(); stopPublication(); provider.disconnectAll(); await local.cleanup(); }
});

it('confirms a connected local move with an authoritative pull when the server never echoes to its sender', async () => {
  const local = await fixture();
  const {provider, socket} = await connect();
  let stopHierarchy = () => {}; let stopPublication = () => {};
  try {
    for (const id of ['A', 'B']) await local.store.create({id, provider: 'claude-code', workspaceId: '/p'});
    await local.store.create({id: 'child', provider: 'claude-code', workspaceId: '/p', parentSessionId: 'A', createdBySessionId: 'A'});
    const synced = createSyncedSessionStore(local.store, provider, {autoConnect: false});
    AISessionsRepository.setStore(synced);
    stopPublication = registerSessionHierarchyPublication(provider);
    stopHierarchy = registerMobileHierarchyAuthority(provider);
    await bootstrap(provider, socket, [entry('A', null, 1), entry('B', null, 2), entry('child', 'A', 3)]);
    let revision = 3;
    const changes: any[] = [];
    socket.send.mockImplementation(raw => {
      const message = JSON.parse(raw);
      if (message.type === 'indexUpdate') {
        changes.push({entity: 'session', id: message.session.sessionId, revision: ++revision, deleted: false, session: message.session});
        // Deliberately no sender broadcast or indexChanged hint.
      }
      if (message.type === 'indexPageRequest') {
        queueMicrotask(() => void socket.receive({type: 'indexPageResponse', protocolVersion: 2,
          requestId: message.requestId, mode: message.mode, complete: true, cursor: revision,
          entries: changes.filter(change => change.revision > message.sinceRevision)}));
      }
    });
    await synced.updateMetadata('child', {parentSessionId: 'B'});
    await vi.waitFor(async () => expect(await synced.listPendingHierarchyIntents!()).toHaveLength(0));
    expect(changes.at(-1).session).toMatchObject({parentSessionId: 'B', createdBySessionId: 'B'});
    expect(socket.send.mock.calls.map(([p]) => JSON.parse(p)).some(p => p.type === 'indexPageRequest' && p.mode === 'delta')).toBe(true);
    // Confirmation releases local priority so a subsequent phone move can apply.
    await socket.receive({type: 'indexBroadcast', session: {...changes.at(-1).session, parentSessionId: 'A', createdBySessionId: 'A'}});
    expect((await local.store.get('child'))?.parentSessionId).toBe('A');
  } finally { stopHierarchy(); stopPublication(); provider.disconnectAll(); await local.cleanup(); }
});
