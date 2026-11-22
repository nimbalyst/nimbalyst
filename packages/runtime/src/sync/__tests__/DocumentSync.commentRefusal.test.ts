// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asTeamJwt, asTeamMemberId } from '../../auth/jwtScopes';
import { DocumentSyncProvider, type DocumentAccessVerdict } from '../DocumentSync';

/**
 * A commenter's update that changes more than the comment threads is refused
 * (`document_comment_update_refused`) and the room closes 4009. Every later
 * update from that Y.Doc's client depends on the refused structs, so a
 * reconnect that resends them is refused forever and every later comment is
 * lost. The provider must stop for good and tell the host, which reopens with
 * a fresh Y.Doc.
 */

type Listener = (event: any) => void;

function fakeSocketFactory() {
  const sockets: Array<{ listeners: Map<string, Listener[]>; sent: any[]; emit: (type: string, event?: any) => void }> = [];
  const create = () => {
    const listeners = new Map<string, Listener[]>();
    const socket = {
      readyState: 1,
      sent: [] as any[],
      listeners,
      addEventListener: (type: string, fn: Listener) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
      removeEventListener: () => {},
      send: (data: string) => socket.sent.push(JSON.parse(data)),
      close: () => {},
      emit: (type: string, event: any = {}) => {
        for (const fn of listeners.get(type) ?? []) fn(event);
      },
    };
    sockets.push(socket);
    return socket as unknown as WebSocket;
  };
  return { sockets, create };
}

function createProvider(createWebSocket: (url: string) => WebSocket) {
  return new DocumentSyncProvider({
    serverUrl: 'wss://sync.test',
    orgId: 'org-1',
    teamMemberId: asTeamMemberId('member-1'),
    documentId: 'doc-1',
    getJwt: async () => asTeamJwt('jwt'),
    createWebSocket,
  });
}

describe('DocumentSync commenter refusal', () => {
  let provider: DocumentSyncProvider | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    provider?.destroy();
    provider = null;
    vi.useRealTimers();
  });

  it('reports the room verdict to listeners, including one that subscribes late', async () => {
    const { create } = fakeSocketFactory();
    provider = createProvider(create);
    const seen: DocumentAccessVerdict[] = [];
    provider.onAccessVerdict((verdict) => seen.push(verdict));
    await (provider as any).handleSyncResponse({
      type: 'docSyncResponse', updates: [], hasMore: false, cursor: 0, canWrite: false, canComment: true,
    });
    expect(seen).toEqual([{ canWrite: false, canComment: true }]);

    const late: DocumentAccessVerdict[] = [];
    provider.onAccessVerdict((verdict) => late.push(verdict));
    expect(late).toEqual([{ canWrite: false, canComment: true }]);
  });

  it('turns a mid-session demotion signal into a verdict and keeps the socket', async () => {
    const { sockets, create } = fakeSocketFactory();
    provider = createProvider(create);
    const seen: DocumentAccessVerdict[] = [];
    provider.onAccessVerdict((verdict) => seen.push(verdict));
    await provider.connect();
    sockets[0].emit('message', {
      data: JSON.stringify({ type: 'error', code: 'document_comment_only', message: 'demoted' }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([{ canWrite: false, canComment: true }]);
    expect(provider.getServerAccessVerdict()).toEqual({ canWrite: false, canComment: true });
    expect(provider.isCommentUpdateRefused()).toBe(false);

    sockets[0].emit('message', {
      data: JSON.stringify({ type: 'error', code: 'document_read_only', message: 'demoted again' }),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toEqual({ canWrite: false, canComment: false });
    expect(sockets).toHaveLength(1);
  });

  it('flips back to writable on document_writable, once, with no reconnect', async () => {
    const { sockets, create } = fakeSocketFactory();
    provider = createProvider(create);
    const seen: DocumentAccessVerdict[] = [];
    provider.onAccessVerdict((verdict) => seen.push(verdict));
    await provider.connect();
    const send = (code: string) => sockets[0].emit('message', {
      data: JSON.stringify({ type: 'error', code, message: code }),
    });

    send('document_comment_only');
    await vi.advanceTimersByTimeAsync(0);
    send('document_writable');
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([
      { canWrite: false, canComment: true },
      { canWrite: true, canComment: true },
    ]);

    // Resent after hibernation to a socket that already writes: not news.
    send('document_writable');
    send('document_writable');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen).toHaveLength(2);
    expect(provider.getServerAccessVerdict()).toEqual({ canWrite: true, canComment: true });
    expect(sockets).toHaveLength(1);
    expect(provider.isCommentUpdateRefused()).toBe(false);
  });

  it('stops for good on the refusal: no resend, no reconnect, one notification', async () => {
    const { sockets, create } = fakeSocketFactory();
    provider = createProvider(create);
    const refused = vi.fn();
    provider.onCommentUpdateRefused(refused);

    await provider.connect();
    expect(sockets).toHaveLength(1);
    const socket = sockets[0];
    // A refused body write is in flight, and a later edit is queued behind it.
    (provider as any).inflightPendingUpdate = new Uint8Array([1]);
    (provider as any).queuedPendingUpdate = new Uint8Array([2]);
    (provider as any).replayingClientUpdateId = 'cu-1';

    socket.emit('message', {
      data: JSON.stringify({
        type: 'error', code: 'document_comment_update_refused', message: 'refused', clientUpdateId: 'cu-1',
      }),
    });
    socket.emit('close', { code: 4009, reason: 'comment-update-refused' });
    await vi.advanceTimersByTimeAsync(0);

    expect(refused).toHaveBeenCalledTimes(1);
    expect(provider.isCommentUpdateRefused()).toBe(true);
    expect(provider.getStatus()).toBe('error');
    expect((provider as any).inflightPendingUpdate).toBeNull();
    expect((provider as any).queuedPendingUpdate).toBeNull();

    // Nothing reconnects it: not backoff, not an explicit connect or reconnectNow.
    await vi.advanceTimersByTimeAsync(120_000);
    await provider.connect();
    provider.reconnectNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    expect(socket.sent.filter((m) => m.type === 'docUpdate')).toEqual([]);

    // A listener that subscribes after the fact still learns about it.
    const late = vi.fn();
    provider.onCommentUpdateRefused(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('treats a bare 4009 close as the refusal', async () => {
    const { sockets, create } = fakeSocketFactory();
    provider = createProvider(create);
    const refused = vi.fn();
    provider.onCommentUpdateRefused(refused);
    await provider.connect();
    sockets[0].emit('close', { code: 4009, reason: '' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
  });

  it('still reconnects after an ordinary close', async () => {
    const { sockets, create } = fakeSocketFactory();
    provider = createProvider(create);
    await provider.connect();
    sockets[0].emit('close', { code: 1006, reason: '' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets.length).toBeGreaterThan(1);
    expect(provider.isCommentUpdateRefused()).toBe(false);
  });
});
