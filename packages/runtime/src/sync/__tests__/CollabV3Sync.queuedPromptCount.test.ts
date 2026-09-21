// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asPersonalJwt, asPersonalMemberId } from '../../auth/jwtScopes';

import { createCollabV3Sync } from '../CollabV3Sync';
import { encrypt } from '../collabV3Crypto';

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
  });

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

function jwtFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

function indexUpdates(socket: FakeWebSocket): Array<Record<string, any>> {
  return socket.send.mock.calls
    .map(([payload]) => JSON.parse(payload as string))
    .filter((message) => message.type === 'indexUpdate');
}

async function createIndexedProvider() {
  const encryptionKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const provider = createCollabV3Sync({
    serverUrl: 'wss://sync.example.test',
    orgId: 'org-1',
    personalMemberId: asPersonalMemberId('user-1'),
    getJwt: async () => asPersonalJwt(jwtFor('user-1')),
    encryptionKey,
  });

  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const indexSocket = FakeWebSocket.instances[0];
  indexSocket.open();
  // The write gate opens only after a complete index read (GitHub #1117).
  const fetching = provider.fetchIndex!();
  await vi.waitFor(() => expect(indexSocket.send.mock.calls.some(([p]) => JSON.parse(p as string).type === 'indexPageRequest')).toBe(true));
  const pageReq = indexSocket.send.mock.calls.map(([p]) => JSON.parse(p as string)).find((m) => m.type === 'indexPageRequest');
  indexSocket.receive({ type: 'indexPageResponse', protocolVersion: 2, requestId: pageReq.requestId, mode: 'bootstrap', entries: [], complete: true, cursor: 0 });
  await fetching;

  provider.syncSessionsToIndex?.([{
    id: 'session-1',
    title: 'Queue test',
    provider: 'openai-codex',
    mode: 'agent',
    workspaceId: '/workspace',
    messageCount: 0,
    updatedAt: 1_000,
    createdAt: 1_000,
  }]);
  await vi.waitFor(() => expect(indexUpdates(indexSocket)).toHaveLength(1));

  return { provider, indexSocket, encryptionKey };
}

describe('CollabV3 queued prompt clearing', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10000);
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('publishes and preserves an explicit zero queue count', async () => {
    const { provider, indexSocket } = await createIndexedProvider();

    provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: {
        queuedPrompts: [{ id: 'prompt-1', prompt: 'Run tests', timestamp: 2_000 }],
      },
    });
    await vi.waitFor(() => expect(indexUpdates(indexSocket)).toHaveLength(2));
    expect(indexUpdates(indexSocket).at(-1)?.session).toMatchObject({
      queuedPromptCount: 1,
    });
    expect(indexUpdates(indexSocket).at(-1)?.session.encryptedQueuedPrompts).toHaveLength(1);

    provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { queuedPrompts: [] },
    });
    await vi.waitFor(() => expect(indexUpdates(indexSocket)).toHaveLength(3));
    expect(indexUpdates(indexSocket).at(-1)?.session).toMatchObject({
      queuedPromptCount: 0,
      encryptedQueuedPrompts: [],
    });

    provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { isExecuting: false },
    });
    await vi.waitFor(() => expect(indexUpdates(indexSocket)).toHaveLength(4));
    expect(indexUpdates(indexSocket).at(-1)?.session.queuedPromptCount).toBe(0);
    expect(provider.getCachedIndexEntry?.('session-1')?.queuedPromptCount).toBe(0);

    provider.disconnectAll();
  });

  it.each([
    { metadata: { isExecuting: true }, remaining: [] },
    { metadata: { title: 'Renamed' }, remaining: [] },
    { metadata: { draftInput: 'next prompt', draftUpdatedAt: 3000 }, remaining: [] },
    { metadata: { isExecuting: true }, remaining: [{ id: 'p2', prompt: 'second', timestamp: 2000 }] },
  ])('preserves the remaining queue during concurrent metadata publication: %j', async ({ metadata, remaining }) => {
    const { provider, indexSocket } = await createIndexedProvider();
    try {
      await provider.pushChange('session-1', {
        type: 'metadata_updated',
        metadata: { queuedPrompts: [{ id: 'p1', prompt: 'first', timestamp: 1500 }, ...remaining] },
      });
      await Promise.all([
        provider.pushChange('session-1', { type: 'metadata_updated', metadata: { queuedPrompts: remaining } }),
        provider.pushChange('session-1', { type: 'metadata_updated', metadata }),
      ]);
      expect(provider.getCachedIndexEntry?.('session-1')?.queuedPrompts).toEqual(remaining);
      await provider.pushChange('session-1', { type: 'metadata_updated', metadata: { title: 'After consumption' } });
      const entry = indexUpdates(indexSocket).at(-1)?.session;
      expect(entry.queuedPromptCount).toBe(remaining.length);
      expect(entry.encryptedQueuedPrompts.map((prompt: { id: string }) => prompt.id)).toEqual(remaining.map(prompt => prompt.id));
      expect(entry.updatedAt).toBe(1000);
    } finally {
      provider.disconnectAll();
    }
  });

  it('does not replay a deferred queue over a newer clear when first indexing a session', async () => {
    const { provider, indexSocket } = await createIndexedProvider();
    try {
      await provider.pushChange('new-session', { type: 'metadata_updated', metadata: {
        queuedPrompts: [{ id: 'p1', prompt: 'first', timestamp: 1500 }],
      } });
      await provider.pushChange('new-session', { type: 'metadata_updated', metadata: {
        title: 'New', provider: 'openai-codex', workspaceId: '/workspace', updatedAt: 1000, queuedPrompts: [],
      } });
      provider.syncSessionsToIndex?.([{
        id: 'new-session', title: 'Next sync', provider: 'openai-codex', workspaceId: '/workspace',
        messageCount: 1, updatedAt: 2000, createdAt: 1000,
      }]);
      await vi.waitFor(() => expect(provider.getCachedIndexEntry?.('new-session')?.messageCount).toBe(1));
      expect(provider.getCachedIndexEntry?.('new-session')?.queuedPrompts).toEqual([]);
      expect(indexUpdates(indexSocket).at(-1)?.session.encryptedQueuedPrompts).toEqual([]);
    } finally {
      provider.disconnectAll();
    }
  });

  it('re-merges a queue clear when a remote update arrives during encryption', async () => {
    const { provider, indexSocket } = await createIndexedProvider();
    await provider.pushChange('session-1', { type: 'metadata_updated', metadata: {
      queuedPrompts: [{ id: 'p1', prompt: 'first', timestamp: 1500 }],
    } });
    const remoteEntry = { ...indexUpdates(indexSocket).at(-1)?.session, isExecuting: true };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const realEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
      await held;
      return realEncrypt(...args);
    });
    try {
      const clearing = provider.pushChange('session-1', { type: 'metadata_updated', metadata: { queuedPrompts: [] } });
      await vi.waitFor(() => expect(encryptSpy).toHaveBeenCalled());
      indexSocket.receive({ type: 'indexBroadcast', session: remoteEntry });
      await vi.waitFor(() => expect(provider.getCachedIndexEntry?.('session-1')?.isExecuting).toBe(true));
      release();
      expect(await clearing).toMatchObject({ published: true });
      expect(provider.getCachedIndexEntry?.('session-1')).toMatchObject({ isExecuting: true, queuedPrompts: [] });
      expect(indexUpdates(indexSocket).at(-1)?.session).toMatchObject({ isExecuting: true, encryptedQueuedPrompts: [], queuedPromptCount: 0 });
    } finally {
      release();
      encryptSpy.mockRestore();
      provider.disconnectAll();
    }
  });

  it('does not republish a consumed prompt after an in-flight index page arrives', async () => {
    const { provider, indexSocket } = await createIndexedProvider();
    try {
      await provider.pushChange('session-1', { type: 'metadata_updated', metadata: {
        queuedPrompts: [{ id: 'mobile-1', prompt: 'already running', timestamp: 1500 }],
      } });
      const oldEntry = indexUpdates(indexSocket).at(-1)!.session;
      const fetching = provider.fetchIndex!();
      const replayedQueue = vi.fn();
      provider.onIndexChange?.(replayedQueue);
      const requests = () => indexSocket.send.mock.calls.map(([p]) => JSON.parse(p as string)).filter(m => m.type === 'indexPageRequest');
      await vi.waitFor(() => expect(requests()).toHaveLength(2));
      const request = requests().at(-1)!;
      await provider.pushChange('session-1', { type: 'metadata_updated', metadata: { queuedPrompts: [] } });
      expect(provider.getCachedIndexEntry?.('session-1')?.queuedPrompts).toEqual([]);
      indexSocket.receive({ type: 'indexPageResponse', protocolVersion: 2, requestId: request.requestId,
        mode: 'delta', entries: [{entity: 'session', id: 'session-1', revision: 1, deleted: false, session: oldEntry}], complete: true, cursor: 1 });
      await fetching;
      expect(replayedQueue).toHaveBeenCalledWith('session-1', expect.objectContaining({
        queuedPrompts: [expect.objectContaining({ id: 'mobile-1' })],
      }));
      expect(provider.getCachedIndexEntry?.('session-1')?.queuedPrompts).toEqual([]);
      await provider.pushChange('session-1', { type: 'metadata_updated', metadata: { isExecuting: true } });
      expect(indexUpdates(indexSocket).at(-1)!.session.encryptedQueuedPrompts).toEqual([]);
    } finally { provider.disconnectAll(); }
  });

  it('keeps new remote prompts through a late broadcast and permits an explicit rollback', async () => {
    const { provider, indexSocket, encryptionKey } = await createIndexedProvider();
    const old = { id: 'old', prompt: 'consumed', timestamp: 1500 };
    const next = { id: 'new', prompt: 'still needed', timestamp: 2000 };
    try {
      await provider.pushChange('session-1', { type: 'metadata_updated', metadata: { queuedPrompts: [old] } });
      const broadcast = indexUpdates(indexSocket).at(-1)!.session;
      await provider.pushChange('session-1', { type: 'metadata_updated', metadata: { queuedPrompts: [] } });
      const encrypted = await encrypt(next.prompt, encryptionKey);
      broadcast.encryptedQueuedPrompts.push({ id: next.id, encryptedPrompt: encrypted.encrypted, iv: encrypted.iv, timestamp: next.timestamp });
      broadcast.queuedPromptCount = 2;
      indexSocket.receive({ type: 'indexBroadcast', session: { ...broadcast, isExecuting: true } });
      await vi.waitFor(() => expect(provider.getCachedIndexEntry?.('session-1')?.isExecuting).toBe(true));
      expect(provider.getCachedIndexEntry?.('session-1')?.queuedPrompts?.map(prompt => prompt.id)).toEqual(['new']);
      await provider.pushChange('session-1', { type: 'metadata_updated', metadata: { queuedPrompts: [old, next] } });
      indexSocket.receive({ type: 'indexBroadcast', session: broadcast });
      await vi.waitFor(() => expect(provider.getCachedIndexEntry?.('session-1')?.isExecuting).toBeUndefined());
      expect(provider.getCachedIndexEntry?.('session-1')?.queuedPrompts?.map(prompt => prompt.id)).toEqual(['old', 'new']);
    } finally { provider.disconnectAll(); }
  });

  it('turns an empty session-room queue payload into an explicit clear', async () => {
    const provider = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test',
      orgId: 'org-1',
      personalMemberId: asPersonalMemberId('user-1'),
      getJwt: async () => asPersonalJwt(jwtFor('user-1')),
    });

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    FakeWebSocket.instances[0].open();
    const connect = provider.connect('session-1');
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const sessionSocket = FakeWebSocket.instances[1];
    sessionSocket.open();
    await connect;

    const remoteChanges: any[] = [];
    provider.onRemoteChange('session-1', (change) => remoteChanges.push(change));
    sessionSocket.receive({
      type: 'metadataBroadcast',
      metadata: {
        provider: 'openai-codex',
        encryptedQueuedPrompts: [],
      },
    });

    await vi.waitFor(() => expect(remoteChanges).toHaveLength(1));
    expect(remoteChanges[0]).toMatchObject({
      type: 'metadata_updated',
      metadata: { queuedPrompts: [] },
    });

    provider.disconnectAll();
  });
});
