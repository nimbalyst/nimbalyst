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
