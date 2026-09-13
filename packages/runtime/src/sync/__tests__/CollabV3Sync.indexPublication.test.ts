// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asPersonalJwt, asPersonalMemberId } from '../../auth/jwtScopes';

import { createCollabV3Sync } from '../CollabV3Sync';

/**
 * The burst regression: `SyncedSessionStore` pushes `{ updatedAt }` to the index
 * on every persisted message. That routes to `indexClientMetadataPatch`, whose
 * wire payload carries no timestamp -- so a streaming turn used to emit one
 * server write + one iOS list re-sort per message with nothing new in it.
 *
 * Also pins the cache -> bulk route: the patch path must not advance the cached
 * `updatedAt` it never sent, or `resolveIndexSortTimestamp`'s mid-turn hold
 * leaks into the next bulk publish and the phone reorders mid-turn anyway.
 */

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

/**
 * Answer the provider's first bootstrap page with an empty, complete index.
 * The personal-sync write gate opens only after a complete read decrypts under
 * this key (GitHub #1117); every real consumer reads before it publishes.
 */
async function establishIndexCoverage(provider: ReturnType<typeof createCollabV3Sync>, indexSocket: FakeWebSocket): Promise<void> {
  const fetching = provider.fetchIndex!();
  await vi.waitFor(() => expect(indexSocket.send.mock.calls.some(([p]) => JSON.parse(p as string).type === 'indexPageRequest')).toBe(true));
  const req = indexSocket.send.mock.calls.map(([p]) => JSON.parse(p as string)).find((m) => m.type === 'indexPageRequest');
  indexSocket.receive({ type: 'indexPageResponse', protocolVersion: 2, requestId: req.requestId, mode: 'bootstrap', entries: [], complete: true, cursor: 0 });
  await fetching;
}

function jwtFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

const INDEX_PACKET_TYPES = new Set(['indexUpdate', 'indexBatchUpdate', 'indexClientMetadataPatch']);

function indexPackets(socket: FakeWebSocket): Array<Record<string, any>> {
  return socket.send.mock.calls
    .map(([payload]) => {
      try {
        return JSON.parse(payload as string);
      } catch {
        return { type: 'unparsable' };
      }
    })
    .filter((message) => INDEX_PACKET_TYPES.has(message.type));
}

async function createConnectedProvider() {
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
  await establishIndexCoverage(provider, indexSocket);
  return { provider, indexSocket };
}

function baseSession(overrides: Record<string, any> = {}) {
  return {
    id: 'session-1',
    title: 'Burst test',
    provider: 'claude-code',
    mode: 'agent',
    workspaceId: '/workspace',
    messageCount: 0,
    updatedAt: 1_000,
    createdAt: 1_000,
    ...overrides,
  };
}

describe('CollabV3 index publication gate', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(10000);
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('never opens transcript rooms or sends expired bulk rows, and accepts fresh activity', async () => {
    const { provider, indexSocket } = await createConnectedProvider();
    vi.setSystemTime(1800000000000);
    const now = Date.now();
    const getMessagesForSync = vi.fn(async () => new Map());
    const expired = Array.from({ length: 2000 }, (_, i) => baseSession({ id: `old-${i}`, updatedAt: now - 31 * 86400000, isArchived: i % 2 === 0 }));
    for (let i = 0; i < 3; i++) {
      provider.syncSessionsToIndex?.(expired, {
        syncMessages: true, messageSyncRequests: expired.map(s => ({ sessionId: s.id, sinceTimestamp: 0 })), getMessagesForSync,
      });
    }
    await new Promise(r => setTimeout(r, 80));
    expect(indexPackets(indexSocket)).toHaveLength(0);
    expect(getMessagesForSync).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(expired).toHaveLength(2000);
    provider.syncSessionsToIndex?.([baseSession({ updatedAt: now })]);
    await vi.waitFor(() => expect(indexPackets(indexSocket)).toHaveLength(1));
    provider.disconnect('session-1');
  });

  it('sends no index packet for a timestamp-only burst', async () => {
    const { provider, indexSocket } = await createConnectedProvider();

    provider.syncSessionsToIndex?.([baseSession()]);
    await vi.waitFor(() => expect(indexPackets(indexSocket)).toHaveLength(1));

    for (let i = 1; i <= 6; i++) {
      await provider.pushChange('session-1', {
        type: 'metadata_updated',
        metadata: { updatedAt: 1_000 + i * 10 },
      });
    }

    expect(indexPackets(indexSocket)).toHaveLength(1);
    provider.disconnectAll();
  });

  it('still publishes meaningful metadata, including an explicit clear', async () => {
    const { provider, indexSocket } = await createConnectedProvider();

    provider.syncSessionsToIndex?.([baseSession()]);
    await vi.waitFor(() => expect(indexPackets(indexSocket)).toHaveLength(1));

    await provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { draftInput: 'hello', draftUpdatedAt: 2_000 } as any,
    });
    expect(indexPackets(indexSocket)).toHaveLength(2);
    expect(indexPackets(indexSocket).at(-1)?.type).toBe('indexClientMetadataPatch');

    // Re-sending the same draft changes nothing on the wire.
    await provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { draftInput: 'hello', draftUpdatedAt: 2_000 } as any,
    });
    expect(indexPackets(indexSocket)).toHaveLength(2);

    // An explicit clear is a real change and must converge.
    await provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { draftInput: '', draftUpdatedAt: 3_000 } as any,
    });
    expect(indexPackets(indexSocket)).toHaveLength(3);

    // A Group B field keeps taking the full indexUpdate path.
    await provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { isExecuting: true },
    });
    expect(indexPackets(indexSocket)).toHaveLength(4);
    expect(indexPackets(indexSocket).at(-1)?.type).toBe('indexUpdate');

    provider.disconnectAll();
  });

  it('preserves read state and queued prompts through a suppressed burst', async () => {
    const { provider, indexSocket } = await createConnectedProvider();

    provider.syncSessionsToIndex?.([baseSession()]);
    await vi.waitFor(() => expect(indexPackets(indexSocket)).toHaveLength(1));

    await provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { updatedAt: 1_010 },
    });
    expect(indexPackets(indexSocket)).toHaveLength(1);

    await provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { lastReadAt: 1_500 } as any,
    });
    await provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { queuedPrompts: [{ id: 'p1', prompt: 'go', timestamp: 1_600, attachments: [{id: 'image', filename: 'screen.png', mimeType: 'image/png', size: 5, encryptedData: 'ciphertext', iv: 'nonce'}], options: {mode: 'planning', model: 'claude-code:sonnet'} }] },
    });

    const packets = indexPackets(indexSocket);
    expect(packets).toHaveLength(3);
    // Read state and queue changes are real changes: neither is swallowed by
    // the burst suppression that dropped the timestamp-only push above.
    expect(packets[1]?.session.lastReadAt).toBe(1_500);
    expect(packets.at(-1)?.session.queuedPromptCount).toBe(1);
    expect(packets.at(-1)?.session.encryptedQueuedPrompts[0]).toMatchObject({encryptedAttachments: [{encryptedData: 'ciphertext'}], options: {mode: 'planning', model: 'claude-code:sonnet'}});
    expect(provider.getCachedIndexEntry?.('session-1')?.queuedPrompts).toHaveLength(1);
    provider.disconnectAll();
  });

  it('retries after a failed send and after an index reconnect', async () => {
    const { provider, indexSocket } = await createConnectedProvider();

    provider.syncSessionsToIndex?.([baseSession()]);
    await vi.waitFor(() => expect(indexPackets(indexSocket)).toHaveLength(1));

    indexSocket.send.mockImplementationOnce(() => {
      throw new Error('socket write failed');
    });
    await provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { draftInput: 'retry me', draftUpdatedAt: 2_000 } as any,
    });
    // The throwing call still landed in the mock; nothing reached the server.
    const attempted = indexSocket.send.mock.calls.length;

    // The same projection must go out again because the first attempt failed.
    await provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { draftInput: 'retry me', draftUpdatedAt: 2_000 } as any,
    });
    expect(indexSocket.send.mock.calls.length).toBeGreaterThan(attempted);
    expect(indexPackets(indexSocket).at(-1)?.type).toBe('indexClientMetadataPatch');

    // A fresh connection proves nothing about what survived on the server.
    await provider.reconnectIndex?.();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(1));
    const freshSocket = FakeWebSocket.instances.at(-1)!;
    freshSocket.open();

    await provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { draftInput: 'retry me', draftUpdatedAt: 2_000 } as any,
    });
    expect(indexPackets(freshSocket)).toHaveLength(1);

    provider.disconnectAll();
  });

  it('drops a bulk entry whose encryption was overtaken by a live patch', async () => {
    const { provider, indexSocket } = await createConnectedProvider();

    provider.syncSessionsToIndex?.([baseSession()]);
    await vi.waitFor(() => expect(indexPackets(indexSocket)).toHaveLength(1));

    // Hold the bulk path's first encryption open so a patch can overtake it.
    // The bulk path runs outside the per-session publish queue, so without a
    // staleness check it would send stale ciphertext AFTER the newer patch and
    // then record that stale projection as what the server holds.
    let releaseBulk: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseBulk = resolve; });
    const realEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let encryptCalls = 0;
    const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args: any[]) => {
      encryptCalls++;
      if (encryptCalls === 1) await held;
      return realEncrypt(args[0], args[1], args[2]);
    });

    const bulk = provider.syncSessionsToIndex?.([baseSession({ updatedAt: 2_000 })]);
    await vi.waitFor(() => expect(encryptCalls).toBeGreaterThan(0));

    await provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { draftInput: 'typed while the bulk was encrypting', draftUpdatedAt: 2_500 } as any,
    });
    const packetsAfterPatch = indexPackets(indexSocket).length;
    expect(indexPackets(indexSocket).at(-1)?.type).toBe('indexClientMetadataPatch');

    releaseBulk();
    await bulk;
    // Let the released batch run to completion; it either sends or drops.
    await new Promise((resolve) => setTimeout(resolve, 50));
    encryptSpy.mockRestore();

    // The stale batch published nothing, so the patch remains the last word on
    // the wire and in the cache.
    expect(indexPackets(indexSocket)).toHaveLength(packetsAfterPatch);

    // The patch is still what the gate believes the server holds, so re-sending
    // it is a no-op. If the stale batch had overwritten the cache and the
    // recorded signature, this would go out again.
    await provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { draftInput: 'typed while the bulk was encrypting', draftUpdatedAt: 2_500 } as any,
    });
    expect(indexPackets(indexSocket)).toHaveLength(packetsAfterPatch);

    // A later legitimate publication still goes through.
    await provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { isExecuting: true },
    });
    expect(indexPackets(indexSocket)).toHaveLength(packetsAfterPatch + 1);
    provider.disconnectAll();
  });

  it('does not publish a payload whose connection was replaced during encryption', async () => {
    const { provider, indexSocket } = await createConnectedProvider();

    provider.syncSessionsToIndex?.([baseSession()]);
    await vi.waitFor(() => expect(indexPackets(indexSocket)).toHaveLength(1));

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const realEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let encryptCalls = 0;
    // Call 1 is pushChange's own metadata encryption; call 2 is the one inside
    // the index publish, i.e. after the socket has been captured. Holding that
    // one opens exactly the window a reconnect can land in.
    const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args: any[]) => {
      encryptCalls++;
      if (encryptCalls === 2) await held;
      return realEncrypt(args[0], args[1], args[2]);
    });

    const publishing = provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { draftInput: 'mid-flight', draftUpdatedAt: 3_000 } as any,
    });
    await vi.waitFor(() => expect(encryptCalls).toBeGreaterThanOrEqual(2));

    const packetsBeforeReconnect = indexPackets(indexSocket).length;
    // The socket this payload was built against goes away mid-encryption.
    await provider.reconnectIndex?.();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(1));
    const freshSocket = FakeWebSocket.instances.at(-1)!;
    freshSocket.open();

    release();
    await publishing;
    await new Promise((resolve) => setTimeout(resolve, 50));
    encryptSpy.mockRestore();

    // The payload must go nowhere: not onto the new socket (whose server never
    // saw it) and not onto the dead one (whose bytes go into the void while the
    // gate records them as delivered).
    expect(indexPackets(freshSocket)).toHaveLength(0);
    expect(indexPackets(indexSocket)).toHaveLength(packetsBeforeReconnect);
    provider.disconnectAll();
  });

  it('holds the mid-turn sort timestamp across the patch-cache -> bulk route', async () => {
    const { provider, indexSocket } = await createConnectedProvider();

    provider.syncSessionsToIndex?.([baseSession({ updatedAt: 1_000 })]);
    await vi.waitFor(() => expect(indexPackets(indexSocket)).toHaveLength(1));

    // Turn starts: full indexUpdate, sort key still 1000.
    await provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { isExecuting: true },
    });
    expect(indexPackets(indexSocket).at(-1)?.session.updatedAt).toBe(1_000);

    // Messages stream in. Each one pushes a timestamp the patch never transmits.
    for (const ts of [1_100, 1_200, 1_300]) {
      await provider.pushChange('session-1', {
        type: 'metadata_updated',
        metadata: { updatedAt: ts },
      });
    }
    expect(indexPackets(indexSocket)).toHaveLength(2);

    // The next bulk reconciliation must still publish the held sort key, not the
    // drifted local one, or the phone reorders the list mid-turn.
    provider.syncSessionsToIndex?.([baseSession({ updatedAt: 1_300 })]);
    await vi.waitFor(() => expect(indexPackets(indexSocket)).toHaveLength(3));
    const bulk = indexPackets(indexSocket).at(-1)!;
    expect(bulk.session.updatedAt).toBe(1_000);
    // Unread state still advances -- only ordering is held.
    expect(bulk.session.lastMessageAt).toBe(1_300);

    // Turn boundary releases the hold.
    await provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { isExecuting: false, updatedAt: 1_400 },
    });
    expect(indexPackets(indexSocket).at(-1)?.session.updatedAt).toBe(1_400);

    provider.disconnectAll();
  });
});
