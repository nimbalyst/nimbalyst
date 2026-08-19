// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { asTeamJwt, asTeamMemberId } from '../../auth/jwtScopes';
import { DocumentSyncProvider } from '../DocumentSync';
import type { DocumentSyncStatus } from '../documentSyncTypes';

async function createDocumentKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  ) as Promise<CryptoKey>;
}

function createProvider(documentKey: CryptoKey): DocumentSyncProvider {
  return new DocumentSyncProvider({
    serverUrl: 'ws://example.test',
    getJwt: async () => asTeamJwt('token'),
    orgId: 'org-1',
    teamMemberId: asTeamMemberId('user-1'),
    documentId: 'doc-1',
  });
}

describe('DocumentSyncProvider.waitForPendingWrites', () => {
  it('returns immediately when there are no pending writes', async () => {
    const provider = createProvider(await createDocumentKey());

    await expect(provider.waitForPendingWrites(50)).resolves.toBe(true);

    provider.destroy();
  });

  it('waits for the inflight replay to finish', async () => {
    const provider = createProvider(await createDocumentKey());

    (provider as any).inflightPendingUpdate = new Uint8Array([1, 2, 3]);
    (provider as any).replayingClientUpdateId = 'pending-123';

    const waitPromise = provider.waitForPendingWrites(500);

    setTimeout(() => {
      (provider as any).finishReplayingPendingUpdate();
    }, 0);

    await expect(waitPromise).resolves.toBe(true);

    provider.destroy();
  });

  it('times out when the pending replay never settles', async () => {
    const provider = createProvider(await createDocumentKey());

    (provider as any).queuedPendingUpdate = new Uint8Array([4, 5, 6]);

    await expect(provider.waitForPendingWrites(25)).resolves.toBe(false);

    provider.destroy();
  });
});

describe('DocumentSyncProvider write rejection without a local replica', () => {
  // The browser console configures no replica, so a refused write used to fall
  // straight out of handleWriteRejection: the pending update stayed inflight,
  // the replay-ack timer fired, the socket was force-closed, and the client
  // reconnected and replayed the same rejected update forever -- with nothing
  // ever telling the user the document was read-only.
  it('drops the refused update instead of replaying it forever', async () => {
    const statuses: DocumentSyncStatus[] = [];
    const provider = new DocumentSyncProvider({
      serverUrl: 'ws://example.test',
      getJwt: async () => asTeamJwt('token'),
      orgId: 'org-1',
      teamMemberId: asTeamMemberId('user-1'),
      documentId: 'doc-1',
      onStatusChange: (status) => statuses.push(status),
    });
    const internals = provider as any;
    expect(internals.config.replica).toBeUndefined();

    internals.inflightPendingUpdate = new Uint8Array([1, 2, 3]);
    internals.replayingClientUpdateId = 'refused-update';
    internals.scheduleReplayAckTimeout('refused-update');
    const scheduleReconnect = vi.spyOn(internals, 'scheduleReconnect');

    await internals.handleWriteRejection('document_read_only', 'refused-update');

    expect(internals.inflightPendingUpdate).toBeNull();
    expect(internals.replayingClientUpdateId).toBeNull();
    expect(internals.replayAckTimer).toBeNull();
    expect(scheduleReconnect).not.toHaveBeenCalled();
    expect(statuses).toContain('error');

    provider.destroy();
  });

  it('leaves a retryable rejection queued for another attempt', async () => {
    const provider = new DocumentSyncProvider({
      serverUrl: 'ws://example.test',
      getJwt: async () => asTeamJwt('token'),
      orgId: 'org-1',
      teamMemberId: asTeamMemberId('user-1'),
      documentId: 'doc-1',
    });
    const internals = provider as any;

    internals.inflightPendingUpdate = new Uint8Array([1, 2, 3]);
    internals.replayingClientUpdateId = 'transient-update';

    await internals.handleWriteRejection('write_barrier', 'transient-update');

    expect(internals.queuedPendingUpdate).not.toBeNull();

    provider.destroy();
  });
});
