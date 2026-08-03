// @vitest-environment node
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
  close = vi.fn(() => { this.readyState = 3; });

  constructor(readonly url: string) { FakeWebSocket.instances.push(this); }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.(new Event('open')); }
  receive(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent); }
}

function jwtFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${payload}.signature`;
}

function latestIndexUpdate(socket: FakeWebSocket): Record<string, any> {
  return socket.send.mock.calls
    .map(([payload]) => JSON.parse(payload as string))
    .filter((message) => message.type === 'indexUpdate')
    .at(-1);
}

describe('CollabV3 queued prompt truth', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips queue provenance and terminal truth through encrypted sync', async () => {
    const encryptionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const sender = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test', orgId: 'org-1', userId: 'sender',
      getJwt: async () => jwtFor('sender'), encryptionKey,
    });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const senderIndex = FakeWebSocket.instances[0];
    senderIndex.open();
    sender.syncSessionsToIndex?.([{
      id: 'session-1', title: 'Queue truth', provider: 'openai-codex', mode: 'agent', workspaceId: '/workspace',
      messageCount: 0, updatedAt: 1, createdAt: 1,
    }]);
    await vi.waitFor(() => expect(latestIndexUpdate(senderIndex)).toBeTruthy());

    sender.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { queuedPrompts: [{
        id: 'row-1', clientSubmissionId: 'client-1', sourceSessionId: 'session-1', sourceRoomId: 'room-1',
        submissionSequence: 7, producer: 'meta-agent', payloadUtf8Bytes: 18, payloadUnicodeScalars: 16,
        payloadSha256: 'a'.repeat(64), claimTrigger: 'meta-agent', claimTriggeredAt: 2,
        turnId: 'turn-1', providerInputMessageId: 'input-1', providerOutputMessageId: 'output-1',
        streamEventSequence: 3, terminalStatus: 'completed', terminalAt: 4,
        prompt: ' exact\\ntext ', timestamp: 1,
      }] },
    });
    await vi.waitFor(() => expect(latestIndexUpdate(senderIndex)?.session.encryptedQueuedPrompts).toHaveLength(1));
    const encryptedQueuedPrompts = latestIndexUpdate(senderIndex).session.encryptedQueuedPrompts;

    const receiver = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test', orgId: 'org-1', userId: 'receiver',
      getJwt: async () => jwtFor('receiver'), encryptionKey,
    });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    FakeWebSocket.instances[1].open();
    const connect = receiver.connect('session-1');
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3));
    const receiverSession = FakeWebSocket.instances[2];
    receiverSession.open();
    await connect;

    const changes: any[] = [];
    receiver.onRemoteChange('session-1', (change) => changes.push(change));
    receiverSession.receive({
      type: 'metadataBroadcast',
      metadata: { provider: 'openai-codex', encryptedQueuedPrompts },
    });

    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0].metadata.queuedPrompts).toEqual([expect.objectContaining({
      id: 'row-1', clientSubmissionId: 'client-1', sourceSessionId: 'session-1', sourceRoomId: 'room-1',
      submissionSequence: 7, producer: 'meta-agent', payloadUtf8Bytes: 18, payloadUnicodeScalars: 16,
      payloadSha256: 'a'.repeat(64), claimTrigger: 'meta-agent', claimTriggeredAt: 2,
      turnId: 'turn-1', providerInputMessageId: 'input-1', providerOutputMessageId: 'output-1',
      streamEventSequence: 3, terminalStatus: 'completed', terminalAt: 4, prompt: ' exact\\ntext ', timestamp: 1,
    })]);
    sender.disconnectAll();
    receiver.disconnectAll();
  });
});
