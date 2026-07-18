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
  send = vi.fn<(payload: string) => void>();
  close = vi.fn(() => { this.readyState = 3; });

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }
}

function jwtFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${payload}.signature`;
}

function config(
  getJwt: () => Promise<string> = async () => jwtFor('user-1'),
  encryptionKey?: CryptoKey,
) {
  return {
    serverUrl: 'wss://sync.example.test',
    orgId: 'org-1',
    userId: 'user-1',
    getJwt,
    ...(encryptionKey ? { encryptionKey } : {}),
    getDeviceInfo: () => ({
      deviceId: 'desktop-1',
      name: 'Desktop',
      type: 'desktop' as const,
      platform: 'windows',
      connectedAt: 1,
      lastActiveAt: 2,
      isFocused: true,
      status: 'active' as const,
    }),
  };
}

async function connectedProvider() {
  const provider = createCollabV3Sync(config());
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.send.mockClear();
  return { provider, socket };
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function decryptFrameClientMetadata(
  frame: { session: { encryptedClientMetadata: string; clientMetadataIv: string } },
  key: CryptoKey,
): Promise<Record<string, unknown>> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBase64(frame.session.clientMetadataIv) },
    key,
    decodeBase64(frame.session.encryptedClientMetadata),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
}

describe('CollabV3 requestMobilePush client-write receipts', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports the request frame only after WebSocket.send accepts it', async () => {
    const { provider, socket } = await connectedProvider();
    const result = await provider.requestMobilePush!('session-1', 'Title', 'Body');

    expect(result).toMatchObject({
      outcome: 'request_frame_written',
      attempted: true,
      requestFrameWritten: true,
      skippedReason: null,
    });
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({
      type: 'requestMobilePush',
      sessionId: 'session-1',
      requestingDeviceId: 'desktop-1',
    });
    provider.disconnectAll();
  });

  it('returns reconnect_failed when no request frame was attempted', async () => {
    const getJwt = vi.fn(async () => { throw new Error('jwt unavailable'); });
    const provider = createCollabV3Sync(config(getJwt));
    await vi.waitFor(() => expect(getJwt).toHaveBeenCalled());

    await expect(provider.requestMobilePush!('session-1', 'Title', 'Body')).resolves.toMatchObject({
      outcome: 'skipped',
      attempted: false,
      requestFrameWritten: false,
      skippedReason: 'reconnect_failed',
    });
    provider.disconnectAll();
  });

  it('reports a still-closed replacement socket without claiming an attempt', async () => {
    const provider = createCollabV3Sync(config());
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const result = await provider.requestMobilePush!('session-1', 'Title', 'Body');
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(result).toMatchObject({
      outcome: 'skipped',
      attempted: false,
      requestFrameWritten: false,
      skippedReason: 'socket_not_open',
    });
    provider.disconnectAll();
  });

  it('reports a request send throw and still restores forced-away presence', async () => {
    const { provider, socket } = await connectedProvider();
    vi.useFakeTimers();
    socket.send.mockImplementation((payload: string) => {
      if (JSON.parse(payload).type === 'requestMobilePush') throw new Error('send exploded');
    });

    const result = await provider.requestMobilePush!('session-1', 'Title', 'Body', {
      bypassActiveDeviceRouting: true,
      forceDesktopAwayForPush: true,
    });
    expect(result).toMatchObject({
      outcome: 'failed',
      attempted: true,
      requestFrameWritten: false,
      skippedReason: 'request_frame_send_failed',
      forcedAwayFrameWritten: true,
      restorationScheduled: true,
    });
    expect(JSON.parse(socket.send.mock.calls[0][0]).device.status).toBe('away');

    await vi.advanceTimersByTimeAsync(1500);
    const lastFrame = JSON.parse(socket.send.mock.calls.at(-1)![0]);
    expect(lastFrame.type).toBe('deviceAnnounce');
    expect(lastFrame.device.status).toBe('active');
    provider.disconnectAll();
  });

  it('writes forced-away before the request frame and schedules restoration on success', async () => {
    const { provider, socket } = await connectedProvider();
    vi.useFakeTimers();
    const result = await provider.requestMobilePush!('session-1', 'Title', 'Body', {
      bypassActiveDeviceRouting: true,
      forceDesktopAwayForPush: true,
    });
    const frames = socket.send.mock.calls.map(([payload]) => JSON.parse(payload));
    expect(frames.map((frame) => frame.type)).toEqual(['deviceAnnounce', 'requestMobilePush']);
    expect(frames[0].device.status).toBe('away');
    expect(frames[1].requestingDeviceId).toBeUndefined();
    expect(result).toMatchObject({
      outcome: 'request_frame_written',
      forcedAwayFrameWritten: true,
      restorationScheduled: true,
    });

    await vi.advanceTimersByTimeAsync(1500);
    expect(JSON.parse(socket.send.mock.calls.at(-1)![0]).device.status).toBe('active');
    provider.disconnectAll();
  });

  it('reports an encrypted metadata index frame only after the socket accepts it', async () => {
    const encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const provider = createCollabV3Sync(config(async () => jwtFor('user-1'), encryptionKey));
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.send.mockClear();

    provider.syncSessionsToIndex!([{
      id: 'session-1',
      title: 'Session',
      provider: 'claude-code',
      workspaceId: '/workspace',
      messageCount: 0,
      createdAt: 1,
      updatedAt: 2,
      metadata: {},
    }]);
    await vi.waitFor(() => expect(socket.send.mock.calls.some(([payload]) =>
      JSON.parse(payload).type === 'indexUpdate')).toBe(true));
    socket.send.mockClear();

    const result = await provider.pushMetadataChangeWithResult!('session-1', {
      attentionSummary: {
        pending: true,
        severity: 'critical',
        eventId: 'event-1',
        effectiveDeadline: '2026-07-18T12:00:00.000Z',
      },
    });
    expect(result).toEqual({
      outcome: 'index_frame_written',
      attempted: true,
      indexFrameWritten: true,
      skippedReason: null,
    });
    const frameText = socket.send.mock.calls.at(-1)![0];
    const frame = JSON.parse(frameText);
    expect(frame.type).toBe('indexUpdate');
    expect(frame.session.encryptedClientMetadata).toBeTruthy();
    expect(frameText).not.toContain('event-1');
    expect(frameText).not.toContain('critical');
    provider.disconnectAll();
  });

  it('encrypts a timestamp-only opaque metadata patch instead of emitting an empty replacement', async () => {
    const encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const provider = createCollabV3Sync(config(async () => jwtFor('user-1'), encryptionKey));
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.open();

    provider.syncSessionsToIndex!([{
      id: 'session-draft-timestamp',
      title: 'Draft timestamp',
      provider: 'claude-code',
      workspaceId: '/workspace',
      messageCount: 0,
      createdAt: 1,
      updatedAt: 2,
      metadata: {},
    }]);
    await vi.waitFor(() => expect(socket.send.mock.calls.some(([payload]) =>
      JSON.parse(payload).type === 'indexUpdate')).toBe(true));
    socket.send.mockClear();

    await expect(provider.pushMetadataChangeWithResult!('session-draft-timestamp', {
      draftUpdatedAt: 1234,
    })).resolves.toMatchObject({
      outcome: 'index_frame_written',
      indexFrameWritten: true,
    });

    const frame = JSON.parse(socket.send.mock.calls.at(-1)![0]);
    expect(frame.type).toBe('indexClientMetadataPatch');
    expect(frame.patch.encryptedClientMetadata).toBeTruthy();
    await expect(decryptFrameClientMetadata({ session: frame.patch }, encryptionKey))
      .resolves.toEqual({ draftUpdatedAt: 1234 });
    provider.disconnectAll();
  });

  it('does not claim a metadata write while the index socket is closed', async () => {
    const encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const provider = createCollabV3Sync(config(async () => jwtFor('user-1'), encryptionKey));
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    await expect(provider.pushMetadataChangeWithResult!('session-1', {
      hasPendingPrompt: false,
    })).resolves.toEqual({
      outcome: 'skipped',
      attempted: false,
      indexFrameWritten: false,
      skippedReason: 'index_not_connected',
    });
    provider.disconnectAll();
  });

  it('keeps durable prompt and attention truth authoritative across full index resync', async () => {
    const encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const provider = createCollabV3Sync(config(async () => jwtFor('user-1'), encryptionKey));
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.open();

    const syncAndRead = async (metadata: Record<string, unknown>) => {
      socket.send.mockClear();
      provider.syncSessionsToIndex!([{
        id: 'session-durable',
        title: 'Durable',
        provider: 'claude-code',
        workspaceId: '/workspace',
        messageCount: 0,
        createdAt: 1,
        updatedAt: 2,
        metadata,
      }]);
      await vi.waitFor(() => expect(socket.send.mock.calls.some(([payload]) =>
        JSON.parse(payload).type === 'indexUpdate')).toBe(true));
      const frame = socket.send.mock.calls
        .map(([payload]) => JSON.parse(payload))
        .find((candidate) => candidate.type === 'indexUpdate');
      return decryptFrameClientMetadata(frame, encryptionKey);
    };

    await expect(syncAndRead({
      hasPendingPrompt: false,
      attentionSummary: { pending: false },
    })).resolves.toMatchObject({
      hasPendingPrompt: false,
      attentionSummary: { pending: false },
    });

    // Empty/stale cache must not erase a durable pending=true value.
    await expect(syncAndRead({
      hasPendingPrompt: true,
      attentionSummary: {
        pending: true,
        severity: 'normal',
        eventId: 'event-durable',
        effectiveDeadline: '2026-07-18T15:00:00.000Z',
      },
    })).resolves.toMatchObject({
      hasPendingPrompt: true,
      attentionSummary: { pending: true, eventId: 'event-durable' },
    });

    // The preceding send left a true/pending cache entry. New durable false
    // values still win during the next full resync.
    await expect(syncAndRead({
      hasPendingPrompt: false,
      attentionSummary: { pending: false },
    })).resolves.toMatchObject({
      hasPendingPrompt: false,
      attentionSummary: { pending: false },
    });

    // A following row with no durable values falls back to the cache populated
    // by the final merged frame above. This proves the cache was healed to the
    // emitted false/cancelled truth instead of retaining its stale true value.
    await expect(syncAndRead({})).resolves.toMatchObject({
      hasPendingPrompt: false,
      attentionSummary: { pending: false },
    });
    provider.disconnectAll();
  });

  it('does not claim an index frame when the socket closes during metadata encryption', async () => {
    const encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const provider = createCollabV3Sync(config(async () => jwtFor('user-1'), encryptionKey));
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0];
    socket.open();
    provider.syncSessionsToIndex!([{
      id: 'session-race',
      title: 'Race',
      provider: 'claude-code',
      workspaceId: '/workspace',
      messageCount: 0,
      createdAt: 1,
      updatedAt: 2,
      metadata: {},
    }]);
    await vi.waitFor(() => expect(socket.send.mock.calls.some(([payload]) =>
      JSON.parse(payload).type === 'indexUpdate')).toBe(true));
    socket.send.mockClear();

    const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let releaseEncryption!: () => void;
    let markEncryptionStarted!: () => void;
    const encryptionStarted = new Promise<void>((resolve) => { markEncryptionStarted = resolve; });
    const encryptionGate = new Promise<void>((resolve) => { releaseEncryption = resolve; });
    const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(
      async (...args: any[]) => {
        markEncryptionStarted();
        await encryptionGate;
        return originalEncrypt(...args as [any, CryptoKey, BufferSource]);
      },
    );

    const resultPromise = provider.pushMetadataChangeWithResult!('session-race', {
      hasPendingPrompt: false,
    });
    await encryptionStarted;
    socket.close();
    releaseEncryption();

    await expect(resultPromise).resolves.toEqual({
      outcome: 'skipped',
      attempted: false,
      indexFrameWritten: false,
      skippedReason: 'index_not_connected',
    });
    expect(socket.send).not.toHaveBeenCalled();
    encryptSpy.mockRestore();
    provider.disconnectAll();
  });
});
