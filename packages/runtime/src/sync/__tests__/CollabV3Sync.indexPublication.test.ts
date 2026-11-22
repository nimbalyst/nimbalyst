// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asPersonalJwt, asPersonalMemberId } from '../../auth/jwtScopes';

import { createCollabV3Sync } from '../CollabV3Sync';
import { clearStableCiphertextCache } from '../stableCiphertext';
import { decrypt } from '../collabV3Crypto';
import type { PushChangeOutcome } from '../types';
import { createProjectConfigSync } from '../../../../electron/src/main/services/sync/projectConfigSync';

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

async function createConnectedProvider(overrides: Partial<Parameters<typeof createCollabV3Sync>[0]> = {}) {
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
    ...overrides,
  });

  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const indexSocket = FakeWebSocket.instances[0];
  indexSocket.open();
  await establishIndexCoverage(provider, indexSocket);
  return { provider, indexSocket, encryptionKey };
}

/** The real provider always reports an outcome; a `void` here is itself a failure. */
async function publishBatch(
  provider: ReturnType<typeof createCollabV3Sync>,
  sessions: Array<Record<string, any>>,
) {
  const outcome = await provider.syncSessionsToIndex!(sessions as never);
  if (!outcome) throw new Error('syncSessionsToIndex reported no publish outcome');
  return outcome;
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
  it('omits unknown recovery message counts on the v2 wire without clearing the cached count', async () => {
    const { provider, indexSocket } = await createConnectedProvider();
    try {
      await publishBatch(provider, [baseSession({ messageCount: 9 })]);
      await publishBatch(provider, [baseSession({ messageCount: 0, messageCountKnown: false })]);
      expect(indexPackets(indexSocket).at(-1)?.session).not.toHaveProperty('messageCount');
      expect(provider.getCachedIndexEntry?.('session-1')?.messageCount).toBe(9);
    } finally { provider.disconnectAll(); }
  });
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

  it('publishes explicit parent and manager nulls through bulk and live detach paths', async () => {
    const { provider, indexSocket } = await createConnectedProvider();
    try {
      await publishBatch(provider, [baseSession({ parentSessionId: 'root', createdBySessionId: 'root' })]);
      await provider.pushChange('session-1', { type: 'metadata_updated', metadata: { parentSessionId: null, createdBySessionId: null } });
      expect(indexPackets(indexSocket).at(-1)?.session).toMatchObject({ parentSessionId: null, createdBySessionId: null });
      await publishBatch(provider, [baseSession({ parentSessionId: null, createdBySessionId: null })]);
      expect(provider.getCachedIndexEntry?.('session-1')).toMatchObject({ parentSessionId: null, createdBySessionId: null });
    } finally { provider.disconnectAll(); }
  });

  it('exposes only authoritative incoming rows to hierarchy subscribers, including late subscribers', async () => {
    const { provider, indexSocket } = await createConnectedProvider();
    try {
      await publishBatch(provider, [baseSession({ parentSessionId: 'A', createdBySessionId: 'A' })]);
      const sent = indexPackets(indexSocket).at(-1)!;
      const row = sent.session ?? sent.sessions[0];
      const seen = vi.fn();
      provider.onHierarchySnapshot?.(seen);
      indexSocket.receive({type: 'indexBroadcast', session: row});
      await vi.waitFor(() => expect(seen.mock.calls.at(-1)?.[0]).toEqual([
        expect.objectContaining({sessionId: 'session-1', parentSessionId: 'A'}),
      ]));
      const count = seen.mock.calls.length;
      await provider.pushChange('session-1', {type: 'metadata_updated', metadata: {parentSessionId: 'B', createdBySessionId: 'B'}});
      expect(provider.getCachedIndexEntry?.('session-1')?.parentSessionId).toBe('B');
      expect(seen).toHaveBeenCalledTimes(count);
      const late = vi.fn();
      provider.onHierarchySnapshot?.(late);
      await vi.waitFor(() => expect(late.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({parentSessionId: 'A'}),
      ]));
    } finally { provider.disconnectAll(); }
  });

  it.each([1, 2])('does not let superseded canonical hierarchy overwrite a newer cache during encryption stage %s', async (heldCall) => {
    const { provider, indexSocket } = await createConnectedProvider();
    let release = () => {};
    let restoreEncrypt = () => {};
    try {
      await publishBatch(provider, [baseSession({parentSessionId: null})]);
      const sent = indexPackets(indexSocket).at(-1)!;
      const row = sent.session ?? sent.sessions[0];
      const held = new Promise<void>(resolve => { release = resolve; });
      const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
      let calls = 0;
      const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args: any[]) => {
        if (++calls === heldCall) await held;
        return encrypt(args[0], args[1], args[2]);
      });
      restoreEncrypt = () => { spy.mockRestore(); };
      let current = true;
      // Unchanged fields reuse ciphertext; miss so every encryption stage is a real await.
      clearStableCiphertextCache();
      const publishing = provider.pushChange('session-1', {type: 'metadata_updated', metadata: {parentSessionId: 'A', createdBySessionId: 'A'}}, {isCurrent: () => current});
      await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(heldCall));
      indexSocket.receive({type: 'indexBroadcast', session: {...row, parentSessionId: 'B', createdBySessionId: 'B'}});
      await vi.waitFor(() => expect(provider.getCachedIndexEntry?.('session-1')?.parentSessionId).toBe('B'));
      current = false;
      const before = indexPackets(indexSocket).length;
      release();
      expect(await publishing).toMatchObject({published: false, retryable: false});
      expect(indexPackets(indexSocket)).toHaveLength(before);
      expect(provider.getCachedIndexEntry?.('session-1')?.parentSessionId).toBe('B');
    } finally { release(); restoreEncrypt(); provider.disconnectAll(); }
  });

  it('publishes cold-start mobile commands through the encrypted index transport without a renderer', async () => {
    const { provider, indexSocket, encryptionKey } = await createConnectedProvider();
    try {
      const sync = createProjectConfigSync({
        getProvider: () => provider,
        getEnabledProjects: () => ['/workspace'],
        isProjectEnabled: path => path === '/workspace',
        discoverCommands: async () => [{ name: 'investigate', source: 'project' }],
        discoverActions: async () => [],
        getGitRemoteHash: async () => undefined,
        warn: vi.fn(),
      });
      await sync.refresh();
      const packet = indexSocket.send.mock.calls.map(([data]) => JSON.parse(data as string))
        .find(message => message.type === 'projectConfigUpdate');
      expect(packet).toBeDefined();
      const bytes = await crypto.subtle.decrypt({
        name: 'AES-GCM', iv: Buffer.from(packet.configIv, 'base64'),
      }, encryptionKey, Buffer.from(packet.encryptedConfig, 'base64'));
      expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
        commands: [{ name: 'investigate', source: 'project' }], lastCommandsUpdate: expect.any(Number),
      });
    } finally {
      provider.disconnectAll();
    }
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

  it.each([1, 2])('does not publish a payload whose connection was replaced during encryption stage %s', async (heldCall) => {
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
      if (encryptCalls === heldCall) await held;
      return realEncrypt(args[0], args[1], args[2]);
    });

    const publishing = provider.pushChange('session-1', {
      type: 'metadata_updated',
      metadata: { draftInput: 'mid-flight', draftUpdatedAt: 3_000 } as any,
    });
    await vi.waitFor(() => expect(encryptCalls).toBeGreaterThanOrEqual(heldCall));
    const waiting = provider.pushChange('session-1', {
      type: 'metadata_updated', metadata: { title: 'Queued before reconnect' },
    });

    const packetsBeforeReconnect = indexPackets(indexSocket).length;
    // The socket this payload was built against goes away mid-encryption.
    await provider.reconnectIndex?.();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(1));
    const freshSocket = FakeWebSocket.instances.at(-1)!;
    freshSocket.open();

    release();
    expect(await publishing).toMatchObject({ published: false, retryable: true });
    expect(await waiting).toMatchObject({ published: false, retryable: true });
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

  /**
   * R-C1-5: a one-shot send that never reached the wire must not fulfil. This
   * drives the real public sender with a key that cannot encrypt, so the build
   * inside the send channel throws exactly the way a project-id encryption
   * failure does.
   */
  it('rejects the public send when the payload cannot be built', async () => {
    const decryptOnlyKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['decrypt'],
    );
    const provider = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test',
      orgId: 'org-1',
      personalMemberId: asPersonalMemberId('user-1'),
      getJwt: async () => asPersonalJwt(jwtFor('user-1')),
      encryptionKey: decryptOnlyKey,
    });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const indexSocket = FakeWebSocket.instances[0];
    indexSocket.open();

    const sending = provider.sendCreateSessionRequest!({
      requestId: 'req-encrypt-fail',
      projectId: '/workspace',
      timestamp: 1_000,
    });

    await expect(sending).rejects.toThrow(/create session request/);
    await sending.catch((err: { reason?: string; retryable?: boolean }) => {
      expect(err.reason).toBe('failed to build create session request');
      // Deterministic: the same key would fail the same way on a retry.
      expect(err.retryable).toBe(false);
    });
    expect(indexPackets(indexSocket)).toHaveLength(0);
    provider.disconnectAll();
  });

  /**
   * The mobile create-session ack is only honest if the publish it waits on
   * reports what actually happened. A queued batch is NOT a published one.
   */
  it('reports whether a bulk publish reached the transport', async () => {
    const { provider, indexSocket } = await createConnectedProvider();

    const sent = await publishBatch(provider, [baseSession()]);
    expect(sent).toEqual({ published: true, publishedSessionIds: ['session-1'] });
    expect(indexPackets(indexSocket)).toHaveLength(1);

    // Nothing eligible for personal sync: refused, and not worth retrying.
    const ineligible = await publishBatch(provider, [
      baseSession({ id: 'tutorial-1', metadata: { tutorial: true } }),
    ]);
    expect(ineligible.published).toBe(false);
    expect(ineligible.publishedSessionIds).toEqual([]);

    provider.disconnectAll();

    // Disconnected: the batch is queued for reconnect, which the caller must be
    // able to tell apart from "on the wire".
    const queued = await publishBatch(provider, [baseSession({ id: 'session-2' })]);
    expect(queued.published).toBe(false);
    expect(queued.retryable).toBe(true);
    expect(queued.reason).toContain('queued');
  });

  /**
   * NIM-7545: a session in a project the user did not enable stays listed on
   * the phone, but its transcript is withheld, so every index publish has to
   * say so -- bulk, full update, patch, and first-sight -- and stop saying so
   * once the project is enabled.
   */
  it('marks sessions of a project not enabled for sync on every publish path, and clears the mark once enabled', async () => {
    const enabled = new Set<string>();
    const { provider, indexSocket, encryptionKey } = await createConnectedProvider({
      isTranscriptSyncDisabled: projectId => !enabled.has(projectId),
    });
    const clientMetaOf = async (packet: Record<string, any> | undefined) => {
      const body = packet?.session ?? packet?.patch;
      if (!body?.encryptedClientMetadata) return {};
      return JSON.parse(await decrypt(body.encryptedClientMetadata, body.clientMetadataIv, encryptionKey));
    };
    try {
      await publishBatch(provider, [baseSession({ workspaceId: '/opted-out' })]);
      expect(await clientMetaOf(indexPackets(indexSocket).at(-1))).toMatchObject({ transcriptSyncDisabled: true });

      await provider.pushChange('session-1', { type: 'metadata_updated', metadata: { isExecuting: true } });
      expect(indexPackets(indexSocket).at(-1)?.type).toBe('indexUpdate');
      expect(await clientMetaOf(indexPackets(indexSocket).at(-1))).toMatchObject({ transcriptSyncDisabled: true });

      await provider.pushChange('session-1', { type: 'metadata_updated', metadata: { draftInput: 'draft', draftUpdatedAt: 2_000 } as any });
      expect(indexPackets(indexSocket).at(-1)?.type).toBe('indexClientMetadataPatch');
      expect(await clientMetaOf(indexPackets(indexSocket).at(-1))).toMatchObject({ transcriptSyncDisabled: true });

      await provider.pushChange('session-2', { type: 'metadata_updated', metadata: {
        title: 'Created while opted out', provider: 'claude-code', workspaceId: '/opted-out', updatedAt: 3_000,
      } });
      expect(indexPackets(indexSocket).at(-1)?.session.sessionId).toBe('session-2');
      expect(await clientMetaOf(indexPackets(indexSocket).at(-1))).toMatchObject({ transcriptSyncDisabled: true });

      // The flag survives the round trip, so reconciliation can see which rows lack a transcript.
      const flaggedRow = indexPackets(indexSocket).filter(p => p.session?.sessionId === 'session-1').at(-1)!.session;
      const fetching = provider.fetchIndex!();
      const pageRequests = () => indexSocket.send.mock.calls.map(([p]) => JSON.parse(p as string)).filter(m => m.type === 'indexPageRequest');
      await vi.waitFor(() => expect(pageRequests()).toHaveLength(2));
      indexSocket.receive({ type: 'indexPageResponse', protocolVersion: 2, requestId: pageRequests().at(-1)!.requestId, mode: 'delta',
        entries: [{ entity: 'session', id: 'session-1', revision: 1, deleted: false, session: flaggedRow }], complete: true, cursor: 1 });
      const index = await fetching;
      expect(index.sessions.find(s => s.sessionId === 'session-1')?.transcriptSyncDisabled).toBe(true);

      // Enabled in Settings > Sync: the next publish of either kind drops the mark.
      enabled.add('/opted-out');
      await provider.pushChange('session-1', { type: 'metadata_updated', metadata: { isExecuting: false } });
      expect(indexPackets(indexSocket).at(-1)?.type).toBe('indexUpdate');
      expect((await clientMetaOf(indexPackets(indexSocket).at(-1))).transcriptSyncDisabled).toBeUndefined();
      await publishBatch(provider, [baseSession({ workspaceId: '/opted-out', updatedAt: 4_000 })]);
      expect((await clientMetaOf(indexPackets(indexSocket).at(-1))).transcriptSyncDisabled).toBeUndefined();

      // Disabled again: a patch alone must carry the change, not be suppressed as a no-op.
      enabled.delete('/opted-out');
      await provider.pushChange('session-1', { type: 'metadata_updated', metadata: { draftInput: 'draft', draftUpdatedAt: 2_000 } as any });
      expect(indexPackets(indexSocket).at(-1)?.type).toBe('indexClientMetadataPatch');
      expect(await clientMetaOf(indexPackets(indexSocket).at(-1))).toMatchObject({ transcriptSyncDisabled: true });
    } finally {
      provider.disconnectAll();
    }
  });

  it('reports each requested transcript upload, including a failed load, so a backfill is never assumed delivered', async () => {
    const { provider } = await createConnectedProvider();
    const outcomes: Array<[string, PushChangeOutcome]> = [];
    let failLoad = true;
    try {
      const sync = (ids: string[]) => provider.syncSessionsToIndex!(ids.map(id => baseSession({ id })) as never, {
        syncMessages: true,
        messageSyncRequests: ids.map(sessionId => ({ sessionId, sinceTimestamp: 0 })),
        getMessagesForSync: async () => { if (failLoad) throw new Error('database busy'); return new Map(); },
        onTranscriptSynced: (sessionId, outcome) => { outcomes.push([sessionId, outcome]); },
      });
      await sync(['owed-1']);
      await vi.waitFor(() => expect(outcomes).toHaveLength(1));
      expect(outcomes[0]).toEqual(['owed-1', expect.objectContaining({ published: false, retryable: true, reason: 'transcript load failed' })]);

      failLoad = false;
      await sync(['owed-1']);
      // Nothing stored past the requested point: nothing left to deliver.
      await vi.waitFor(() => expect(outcomes).toHaveLength(2));
      expect(outcomes[1]).toEqual(['owed-1', { published: true }]);
    } finally {
      provider.disconnectAll();
    }
  });

  /**
   * NIM-7546: `isExecuting: false` pushed during an index 1006 drop came back
   * `index publication deferred` and was never sent again, so the phone showed
   * the session running for hours.
   */
  it('resends an execution-state change deferred while the index was down once the index is usable again', async () => {
    const { provider, indexSocket } = await createConnectedProvider();
    try {
      await publishBatch(provider, [baseSession({ createdBySessionId: 'manager-1' })]);
      await provider.pushChange('session-1', { type: 'metadata_updated', metadata: { isExecuting: true, updatedAt: 2_000 } });
      expect(indexPackets(indexSocket).at(-1)?.session.isExecuting).toBe(true);

      indexSocket.readyState = 3;
      indexSocket.onclose?.({ code: 1006, reason: '', wasClean: false } as CloseEvent);
      const deferred = await provider.pushChange('session-1', { type: 'metadata_updated', metadata: { isExecuting: false, updatedAt: 3_000 } });
      expect(deferred).toMatchObject({ published: false, retryable: true });
      // A model-only change and an explicit manager clear made offline must survive too.
      await provider.pushChange('session-1', { type: 'metadata_updated', metadata: { model: 'claude-code:opus', createdBySessionId: null } });

      await provider.reconnectIndex!();
      await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(1));
      const freshSocket = FakeWebSocket.instances.at(-1)!;
      freshSocket.open();
      await vi.waitFor(() => expect(indexPackets(freshSocket).at(-1)?.session).toMatchObject({ sessionId: 'session-1', isExecuting: false }), { timeout: 2_000 });
      expect(indexPackets(freshSocket).at(-1)?.session).toMatchObject({ model: 'claude-code:opus', createdBySessionId: null });
      expect(provider.getCachedIndexEntry?.('session-1')?.isExecuting).toBe(false);
    } finally {
      provider.disconnectAll();
    }
  });
});
