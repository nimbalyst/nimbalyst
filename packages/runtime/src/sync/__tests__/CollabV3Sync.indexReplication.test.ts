// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asPersonalJwt, asPersonalMemberId } from '../../auth/jwtScopes';

import { createCollabV3Sync } from '../CollabV3Sync';

/**
 * Desktop client for the v2 bounded index protocol: bootstrap pages establish
 * coverage, a cursor drives deltas, and a partial mirror is never handed to
 * reconciliation (which republishes anything the server appears to be missing).
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

function jwtFor(subject: string): string {
  const payload = btoa(JSON.stringify({ sub: subject }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

function sentOfType(socket: FakeWebSocket, type: string): Array<Record<string, any>> {
  return socket.send.mock.calls
    .map(([payload]) => JSON.parse(payload as string))
    .filter((message) => message.type === type);
}

/** Waits for the (index + 1)-th page request the client has sent. */
async function pageRequest(socket: FakeWebSocket, index: number): Promise<Record<string, any>> {
  await vi.waitFor(() => expect(sentOfType(socket, 'indexPageRequest').length).toBeGreaterThan(index));
  return sentOfType(socket, 'indexPageRequest')[index];
}

function sessionEntry(sessionId: string, over: Record<string, any> = {}) {
  return {
    sessionId,
    provider: 'claude-code',
    messageCount: 0,
    lastMessageAt: 1_000,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

const sessionChange = (id: string, revision: number, over: Record<string, any> = {}) => ({
  entity: 'session',
  id,
  revision,
  deleted: false,
  session: sessionEntry(id, over),
});

const deleteChange = (id: string, revision: number) => ({
  entity: 'session' as const,
  id,
  revision,
  deleted: true,
});

/** `id` is the ENCRYPTED project id, and the payload must carry the same one. */
const projectChange = (encryptedProjectId: string, revision: number) => ({
  entity: 'project',
  id: encryptedProjectId,
  revision,
  deleted: false,
  project: {
    encryptedProjectId,
    projectIdIv: 'aXYtYmFzZTY0',
    encryptedName: 'bmFtZQ==',
    nameIv: 'aXYtYmFzZTY0',
    sessionCount: 1,
    lastActivityAt: 1_000,
    syncEnabled: true,
  },
});

function pageResponse(requestId: string, over: Record<string, any>) {
  return {
    type: 'indexPageResponse',
    protocolVersion: 2,
    requestId,
    mode: 'bootstrap',
    entries: [],
    complete: false,
    ...over,
  };
}

async function createConnectedProvider(encryptionKey?: CryptoKey) {
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
  return { provider, indexSocket };
}

describe('CollabV3 v2 index replication client', () => {
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

  it('bootstraps across pages, then syncs deltas from the committed cursor', async () => {
    const { provider, indexSocket } = await createConnectedProvider();

    const first = provider.fetchIndex!();
    const req1 = await pageRequest(indexSocket, 0);
    expect(req1).toMatchObject({ protocolVersion: 2, mode: 'bootstrap' });
    expect(req1.requestId).toBeTruthy();
    expect(req1.pageToken).toBeUndefined();

    indexSocket.receive(pageResponse(req1.requestId, {
      entries: [sessionChange('s1', 1), projectChange('/project', 2)],
      nextPageToken: 'page-2',
    }));

    const req2 = await pageRequest(indexSocket, 1);
    expect(req2.pageToken).toBe('page-2');
    indexSocket.receive(pageResponse(req2.requestId, {
      entries: [sessionChange('s2', 3)],
      complete: true,
      cursor: 3,
    }));

    const bootstrapped = await first;
    expect(bootstrapped.sessions.map((s) => s.sessionId).sort()).toEqual(['s1', 's2']);
    expect(bootstrapped.projects).toHaveLength(1);
    // Legacy full-index request must not also fire.
    expect(sentOfType(indexSocket, 'indexSyncRequest')).toHaveLength(0);

    const second = provider.fetchIndex!();
    const req3 = await pageRequest(indexSocket, 2);
    expect(req3).toMatchObject({ mode: 'delta', sinceRevision: 3 });
    indexSocket.receive(pageResponse(req3.requestId, {
      mode: 'delta',
      entries: [deleteChange('s1', 4), sessionChange('s3', 5)],
      cursor: 5,
      complete: true,
    }));

    const afterDelta = await second;
    // The merged mirror is returned whole: the delta page is not the answer.
    expect(afterDelta.sessions.map((s) => s.sessionId).sort()).toEqual(['s2', 's3']);
    provider.disconnectAll();
  });

  it('decrypts session fields carried by a v2 page', async () => {
    const encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const seal = async (plaintext: string) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        encryptionKey,
        new TextEncoder().encode(plaintext),
      );
      const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
      return { value: b64(new Uint8Array(sealed)), iv: b64(iv) };
    };
    const title = await seal('Secret session');
    const projectId = await seal('/project');

    const { provider, indexSocket } = await createConnectedProvider(encryptionKey);
    const fetching = provider.fetchIndex!();
    const req = await pageRequest(indexSocket, 0);
    indexSocket.receive(pageResponse(req.requestId, {
      entries: [sessionChange('s1', 1, {
        encryptedTitle: title.value,
        titleIv: title.iv,
        encryptedProjectId: projectId.value,
        projectIdIv: projectId.iv,
      })],
      complete: true,
      cursor: 1,
    }));

    const result = await fetching;
    expect(result.sessions[0]).toMatchObject({
      sessionId: 's1',
      title: 'Secret session',
      projectId: '/project',
    });
    expect(provider.getCachedIndexEntry?.('s1')?.title).toBe('Secret session');
    provider.disconnectAll();
  });

  it('fails the fetch rather than returning a partial mirror', async () => {
    const { provider, indexSocket } = await createConnectedProvider();

    const fetching = provider.fetchIndex!();
    const req = await pageRequest(indexSocket, 0);
    // Page ends with neither a continuation token nor completion.
    indexSocket.receive(pageResponse(req.requestId, { entries: [sessionChange('s1', 1)] }));

    await expect(fetching).rejects.toThrow();
    // Reconciliation treats absence as "republish everything", so a partial
    // mirror must never be dressed up as a legacy full index either.
    expect(sentOfType(indexSocket, 'indexSyncRequest')).toHaveLength(0);
    provider.disconnectAll();
  });

  it('falls back to the legacy full index when the server rejects v2', async () => {
    const { provider, indexSocket } = await createConnectedProvider();

    const fetching = provider.fetchIndex!();
    const req = await pageRequest(indexSocket, 0);
    expect(req.mode).toBe('bootstrap');
    indexSocket.receive({ type: 'error', code: 'unknown_message_type', message: 'indexPageRequest' });

    await vi.waitFor(() => expect(sentOfType(indexSocket, 'indexSyncRequest')).toHaveLength(1));
    indexSocket.receive({
      type: 'indexSyncResponse',
      sessions: [sessionEntry('legacy-1')],
      projects: [],
    });
    const legacy = await fetching;
    expect(legacy.sessions.map((s) => s.sessionId)).toEqual(['legacy-1']);

    // Capability is latched: no second v2 probe on this connection.
    const again = provider.fetchIndex!();
    await vi.waitFor(() => expect(sentOfType(indexSocket, 'indexSyncRequest')).toHaveLength(2));
    expect(sentOfType(indexSocket, 'indexPageRequest')).toHaveLength(1);
    indexSocket.receive({ type: 'indexSyncResponse', sessions: [], projects: [] });
    await again;
    provider.disconnectAll();
  });

  it('fails the page on an undecryptable row instead of skipping past it', async () => {
    const encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const { provider, indexSocket } = await createConnectedProvider(encryptionKey);

    const fetching = provider.fetchIndex!();
    const req = await pageRequest(indexSocket, 0);
    indexSocket.receive(pageResponse(req.requestId, {
      entries: [sessionChange('s1', 1, {
        // Written under a different key: ciphertext we cannot read.
        encryptedTitle: 'bm90LXJlYWxseS1lbmNyeXB0ZWQ=',
        titleIv: 'YWJjZGVmZ2hpams=',
      })],
      complete: true,
      cursor: 1,
    }));

    // Completing this page is what would advance the cursor over the row, so a
    // row we cannot read has to fail the fetch, not be quietly dropped.
    await expect(fetching).rejects.toThrow();
    // And it must not be "cleaned up" server-side the way the legacy path does.
    expect(sentOfType(indexSocket, 'indexDelete')).toHaveLength(0);
    expect(sentOfType(indexSocket, 'indexSyncRequest')).toHaveLength(0);
    provider.disconnectAll();
  });

  it('replays personal state once per connection without touching the index cursor', async () => {
    const { provider, indexSocket } = await createConnectedProvider();

    const fetching = provider.fetchIndex!();
    const req = await pageRequest(indexSocket, 0);
    indexSocket.receive(pageResponse(req.requestId, {
      entries: [sessionChange('s1', 1)],
      complete: true,
      cursor: 1,
    }));

    // v2 servers do not replay read receipts / tracker personal state the way
    // indexSyncRequest did, so the client asks for them explicitly.
    await vi.waitFor(() => expect(sentOfType(indexSocket, 'personalStatePageRequest')).toHaveLength(1));
    const stateReq = sentOfType(indexSocket, 'personalStatePageRequest')[0];
    indexSocket.receive({
      type: 'personalStatePageResponse',
      requestId: stateReq.requestId,
      entries: [],
      complete: true,
    });
    await fetching;

    // Already replayed on this connection: a second fetch does not re-ask.
    const second = provider.fetchIndex!();
    const deltaReq = await pageRequest(indexSocket, 1);
    expect(deltaReq).toMatchObject({ mode: 'delta', sinceRevision: 1 });
    indexSocket.receive(pageResponse(deltaReq.requestId, {
      mode: 'delta',
      entries: [],
      cursor: 1,
      complete: true,
    }));
    await second;
    expect(sentOfType(indexSocket, 'personalStatePageRequest')).toHaveLength(1);
    provider.disconnectAll();
  });

  it('keeps the index mirror usable when the personal state replay is unsupported', async () => {
    const { provider, indexSocket } = await createConnectedProvider();

    const fetching = provider.fetchIndex!();
    const req = await pageRequest(indexSocket, 0);
    indexSocket.receive(pageResponse(req.requestId, {
      entries: [sessionChange('s1', 1)],
      complete: true,
      cursor: 1,
    }));

    await vi.waitFor(() => expect(sentOfType(indexSocket, 'personalStatePageRequest')).toHaveLength(1));
    const stateReq = sentOfType(indexSocket, 'personalStatePageRequest')[0];
    indexSocket.receive({
      type: 'error',
      code: 'unknown_message_type',
      message: 'personalStatePageRequest',
      requestId: stateReq.requestId,
    });

    // Degraded read-receipt replay must not cost us a complete index mirror.
    const result = await fetching;
    expect(result.complete).toBe(true);
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['s1']);
    provider.disconnectAll();
  });

  it('reports coverage, protocol version and server tombstones to the caller', async () => {
    const { provider, indexSocket } = await createConnectedProvider();

    const fetching = provider.fetchIndex!();
    const req = await pageRequest(indexSocket, 0);
    indexSocket.receive(pageResponse(req.requestId, {
      entries: [sessionChange('alive', 1), deleteChange('deleted-elsewhere', 2)],
      complete: true,
      cursor: 2,
    }));
    const stateReq = await vi.waitFor(async () => {
      const requests = sentOfType(indexSocket, 'personalStatePageRequest');
      expect(requests).toHaveLength(1);
      return requests[0];
    });
    indexSocket.receive({ type: 'personalStatePageResponse', requestId: stateReq.requestId, entries: [], complete: true });

    const result = await fetching;
    expect(result.complete).toBe(true);
    expect(result.indexProtocolVersion).toBe(2);
    // Reconciliation republishes sessions the server is missing; a tombstoned
    // one is missing on purpose and must be excluded from that.
    expect(result.deletedSessionIds).toEqual(['deleted-elsewhere']);
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['alive']);
    provider.disconnectAll();
  });

  it('clears a tombstone only once the server confirms the recreated row', async () => {
    const encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const { provider, indexSocket } = await createConnectedProvider(encryptionKey);

    const fetching = provider.fetchIndex!();
    const req = await pageRequest(indexSocket, 0);
    indexSocket.receive(pageResponse(req.requestId, {
      entries: [deleteChange('recreated', 1)],
      complete: true,
      cursor: 1,
    }));
    expect((await fetching).deletedSessionIds).toEqual(['recreated']);

    // The user recreates that session id locally and it publishes normally.
    provider.syncSessionsToIndex?.([{
      id: 'recreated',
      title: 'Back again',
      provider: 'claude-code',
      workspaceId: '/workspace',
      messageCount: 0,
      updatedAt: 5_000,
      createdAt: 5_000,
    }]);
    await vi.waitFor(() => expect(sentOfType(indexSocket, 'indexUpdate')).toHaveLength(1));

    // A refused send must not erase deletion evidence or poison an unrelated
    // page request. Correlate the refusal to this session/activity version.
    const second = provider.fetchIndex!();
    const deltaReq = await pageRequest(indexSocket, 1);
    indexSocket.receive({ type: 'indexSessionExpired', sessionId: 'recreated', activityAt: 5000 });
    indexSocket.receive(pageResponse(deltaReq.requestId, { mode: 'delta', entries: [], cursor: 1, complete: true }));
    expect((await second).deletedSessionIds).toEqual(['recreated']);
    const resumed = { id: 'recreated', title: 'Back again', provider: 'claude-code', workspaceId: '/workspace', messageCount: 0, updatedAt: 5000, createdAt: 5000 };
    await provider.syncSessionsToIndex!([resumed]);
    expect(sentOfType(indexSocket, 'indexUpdate')).toHaveLength(1);
    await provider.syncSessionsToIndex!([{ ...resumed, updatedAt: 5001 }]);
    await vi.waitFor(() => expect(sentOfType(indexSocket, 'indexUpdate')).toHaveLength(2));
    const third = provider.fetchIndex!();
    const accepted = await pageRequest(indexSocket, 2);
    indexSocket.receive(pageResponse(accepted.requestId, {
      mode: 'delta', entries: [{ entity: 'session', id: 'recreated', revision: 2, deleted: false, session: sentOfType(indexSocket, 'indexUpdate')[1].session }], cursor: 2, complete: true,
    }));
    expect((await third).deletedSessionIds).toEqual([]);
    provider.disconnectAll();
  });

  it('acts on a hint that arrived while the terminal bootstrap page was still being applied', async () => {
    const encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const seal = async (plaintext: string) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        encryptionKey,
        new TextEncoder().encode(plaintext),
      );
      const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
      return { value: b64(new Uint8Array(sealed)), iv: b64(iv) };
    };
    const title = await seal('Slow to decrypt');

    const { provider, indexSocket } = await createConnectedProvider(encryptionKey);
    const fetching = provider.fetchIndex!();
    const req = await pageRequest(indexSocket, 0);

    // Hold the terminal page's decryption open. Everything between the response
    // arriving and the mirror being marked complete is a window where a hint
    // cannot be delta-synced yet.
    let releaseDecrypt: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseDecrypt = resolve; });
    const realDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let decryptCalls = 0;
    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args: any[]) => {
      decryptCalls++;
      if (decryptCalls === 1) await held;
      return realDecrypt(args[0], args[1], args[2]);
    });

    indexSocket.receive(pageResponse(req.requestId, {
      entries: [sessionChange('s1', 1, { encryptedTitle: title.value, titleIv: title.iv })],
      complete: true,
      cursor: 1,
    }));
    await vi.waitFor(() => expect(decryptCalls).toBeGreaterThan(0));

    // The server mutates something. Under the old "drop hints while incomplete"
    // rule this hint vanished and nothing replayed it until an unrelated
    // mutation produced another one.
    indexSocket.receive({ type: 'indexChangesAvailable', revision: 9 });
    indexSocket.receive({ type: 'indexChangesAvailable', revision: 9 });

    releaseDecrypt();
    await fetching;
    decryptSpy.mockRestore();

    // The hint is honoured once coverage exists -- and the two identical hints
    // coalesce into a single catch-up drain.
    const deltaReq = await pageRequest(indexSocket, 1);
    expect(deltaReq).toMatchObject({ mode: 'delta', sinceRevision: 1 });
    indexSocket.receive(pageResponse(deltaReq.requestId, {
      mode: 'delta',
      entries: [sessionChange('s2', 9)],
      cursor: 9,
      complete: true,
    }));

    await vi.waitFor(() => expect(provider.getCachedIndexEntry?.('s2')).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sentOfType(indexSocket, 'indexPageRequest')).toHaveLength(2);
    provider.disconnectAll();
  });

  // A row this client cannot make sense of must fail the page, never be
  // skipped: completing the page is what advances the cursor over it, so a
  // silent skip is a row the mirror claims coverage for and never received.
  describe('page contract violations fail the page', () => {
    const cases: Array<{ name: string; entry: Record<string, any> }> = [
      {
        name: 'a file whose payload identity does not match the change id',
        entry: { entity: 'file', id: 'doc-1', revision: 3, deleted: false, file: { docId: 'doc-2' } },
      },
      {
        name: 'a file change with no payload at all',
        entry: { entity: 'file', id: 'doc-1', revision: 3, deleted: false },
      },
      {
        name: 'an unknown entity',
        entry: { entity: 'workspace', id: 'w-1', revision: 3, deleted: false },
      },
      {
        name: 'a session whose payload is for another session',
        entry: { entity: 'session', id: 's1', revision: 3, deleted: false, session: sessionEntry('s2') },
      },
      {
        name: 'a change carrying two payloads',
        entry: { entity: 'session', id: 's1', revision: 3, deleted: false, session: sessionEntry('s1'), file: { docId: 's1' } },
      },
      {
        name: 'a tombstone that also carries a payload',
        entry: { entity: 'session', id: 's1', revision: 3, deleted: true, session: sessionEntry('s1') },
      },
      {
        name: 'a negative revision',
        entry: { entity: 'session', id: 's1', revision: -1, deleted: false, session: sessionEntry('s1') },
      },
      {
        name: 'a non-integer revision',
        entry: { entity: 'session', id: 's1', revision: 1.5, deleted: false, session: sessionEntry('s1') },
      },
    ];

    for (const { name, entry } of cases) {
      it(`rejects ${name}`, async () => {
        const { provider, indexSocket } = await createConnectedProvider();
        const fetching = provider.fetchIndex!();
        const req = await pageRequest(indexSocket, 0);
        indexSocket.receive(pageResponse(req.requestId, {
          entries: [sessionChange('good', 1), entry],
          complete: true,
          cursor: 9,
        }));

        await expect(fetching).rejects.toThrow();
        // Nothing from a rejected page reaches the local cache either.
        expect(provider.getCachedIndexEntry?.('good')).toBeUndefined();
        provider.disconnectAll();
      });
    }

    it('rejects a page whose envelope does not match the request', async () => {
      const { provider, indexSocket } = await createConnectedProvider();
      const fetching = provider.fetchIndex!();
      const req = await pageRequest(indexSocket, 0);
      // Answering a bootstrap request with a delta page would merge rows under
      // the wrong coverage rules.
      indexSocket.receive(pageResponse(req.requestId, {
        mode: 'delta',
        entries: [],
        complete: true,
        cursor: 1,
      }));

      await expect(fetching).rejects.toThrow(/mode/i);
      provider.disconnectAll();
    });

    it('rejects a terminal page whose cursor is not a usable revision', async () => {
      const { provider, indexSocket } = await createConnectedProvider();
      const fetching = provider.fetchIndex!();
      const req = await pageRequest(indexSocket, 0);
      indexSocket.receive(pageResponse(req.requestId, {
        entries: [sessionChange('s1', 1)],
        complete: true,
        cursor: -3,
      }));

      await expect(fetching).rejects.toThrow(/cursor/i);
      provider.disconnectAll();
    });
  });

  it('keys project rows by the encrypted wire id while exposing the decrypted path', async () => {
    const encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const seal = async (plaintext: string) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        encryptionKey,
        new TextEncoder().encode(plaintext),
      );
      const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
      return { value: b64(new Uint8Array(sealed)), iv: b64(iv) };
    };
    const path = await seal('/Users/dev/real-project');
    const name = await seal('real-project');
    // The server's IndexChange.id for a project is the ENCRYPTED project_id
    // from project_index -- not the local path the client decrypts it to.
    const wireId = path.value;
    const projectRow = (revision: number, over: Record<string, any> = {}) => ({
      entity: 'project',
      id: wireId,
      revision,
      deleted: false,
      project: {
        encryptedProjectId: path.value,
        projectIdIv: path.iv,
        encryptedName: name.value,
        nameIv: name.iv,
        sessionCount: 3,
        lastActivityAt: 1_000,
        syncEnabled: true,
      },
      ...over,
    });

    const { provider, indexSocket } = await createConnectedProvider(encryptionKey);
    const fetching = provider.fetchIndex!();
    const req = await pageRequest(indexSocket, 0);
    indexSocket.receive(pageResponse(req.requestId, {
      // Same project twice: identity is the wire id, so this is one row, not two.
      entries: [projectRow(1), projectRow(2, { project: { ...projectRow(2).project, sessionCount: 4 } })],
      complete: true,
      cursor: 2,
    }));

    const bootstrapped = await fetching;
    expect(bootstrapped.projects).toHaveLength(1);
    // Identity is the ciphertext; the value handed to callers is decrypted.
    expect(bootstrapped.projects[0]).toMatchObject({
      projectId: '/Users/dev/real-project',
      name: 'real-project',
      sessionCount: 4,
    });

    // A tombstone arrives under that same encrypted id. Keying the mirror by
    // the decrypted path would leave the row live here.
    const second = provider.fetchIndex!();
    const deltaReq = await pageRequest(indexSocket, 1);
    indexSocket.receive(pageResponse(deltaReq.requestId, {
      mode: 'delta',
      entries: [{ entity: 'project', id: wireId, revision: 5, deleted: true }],
      cursor: 5,
      complete: true,
    }));

    expect((await second).projects).toHaveLength(0);
    provider.disconnectAll();
  });

  it('omits an unknown message count so the server keeps the one it has', async () => {
    // Publishing requires a key (projectId is always encrypted on the wire).
    const encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const { provider, indexSocket } = await createConnectedProvider(encryptionKey);

    const fetching = provider.fetchIndex!();
    const req = await pageRequest(indexSocket, 0);
    indexSocket.receive(pageResponse(req.requestId, {
      entries: [sessionChange('s1', 1, { messageCount: 17 })],
      complete: true,
      cursor: 1,
    }));
    await fetching;

    // The bulk reconciliation query does not count messages. Publishing its
    // placeholder zero used to overwrite the server's real 17.
    provider.syncSessionsToIndex?.([{
      id: 's1',
      title: 'Metadata-only publish',
      provider: 'claude-code',
      workspaceId: '/workspace',
      messageCount: 0,
      messageCountKnown: false,
      updatedAt: 9_000,
      createdAt: 1_000,
      isArchived: true,
    }]);
    await vi.waitFor(() => expect(sentOfType(indexSocket, 'indexUpdate')).toHaveLength(1));

    const published = sentOfType(indexSocket, 'indexUpdate')[0].session;
    expect('messageCount' in published).toBe(false);
    expect(published.isArchived).toBe(true);
    // The local cache keeps the server's count rather than the placeholder.
    expect(provider.getCachedIndexEntry?.('s1')?.messageCount).toBe(17);
    provider.disconnectAll();
  });

  it('ignores a response whose requestId does not match the in-flight request', async () => {
    const { provider, indexSocket } = await createConnectedProvider();

    const fetching = provider.fetchIndex!();
    const req = await pageRequest(indexSocket, 0);
    indexSocket.receive(pageResponse('some-other-request', {
      entries: [sessionChange('ghost', 99)],
      complete: true,
      cursor: 99,
    }));
    // Still waiting: nothing was applied from the foreign response.
    expect(sentOfType(indexSocket, 'indexPageRequest')).toHaveLength(1);

    indexSocket.receive(pageResponse(req.requestId, {
      entries: [sessionChange('s1', 1)],
      complete: true,
      cursor: 1,
    }));
    const result = await fetching;
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['s1']);
    provider.disconnectAll();
  });

  it('treats indexChangesAvailable as a hint: polls a delta and delivers live callbacks', async () => {
    const { provider, indexSocket } = await createConnectedProvider();

    const fetching = provider.fetchIndex!();
    const req = await pageRequest(indexSocket, 0);
    indexSocket.receive(pageResponse(req.requestId, {
      entries: [sessionChange('s1', 1)],
      complete: true,
      cursor: 1,
    }));
    await fetching;

    const seen: Array<{ sessionId: string; title: string | undefined }> = [];
    provider.onIndexChange?.((sessionId, entry) => seen.push({ sessionId, title: entry.title }));

    indexSocket.receive({ type: 'indexChangesAvailable', revision: 7 });

    const deltaReq = await pageRequest(indexSocket, 1);
    expect(deltaReq).toMatchObject({ mode: 'delta', sinceRevision: 1 });
    indexSocket.receive(pageResponse(deltaReq.requestId, {
      mode: 'delta',
      entries: [sessionChange('s2', 7)],
      cursor: 7,
      complete: true,
    }));

    await vi.waitFor(() => expect(seen.map((s) => s.sessionId)).toContain('s2'));
    // The hint carried revision 7 but only the applied page moved the cursor.
    const next = provider.fetchIndex!();
    const afterHint = await pageRequest(indexSocket, 2);
    expect(afterHint.sinceRevision).toBe(7);
    indexSocket.receive(pageResponse(afterHint.requestId, { mode: 'delta', entries: [], cursor: 7, complete: true }));
    await next;
    provider.disconnectAll();
  });
});

/**
 * GitHub #1117: a desktop whose sync key cannot read the shared index used to
 * delete every unreadable row from the server and then republish its own copies
 * under the failing key. The personal seed is per-install, so "re-sync with the
 * correct key" never happened -- the other devices' index just vanished.
 *
 * The legacy full-index path now fails closed like the v2 page path, and a
 * provider-owned write gate keeps a device that cannot read the index from
 * publishing replacement ciphertext until a complete read succeeds.
 */
describe('CollabV3 personal index safety on the legacy full-index path', () => {
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

  const generateKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

  async function sealWith(key: CryptoKey, plaintext: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
    const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
    return { value: b64(new Uint8Array(sealed)), iv: b64(iv) };
  }

  /** A row this device can read in full. */
  async function readableRow(key: CryptoKey, sessionId: string, title: string) {
    const sealedTitle = await sealWith(key, title);
    const sealedProject = await sealWith(key, '/project');
    return sessionEntry(sessionId, {
      encryptedTitle: sealedTitle.value,
      titleIv: sealedTitle.iv,
      encryptedProjectId: sealedProject.value,
      projectIdIv: sealedProject.iv,
    });
  }

  const localSession = (id = 'local-1') => ({
    id,
    title: 'Local session',
    provider: 'claude-code',
    mode: 'agent',
    workspaceId: '/workspace',
    messageCount: 0,
    updatedAt: 1_000,
    createdAt: 1_000,
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  /** Drives one legacy full-index round trip and answers it with `sessions`. */
  async function legacyFetch(provider: ReturnType<typeof createCollabV3Sync>, indexSocket: FakeWebSocket, sessions: unknown[]) {
    // Once the capability is latched to legacy, the request goes out
    // synchronously inside fetchIndex, so count before calling it.
    const before = sentOfType(indexSocket, 'indexSyncRequest').length;
    const fetching = provider.fetchIndex!();
    if (before === 0 && sentOfType(indexSocket, 'indexPageRequest').length === 0) {
      const req = await pageRequest(indexSocket, 0);
      indexSocket.receive({ type: 'error', code: 'unknown_message_type', message: 'indexPageRequest', requestId: req.requestId });
    }
    await vi.waitFor(() => expect(sentOfType(indexSocket, 'indexSyncRequest')).toHaveLength(before + 1));
    indexSocket.receive({ type: 'indexSyncResponse', sessions, projects: [] });
    return fetching;
  }

  it('fails the fetch on an undecryptable row, sends no indexDelete, and keeps the last good cache', async () => {
    const mine = await generateKey();
    const theirs = await generateKey();
    const { provider, indexSocket } = await createConnectedProvider(mine);

    const readable = await readableRow(mine, 'mine-1', 'Readable');
    await legacyFetch(provider, indexSocket, [readable]);
    expect(provider.getCachedIndexEntry?.('mine-1')?.title).toBe('Readable');

    // Another device's row, written under a key this install never had.
    const foreign = await readableRow(theirs, 'theirs-1', 'Another device');
    await expect(legacyFetch(provider, indexSocket, [readable, foreign])).rejects.toThrow(/decrypt/i);

    expect(sentOfType(indexSocket, 'indexDelete')).toHaveLength(0);
    expect(provider.getCachedIndexEntry?.('mine-1')?.title).toBe('Readable');
    expect(provider.getCachedIndexEntry?.('theirs-1')).toBeUndefined();
    provider.disconnectAll();
  });

  it('withholds personal-sync writes until a complete read succeeds and after a wrong-key read', async () => {
    const mine = await generateKey();
    const theirs = await generateKey();
    const { provider, indexSocket } = await createConnectedProvider(mine);
    const gate = () => provider.getPersonalSyncWriteGate!();

    // Nothing has proven this key yet, so nothing is published.
    expect(gate().state).toBe('unverified');
    provider.syncSessionsToIndex?.([localSession()]);
    await settle();
    expect(sentOfType(indexSocket, 'indexUpdate')).toHaveLength(0);

    const foreign = await readableRow(theirs, 'theirs-1', 'Another device');
    await expect(legacyFetch(provider, indexSocket, [foreign])).rejects.toThrow();
    expect(gate()).toMatchObject({ state: 'blocked', reason: 'decryption-failed' });
    provider.syncSessionsToIndex?.([localSession()]);
    await settle();
    expect(sentOfType(indexSocket, 'indexUpdate')).toHaveLength(0);

    // A clean, complete read under this key is the only thing that opens the gate.
    await legacyFetch(provider, indexSocket, [await readableRow(mine, 'mine-1', 'Readable')]);
    expect(gate().state).toBe('verified');
    provider.syncSessionsToIndex?.([localSession()]);
    await vi.waitFor(() => expect(sentOfType(indexSocket, 'indexUpdate')).toHaveLength(1));
    provider.disconnectAll();
  });

  it('ignores an undecryptable index broadcast, preserves the cached row, and blocks writes', async () => {
    const mine = await generateKey();
    const theirs = await generateKey();
    const { provider, indexSocket } = await createConnectedProvider(mine);
    await legacyFetch(provider, indexSocket, [await readableRow(mine, 'mine-1', 'Readable')]);

    const seen = vi.fn();
    provider.onIndexChange?.(seen);
    const overwrite = await readableRow(theirs, 'mine-1', 'Overwritten elsewhere');
    indexSocket.receive({ type: 'indexBroadcast', session: overwrite, fromConnectionId: 'other-device' });
    await settle();

    expect(provider.getCachedIndexEntry?.('mine-1')?.title).toBe('Readable');
    expect(seen).not.toHaveBeenCalled();
    expect(provider.getPersonalSyncWriteGate!()).toMatchObject({ state: 'blocked', reason: 'decryption-failed' });
    provider.disconnectAll();
  });

  it('stops writing when the server requires an update, and a clean read does not lift that', async () => {
    const mine = await generateKey();
    const { provider, indexSocket } = await createConnectedProvider(mine);
    await legacyFetch(provider, indexSocket, [await readableRow(mine, 'mine-1', 'Readable')]);
    expect(provider.getPersonalSyncWriteGate!().state).toBe('verified');

    indexSocket.receive({ type: 'error', code: 'update_required', message: 'Nimbalyst 9.9.9 or newer is required for session sync' });
    expect(provider.getPersonalSyncWriteGate!()).toMatchObject({ state: 'blocked', reason: 'update-required' });
    provider.syncSessionsToIndex?.([localSession()]);
    await settle();
    expect(sentOfType(indexSocket, 'indexUpdate')).toHaveLength(0);

    await legacyFetch(provider, indexSocket, [await readableRow(mine, 'mine-1', 'Readable')]);
    expect(provider.getPersonalSyncWriteGate!().state).toBe('blocked');
    provider.disconnectAll();
  });
});
