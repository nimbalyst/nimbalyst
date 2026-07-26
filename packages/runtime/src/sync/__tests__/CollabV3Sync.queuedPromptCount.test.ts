import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCollabV3Sync } from '../CollabV3Sync';

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

describe('CollabV3 queued prompt clearing', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes and preserves an explicit zero queue count', async () => {
    const encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const provider = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test',
      orgId: 'org-1',
      userId: 'user-1',
      getJwt: async () => jwtFor('user-1'),
      encryptionKey,
    });

    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const indexSocket = FakeWebSocket.instances[0];
    indexSocket.open();

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

  it('turns an empty session-room queue payload into an explicit clear', async () => {
    const provider = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test',
      orgId: 'org-1',
      userId: 'user-1',
      getJwt: async () => jwtFor('user-1'),
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
