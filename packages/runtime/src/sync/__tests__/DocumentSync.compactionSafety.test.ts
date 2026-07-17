import { describe, expect, it } from 'vitest';
import { DocumentSyncProvider } from '../DocumentSync';

/**
 * NIM-1519: the compaction elector must never bury content it could not read.
 *
 * `lastSeq` advances even for updates/snapshots skipped as undecodable (the
 * NIM-878 tolerant-skip), so a client that decoded NOTHING can still hit the
 * compaction thresholds, win the election, and send a `docCompact` of its
 * empty Y.Doc with `replacesUpTo = lastSeq`. The server then serves only
 * updates after `replaces_up_to`, hiding (and eventually pruning) every good
 * row below it — including a freshly acked re-upload. Observed live on the
 * shared mindmap room a08e0849 on 2026-07-06.
 */

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
    getJwt: async () => 'token',
    orgId: 'org-1',
    documentKey,
    userId: 'user-1',
    documentId: 'doc-1',
    reviewGateEnabled: false,
  });
}

function createFakeWebSocket(): { readyState: number; send: (d: string) => void; close: () => void; sent: any[] } {
  const sent: any[] = [];
  return {
    readyState: 1, // WebSocket.OPEN
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => {},
    sent,
  };
}

/** Put the provider in a "synced, quiet, past the update threshold" state
 *  where maybeCompact() would normally fire (no remote awareness -> we are
 *  the elector). Local edits made during setup enqueue a pending update that
 *  a fake socket never acks, so clear that queue -- the guards under test are
 *  the undecodable-skip and empty-doc ones, not the pending-writes guard. */
function primeForCompaction(provider: DocumentSyncProvider, fakeWs: ReturnType<typeof createFakeWebSocket>): void {
  (provider as any).ws = fakeWs;
  (provider as any).synced = true;
  (provider as any).lastSeq = 500; // >= COMPACTION_UPDATE_THRESHOLD past lastSnapshotSeq=0
  (provider as any).queuedPendingUpdate = null;
  (provider as any).inflightPendingUpdate = null;
}

describe('DocumentSync compaction safety (NIM-1519)', () => {
  it('still compacts when everything decoded and the doc has content (control)', async () => {
    const provider = createProvider(await createDocumentKey());
    provider.getYDoc().getMap('m').set('k', 'v');
    const fakeWs = createFakeWebSocket();
    primeForCompaction(provider, fakeWs);

    await (provider as any).maybeCompact();

    const compact = fakeWs.sent.find((m) => m.type === 'docCompact');
    expect(compact).toBeDefined();
    expect((provider as any).lastSnapshotSeq).toBe(0);

    (provider as any).handleCompactionAck({
      type: 'docCompactAck',
      clientCompactId: compact.clientCompactId,
      accepted: true,
      replacesUpTo: compact.replacesUpTo,
    });
    expect((provider as any).lastSnapshotSeq).toBe(500);
    provider.destroy();
  });

  it('does not advance snapshot bookkeeping when compaction is rejected', async () => {
    const provider = createProvider(await createDocumentKey());
    provider.getYDoc().getMap('m').set('k', 'v');
    const fakeWs = createFakeWebSocket();
    primeForCompaction(provider, fakeWs);

    await (provider as any).maybeCompact();
    const compact = fakeWs.sent.find((m) => m.type === 'docCompact');
    (provider as any).handleCompactionAck({
      type: 'docCompactAck',
      clientCompactId: compact.clientCompactId,
      accepted: false,
      replacesUpTo: compact.replacesUpTo,
      error: { code: 'invalid_compaction', message: 'rejected' },
    });

    expect((provider as any).lastSnapshotSeq).toBe(0);
    expect((provider as any).pendingCompactionId).toBeNull();
    provider.destroy();
  });

  it('never compacts after skipping an undecodable payload', async () => {
    const provider = createProvider(await createDocumentKey());
    provider.getYDoc().getMap('m').set('k', 'v');
    const fakeWs = createFakeWebSocket();
    primeForCompaction(provider, fakeWs);

    // Simulate what handleSyncResponse does when a snapshot/update fails to
    // decrypt or Y.applyUpdate throws: it skips the payload and records it.
    (provider as any).skippedUndecodablePayload = true;

    await (provider as any).maybeCompact();

    expect(fakeWs.sent.some((m) => m.type === 'docCompact')).toBe(false);
    provider.destroy();
  });

  it('never sends a compaction snapshot of an effectively empty Y.Doc', async () => {
    const provider = createProvider(await createDocumentKey());
    // Doc left empty: lastSeq says the server has 500 rows we did not apply.
    const fakeWs = createFakeWebSocket();
    primeForCompaction(provider, fakeWs);

    await (provider as any).maybeCompact();

    expect(fakeWs.sent.some((m) => m.type === 'docCompact')).toBe(false);
    provider.destroy();
  });
});
