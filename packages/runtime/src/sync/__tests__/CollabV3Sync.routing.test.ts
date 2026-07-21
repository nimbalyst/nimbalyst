import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  createCollabV3Sync,
  isIndexClientMetadataOnlyUpdateForTest,
} from '../CollabV3Sync';
import type { SyncedSessionMetadata } from '../types';

class PendingMetadataWebSocket {
  static readonly OPEN = 1;
  static instances: PendingMetadataWebSocket[] = [];
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send = vi.fn<(payload: string) => void>();
  close = vi.fn(() => { this.readyState = 3; });
  constructor(readonly url: string) { PendingMetadataWebSocket.instances.push(this); }
  open(): void {
    this.readyState = PendingMetadataWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }
}

function jwtFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${payload}.signature`;
}

beforeEach(() => {
  PendingMetadataWebSocket.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Routing predicate guards against the v0.63.0 regression where metadata-only
// updates were silently re-routed to a wire message (`indexClientMetadataPatch`)
// that neither the Cloudflare collab server nor the iOS client understands.
// Fields in Group B drive cross-device UI (spinner, pending prompt, context
// usage, phase, tags, unread badges) and MUST go through the full `indexUpdate`
// path. Widening this allow-list silently breaks mobile again.

describe('isIndexClientMetadataOnlyUpdate routing predicate', () => {
  const m = <T extends Partial<SyncedSessionMetadata>>(meta: T): T => meta;

  describe('forces full indexUpdate (Group B)', () => {
    it('routes { isExecuting, updatedAt } through indexUpdate', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(m({ isExecuting: false, updatedAt: 123 })),
      ).toBe(false);
    });

    it('routes { hasPendingPrompt, updatedAt } through indexUpdate', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(m({ hasPendingPrompt: true, updatedAt: 123 })),
      ).toBe(false);
    });

    it('routes encrypted attention summary updates through indexUpdate', () => {
      expect(isIndexClientMetadataOnlyUpdateForTest(m({
        attentionSummary: {
          pending: true,
          severity: 'normal',
          eventId: 'event-1',
          effectiveDeadline: '2026-07-18T12:00:00.000Z',
        },
      }))).toBe(false);
    });

    it('routes { currentContext } through indexUpdate', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(
          m({ currentContext: { tokens: 1, contextWindow: 200000 } }),
        ),
      ).toBe(false);
    });

    it('routes { phase } through indexUpdate', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(m({ phase: 'validating' } as Partial<SyncedSessionMetadata>)),
      ).toBe(false);
    });

    it('routes { tags } through indexUpdate', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(m({ tags: ['bug-fix'] } as Partial<SyncedSessionMetadata>)),
      ).toBe(false);
    });

    it('routes { lastReadAt } through indexUpdate (cross-device unread badges)', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(m({ lastReadAt: 123 } as Partial<SyncedSessionMetadata>)),
      ).toBe(false);
    });
  });

  describe('stays on patch fast-path (Group A)', () => {
    it('routes { draftInput, draftUpdatedAt } through the patch path', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(
          m({ draftInput: 'hello', draftUpdatedAt: 123 } as Partial<SyncedSessionMetadata>),
        ),
      ).toBe(true);
    });

    it('routes { hasBeenNamed } through the patch path', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(
          m({ hasBeenNamed: true } as Partial<SyncedSessionMetadata>),
        ),
      ).toBe(true);
    });

    it('routes a bare { updatedAt } through the patch path', () => {
      expect(isIndexClientMetadataOnlyUpdateForTest(m({ updatedAt: 123 }))).toBe(true);
    });
  });

  describe('mixed updates fall back to indexUpdate', () => {
    it('refuses the patch path when any Group B field is mixed with Group A', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(
          m({ isExecuting: false, draftInput: 'x', updatedAt: 123 } as Partial<SyncedSessionMetadata>),
        ),
      ).toBe(false);
    });

    it('refuses the patch path when a non-metadata field is present', () => {
      expect(
        isIndexClientMetadataOnlyUpdateForTest(
          m({ title: 'new title' } as Partial<SyncedSessionMetadata>),
        ),
      ).toBe(false);
    });

    it('refuses the patch path when given an empty update', () => {
      expect(isIndexClientMetadataOnlyUpdateForTest(m({}))).toBe(false);
    });
  });
});

describe('CollabV3 pending metadata convergence', () => {
  it('retains a queued update across the cache-population disconnect boundary and replays it on reconnect', async () => {
    vi.stubGlobal('WebSocket', PendingMetadataWebSocket);
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
    await vi.waitFor(() => expect(PendingMetadataWebSocket.instances).toHaveLength(1));
    const socket = PendingMetadataWebSocket.instances[0];
    socket.open();
    socket.send.mockClear();

    await expect(provider.pushMetadataChangeWithResult?.('queued-session', {
      isPinned: true,
    })).resolves.toMatchObject({
      outcome: 'queued',
      indexFrameWritten: false,
    });

    // Populate the production cache while the index transport is no longer
    // writable. The pending fact must survive rather than being deleted first.
    socket.readyState = 3;
    provider.syncSessionsToIndex?.([{
      id: 'queued-session',
      title: 'Authoritative',
      provider: 'claude-code',
      workspaceId: '/repo',
      messageCount: 0,
      updatedAt: 2,
      createdAt: 1,
    }]);
    await vi.waitFor(() => expect(provider.getCachedIndexEntry('queued-session')).toBeDefined());

    // Reconnection allocates the authoritative transport that replays the
    // retained entry; the closed socket is never reopened.
    provider.reconnectIndex();
    await vi.waitFor(() => expect(PendingMetadataWebSocket.instances).toHaveLength(2));
    const replacement = PendingMetadataWebSocket.instances[1];
    replacement.open();
    await vi.waitFor(() => expect(replacement.send).toHaveBeenCalled());
    const frames = replacement.send.mock.calls.map(([payload]) => JSON.parse(payload));
    expect(frames).toContainEqual(expect.objectContaining({
      type: 'indexUpdate',
      session: expect.objectContaining({ sessionId: 'queued-session', isPinned: true }),
    }));
    provider.disconnectAll();
  });

  it('makes disconnectAll terminal across onclose, reconnect timers, and retained startup work', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('WebSocket', PendingMetadataWebSocket);
      const encryptionKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
      );
      const getJwtA = vi.fn(async () => jwtFor('user-a'));
      const providerA = createCollabV3Sync({
        serverUrl: 'wss://sync.example.test', orgId: 'org-a', userId: 'user-a',
        getJwt: getJwtA, encryptionKey,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(PendingMetadataWebSocket.instances).toHaveLength(1);
      const socketA = PendingMetadataWebSocket.instances[0];
      socketA.open();
      socketA.send.mockClear();
      const retiredOnClose = socketA.onclose;

      // A real drop queues a reconnect and lets an old startup publication be
      // retained. Terminal disconnect must clear both before provider B exists.
      retiredOnClose?.({ code: 1006, reason: '', wasClean: false } as CloseEvent);
      providerA.syncSessionsToIndex?.([{
        id: 'retired-startup', title: 'Retired', provider: 'claude-code',
        workspaceId: '/repo-a', messageCount: 0, updatedAt: 2, createdAt: 1,
      }]);
      providerA.disconnectAll();

      const getJwtB = vi.fn(async () => jwtFor('user-b'));
      const providerB = createCollabV3Sync({
        serverUrl: 'wss://sync.example.test', orgId: 'org-b', userId: 'user-b',
        getJwt: getJwtB, encryptionKey,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(PendingMetadataWebSocket.instances).toHaveLength(2);
      const socketB = PendingMetadataWebSocket.instances[1];
      socketB.open();

      // A late native close callback and a late captured startup callback are
      // inert after disposal; advancing every reconnect deadline creates no A
      // socket and drains no retained A operation into B.
      retiredOnClose?.({ code: 1006, reason: 'late', wasClean: false } as CloseEvent);
      providerA.syncSessionsToIndex?.([{
        id: 'late-retired-startup', title: 'Late retired', provider: 'claude-code',
        workspaceId: '/repo-a', messageCount: 0, updatedAt: 3, createdAt: 1,
      }]);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(PendingMetadataWebSocket.instances).toHaveLength(2);
      expect(getJwtA).toHaveBeenCalledTimes(1);
      expect(socketA.send).not.toHaveBeenCalled();
      const providerBFrames = socketB.send.mock.calls.map(([payload]) => JSON.parse(payload));
      expect(providerBFrames).toContainEqual({ type: 'ping' });
      expect(providerBFrames).not.toContainEqual(expect.objectContaining({
        type: 'indexUpdate',
        session: expect.objectContaining({ sessionId: 'retired-startup' }),
      }));
      expect(providerBFrames).not.toContainEqual(expect.objectContaining({
        type: 'indexUpdate',
        session: expect.objectContaining({ sessionId: 'late-retired-startup' }),
      }));
      expect(getJwtB).toHaveBeenCalledTimes(1);
      providerB.disconnectAll();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('does not allocate a session socket when disconnect retires a suspended JWT intent', async () => {
    vi.stubGlobal('WebSocket', PendingMetadataWebSocket);
    const encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
    );
    let releaseSessionJwt!: (jwt: string) => void;
    const sessionJwt = new Promise<string>((resolve) => { releaseSessionJwt = resolve; });
    const getJwt = vi.fn()
      .mockResolvedValueOnce(jwtFor('intent-user'))
      .mockImplementationOnce(() => sessionJwt);
    const provider = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test', orgId: 'intent-org',
      userId: 'intent-user', getJwt, encryptionKey,
    });
    await Promise.resolve();
    await Promise.resolve();
    PendingMetadataWebSocket.instances[0].open();

    const staleConnect = provider.connect('pre-socket-disconnect');
    await Promise.resolve();
    expect(getJwt).toHaveBeenCalledTimes(2);
    provider.disconnect('pre-socket-disconnect');

    releaseSessionJwt(jwtFor('intent-user'));
    await staleConnect;

    // Only the index transport was ever allocated. The retired operation may
    // not authenticate, install a session socket, or become connected later.
    expect(PendingMetadataWebSocket.instances).toHaveLength(1);
    expect(provider.isConnected('pre-socket-disconnect')).toBe(false);
    provider.disconnectAll();
  });

  it('allows only the newest same-ID intent to install after a disconnected JWT wait', async () => {
    vi.stubGlobal('WebSocket', PendingMetadataWebSocket);
    const encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
    );
    let releaseStaleJwt!: (jwt: string) => void;
    let releaseCurrentJwt!: (jwt: string) => void;
    const staleJwt = new Promise<string>((resolve) => { releaseStaleJwt = resolve; });
    const currentJwt = new Promise<string>((resolve) => { releaseCurrentJwt = resolve; });
    const getJwt = vi.fn()
      .mockResolvedValueOnce(jwtFor('intent-user'))
      .mockImplementationOnce(() => staleJwt)
      .mockImplementationOnce(() => currentJwt);
    const provider = createCollabV3Sync({
      serverUrl: 'wss://sync.example.test', orgId: 'intent-org',
      userId: 'intent-user', getJwt, encryptionKey,
    });
    await Promise.resolve();
    await Promise.resolve();
    PendingMetadataWebSocket.instances[0].open();

    const staleConnect = provider.connect('same-pre-socket-session');
    await Promise.resolve();
    provider.disconnect('same-pre-socket-session');

    const currentConnect = provider.connect('same-pre-socket-session');
    await Promise.resolve();
    expect(getJwt).toHaveBeenCalledTimes(3);
    // B restores the lexical wanted state but remains pre-socket. Resolving A
    // first must still be rejected by its retired intent generation; a boolean
    // wanted check or the later sessions.has() guard alone would accept A.
    expect(PendingMetadataWebSocket.instances).toHaveLength(1);
    releaseStaleJwt(jwtFor('intent-user'));
    await staleConnect;
    expect(PendingMetadataWebSocket.instances).toHaveLength(1);
    expect(provider.isConnected('same-pre-socket-session')).toBe(false);

    releaseCurrentJwt(jwtFor('intent-user'));
    await Promise.resolve();
    await Promise.resolve();
    const currentSocket = PendingMetadataWebSocket.instances[1];
    currentSocket.open();
    await currentConnect;
    expect(PendingMetadataWebSocket.instances).toHaveLength(2);
    expect(provider.isConnected('same-pre-socket-session')).toBe(true);
    expect(currentSocket.send).toHaveBeenCalledTimes(1);
    expect(getJwt).toHaveBeenCalledTimes(3);
    provider.disconnectAll();
  });

  it('retires a suspended primary intent when a real transient message sync reaches a fatal limit', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('WebSocket', PendingMetadataWebSocket);
      const encryptionKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
      );
      let releasePrimaryJwt!: (jwt: string) => void;
      const primaryJwt = new Promise<string>((resolve) => { releasePrimaryJwt = resolve; });
      const getJwt = vi.fn()
        .mockResolvedValueOnce(jwtFor('fatal-user'))
        .mockImplementationOnce(() => primaryJwt)
        .mockResolvedValueOnce(jwtFor('fatal-user'));
      const provider = createCollabV3Sync({
        serverUrl: 'wss://sync.example.test', orgId: 'fatal-org',
        userId: 'fatal-user', getJwt, encryptionKey,
      });
      await Promise.resolve();
      await Promise.resolve();
      const indexSocket = PendingMetadataWebSocket.instances[0];
      indexSocket.open();

      const sessionId = 'fatal-before-primary-socket';
      const suspendedPrimary = provider.connect(sessionId);
      await Promise.resolve();
      expect(getJwt).toHaveBeenCalledTimes(2);

      // This public bulk path builds the index entry then reaches the actual
      // transient session transport used for message replay. No test hook or
      // private map seeds the fatal retirement boundary.
      provider.syncSessionsToIndex?.([{
        id: sessionId,
        title: 'Fatal transient session',
        provider: 'claude-code',
        workspaceId: '/fatal-repo',
        messageCount: 1,
        updatedAt: 2,
        createdAt: 1,
        messages: [{
          sessionId,
          source: 'claude-code',
          direction: 'input',
          content: 'sync this message',
        }],
      }], { syncMessages: true });

      await vi.waitFor(() => expect(PendingMetadataWebSocket.instances).toHaveLength(2));
      const transientSocket = PendingMetadataWebSocket.instances[1];
      transientSocket.open();
      await vi.waitFor(() => expect(
        transientSocket.send.mock.calls.map(([payload]) => JSON.parse(payload)),
      ).toContainEqual(expect.objectContaining({ type: 'appendMessage' })));

      // The real transport is OPEN and its post-append completion delay is
      // pending. A server storage-limit response must retire both that replay
      // and the primary's pre-socket JWT intent immediately.
      transientSocket.onmessage?.({ data: JSON.stringify({
        type: 'error', code: 'storage_limit_exceeded', message: 'limit',
      }) } as MessageEvent);
      expect(transientSocket.close).toHaveBeenCalledTimes(1);

      releasePrimaryJwt(jwtFor('fatal-user'));
      await suspendedPrimary;
      expect(PendingMetadataWebSocket.instances).toHaveLength(2);
      expect(provider.isConnected(sessionId)).toBe(false);

      // The externally visible fatal refusal remains authoritative: an explicit
      // retry cannot acquire a JWT or allocate a replacement session transport.
      await provider.connect(sessionId);
      expect(getJwt).toHaveBeenCalledTimes(3);
      expect(PendingMetadataWebSocket.instances).toHaveLength(2);

      // The pre-fatal onopen continuation was sleeping for 500ms. It must not
      // re-open, re-subscribe, or otherwise reverse the fatal retirement.
      await vi.advanceTimersByTimeAsync(500);
      expect(provider.isConnected(sessionId)).toBe(false);
      expect(getJwt).toHaveBeenCalledTimes(3);
      expect(PendingMetadataWebSocket.instances).toHaveLength(2);
      provider.disconnectAll();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('fences late same-session socket callbacks to their exact connection generation', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('WebSocket', PendingMetadataWebSocket);
      const encryptionKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
      );
      const getJwt = vi.fn(async () => jwtFor('socket-user'));
      const provider = createCollabV3Sync({
        serverUrl: 'wss://sync.example.test', orgId: 'socket-org',
        userId: 'socket-user', getJwt, encryptionKey,
      });
      await Promise.resolve();
      await Promise.resolve();
      const indexSocket = PendingMetadataWebSocket.instances[0];
      indexSocket.open();

      const connectA = provider.connect('same-session');
      await Promise.resolve();
      await Promise.resolve();
      const socketA = PendingMetadataWebSocket.instances[1];
      const lateOpenA = socketA.onopen!;
      const lateCloseA = socketA.onclose!;
      const lateErrorA = socketA.onerror!;
      const lateMessageA = socketA.onmessage!;
      socketA.open();
      await connectA;
      socketA.send.mockClear();

      provider.disconnect('same-session');
      const connectB = provider.connect('same-session');
      await Promise.resolve();
      await Promise.resolve();
      const socketB = PendingMetadataWebSocket.instances[2];
      socketB.open();
      await connectB;
      expect(provider.isConnected('same-session')).toBe(true);
      expect(socketB.send).toHaveBeenCalledTimes(1);

      // Native callbacks retained before disconnect(A) are delivered after B
      // owns the same ID. None may status-mark/delete B, send on A, process an
      // A message under B listeners, or authenticate/create another socket.
      lateOpenA(new Event('open'));
      lateErrorA(new Event('error'));
      lateMessageA({ data: JSON.stringify({
        type: 'error', code: 'late-a', message: 'must not reach B',
      }) } as MessageEvent);
      lateCloseA({ code: 1006, reason: 'late-a', wasClean: false } as CloseEvent);
      await vi.advanceTimersByTimeAsync(20_000);

      expect(provider.isConnected('same-session')).toBe(true);
      expect(provider.getStatus('same-session')).toMatchObject({
        connected: true, error: null,
      });
      expect(socketA.send).not.toHaveBeenCalled();
      expect(socketB.send).toHaveBeenCalledTimes(1);
      expect(PendingMetadataWebSocket.instances).toHaveLength(3);
      expect(getJwt).toHaveBeenCalledTimes(3);
      provider.disconnectAll();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
