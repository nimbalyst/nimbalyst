// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectSyncProvider } from '../ProjectSyncProvider';
import type { PersonalJwt, PersonalMemberId } from '../../auth/jwtScopes';

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket;
  readyState = FakeSocket.OPEN;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeSocket.last = this; }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}

afterEach(() => vi.unstubAllGlobals());

const connectProvider = async () => {
  vi.stubGlobal('WebSocket', FakeSocket);
  const encryptionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const provider = new ProjectSyncProvider({
    serverUrl: 'https://sync.test',
    orgId: 'org',
    personalMemberId: 'member' as PersonalMemberId,
    encryptionKey,
    getJwt: async () => 'jwt' as PersonalJwt,
  });
  await provider.connect('proj', async () => []);
  return { provider, ws: FakeSocket.last };
};
const file = (syncId: string) => ({ syncId, content: 'x', relativePath: `${syncId}.md`, title: syncId, lastModifiedAt: 1 });
const syncResponse = (extra: object) => ({ data: JSON.stringify({
  type: 'projectSyncResponse', updatedFiles: [], newFiles: [], yjsUpdates: [], needFromClient: [], deletedSyncIds: [], ...extra,
}) });

it('resolves a push with what the server acked, and settles an unanswered one from the next sync response', async () => {
  const { provider, ws } = await connectProvider();
  ws.onmessage!(syncResponse({ pushAck: true }));

  const batch = provider.pushFileBatch('proj', [file('a'), file('b'), file('c')]);
  await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
  const { requestId } = ws.sent[0];
  // An ack for some other request must not settle this one.
  ws.onmessage!({ data: JSON.stringify({ type: 'fileContentPushAck', requestId: 'other', stored: [], rejected: [] }) });
  ws.onmessage!({ data: JSON.stringify({
    type: 'fileContentPushAck', requestId, stored: ['a', 'c'],
    rejected: [{ syncId: 'b', code: 'file_too_large', message: 'too big' }],
  }) });
  expect(await batch).toEqual({
    stored: ['a', 'c'], rejected: [{ syncId: 'b', code: 'file_too_large', message: 'too big' }], unconfirmed: [],
  });

  // The socket drops after the push left: it may or may not have landed.
  const single = provider.pushFileContent('proj', 'd', 'x', 'd.md', 'd', 1);
  await vi.waitFor(() => expect(ws.sent).toHaveLength(2));
  const pushedHash = ws.sent[1].contentHash;
  ws.onclose!();
  expect(await single).toEqual({ stored: [], rejected: [], unconfirmed: ['d'] });

  // The next connection asks, and only a matching server hash confirms it.
  const responses: any[] = [];
  provider.onSyncResponse((_projectId, response) => responses.push(response));
  provider.disconnectAll();
  await provider.connect('proj', async () => []);
  const next = FakeSocket.last;
  next.onopen!();
  await vi.waitFor(() => expect(next.sent[0]).toMatchObject({ type: 'projectSyncRequest', confirm: ['d'] }));
  next.onmessage!(syncResponse({ pushAck: true, pushConfirmations: [{ syncId: 'd', contentHash: pushedHash }] }));
  await vi.waitFor(() => expect(responses).toHaveLength(1));
  expect(responses[0].confirmedPushes).toEqual([{ syncId: 'd', contentHash: pushedHash, lastModifiedAt: 1 }]);
  provider.disconnectAll();
});

it('treats a push to a server that does not advertise acks as stored, including one sent before it answered', async () => {
  const { provider, ws } = await connectProvider();
  const early = provider.pushFileContent('proj', 'a', 'x', 'a.md', 'a', 1);
  await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
  ws.onmessage!(syncResponse({}));
  expect(await early).toEqual({ stored: ['a'], rejected: [], unconfirmed: [] });

  expect(await provider.pushFileBatch('proj', [file('b')])).toEqual({ stored: ['b'], rejected: [], unconfirmed: [] });
  expect(ws.sent.map((m) => m.type)).toEqual(['fileContentPush', 'fileContentBatchPush']);
  provider.disconnectAll();
});

const ackLast = (ws: FakeSocket) => {
  const { requestId, files } = ws.sent[ws.sent.length - 1];
  ws.onmessage!({ data: JSON.stringify({ type: 'fileContentPushAck', requestId, stored: files.map((f: any) => f.syncId), rejected: [] }) });
};
const bigFile = (syncId: string) => ({ ...file(syncId), content: 'x'.repeat(600 * 1024) });

it('splits a large push into frames sent one at a time, each after the previous ack', async () => {
  const { provider, ws } = await connectProvider();
  ws.onmessage!(syncResponse({ pushAck: true }));

  // Two 600 KB files cannot share a 1 MB frame.
  const push = provider.pushFileBatch('proj', [bigFile('a'), bigFile('b'), file('c')]);
  await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
  expect(ws.sent[0].files.map((f: any) => f.syncId)).toEqual(['a']);
  ackLast(ws);
  await vi.waitFor(() => expect(ws.sent).toHaveLength(2));
  expect(ws.sent[1].files.map((f: any) => f.syncId)).toEqual(['b', 'c']);
  ackLast(ws);
  expect(await push).toEqual({ stored: ['a', 'b', 'c'], rejected: [], unconfirmed: [] });

  // Small files are capped by count as well.
  const many = provider.pushFileBatch('proj', Array.from({ length: 450 }, (_, i) => file(`f${i}`)));
  const sentBefore = ws.sent.length;
  for (const [i, size] of [200, 200, 50].entries()) {
    await vi.waitFor(() => expect(ws.sent).toHaveLength(sentBefore + i + 1));
    expect(ws.sent[sentBefore + i].files).toHaveLength(size);
    ackLast(ws);
  }
  expect((await many).stored).toHaveLength(450);
  provider.disconnectAll();
});

it('stops a batched push when the socket drops, without queuing the unsent frames for replay', async () => {
  vi.useFakeTimers();
  try {
    const { provider, ws } = await connectProvider();
    ws.onmessage!(syncResponse({ pushAck: true }));

    const push = provider.pushFileBatch('proj', [bigFile('a'), bigFile('b'), bigFile('c')]);
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    ackLast(ws);
    await vi.waitFor(() => expect(ws.sent).toHaveLength(2));
    ws.readyState = 3;
    ws.onclose!();
    expect(await push).toEqual({ stored: ['a'], rejected: [], unconfirmed: ['b', 'c'] });
    expect(ws.sent).toHaveLength(2);

    // The next connection sends only its sync request: no replayed batch, and it
    // asks about the one in-flight frame, not the one that never left.
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(FakeSocket.last).not.toBe(ws));
    const next = FakeSocket.last;
    next.onopen!();
    await vi.waitFor(() => expect(next.sent).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(next.sent).toHaveLength(1);
    expect(next.sent[0]).toMatchObject({ type: 'projectSyncRequest', confirm: ['b'] });
    provider.disconnectAll();
  } finally {
    vi.useRealTimers();
  }
});

it('backs off on a socket that opens and dies before proving healthy, and resets after an ack', async () => {
  vi.useFakeTimers();
  try {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const lastDelay = () => setTimeoutSpy.mock.calls.map(([, ms]) => ms).filter((ms) => ms !== 30_000).pop();
    const { provider, ws } = await connectProvider();
    // Open, die, reconnect: returns the delay the provider waited.
    const dropAndReconnect = async (socket: FakeSocket) => {
      socket.readyState = 3;
      socket.onclose!();
      const delay = lastDelay()!;
      await vi.advanceTimersByTimeAsync(delay);
      await vi.waitFor(() => expect(FakeSocket.last).not.toBe(socket));
      return delay;
    };
    const delays: number[] = [];
    let socket = ws;
    for (let i = 0; i < 3; i++) {
      socket.onopen!();
      await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
      delays.push(await dropAndReconnect(socket));
      socket = FakeSocket.last;
    }
    expect(delays).toEqual([2000, 4000, 8000]);

    // A socket that gets a push acked is healthy: the next drop waits 2s again.
    socket.onopen!();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.onmessage!(syncResponse({ pushAck: true, needFromClient: ['a'] }));
    const push = provider.pushFileBatch('proj', [file('a')]);
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    ackLast(socket);
    await push;
    expect(await dropAndReconnect(socket)).toBe(2000);
    provider.disconnectAll();
  } finally {
    vi.useRealTimers();
  }
});

it('asks the manifest builder for a full rehash only on an explicit resync', async () => {
  vi.stubGlobal('WebSocket', FakeSocket);
  const encryptionKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const provider = new ProjectSyncProvider({
    serverUrl: 'https://sync.test', orgId: 'org', personalMemberId: 'member' as PersonalMemberId,
    encryptionKey, getJwt: async () => 'jwt' as PersonalJwt,
  });
  const builder = vi.fn(async (_opts: { fullRehash: boolean }) => []);
  await provider.connect('proj', builder);
  FakeSocket.last.onopen!();
  await vi.waitFor(() => expect(builder).toHaveBeenCalledTimes(1));
  await provider.resync('proj');
  await provider.resync('proj', { fullRehash: true });
  expect(builder.mock.calls.map(([opts]) => opts.fullRehash)).toEqual([false, false, true]);
  provider.disconnectAll();
});
