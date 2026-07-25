import { describe, expect, it } from 'vitest';
import { DocumentSyncProvider } from '../DocumentSync';

/**
 * Force-replace recovery (backup review HIGH finding 1).
 *
 * The local plaintext backup exists to recover a room whose SERVER Y.Doc became
 * undecryptable. Routine compaction refuses to snapshot such a room (NIM-1519:
 * a snapshot from a client that decoded nothing would bury the unreadable rows
 * for everyone). `forceReplaceServerState` is the deliberate override: after the
 * plaintext backup is applied into the otherwise-empty Y.Doc, it promotes that
 * Y.Doc to the sole authoritative snapshot, discarding the undecodable rows.
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

/** Synced, quiet, no unacked local writes -- the state after restore has
 *  applied the plaintext and its incremental update has been acknowledged. */
function primeForForceReplace(provider: DocumentSyncProvider, fakeWs: ReturnType<typeof createFakeWebSocket>): void {
  (provider as any).ws = fakeWs;
  (provider as any).synced = true;
  (provider as any).lastSeq = 500;
  (provider as any).queuedPendingUpdate = null;
  (provider as any).inflightPendingUpdate = null;
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 1000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('DocumentSync force-replace recovery', () => {
  it('replaces the server state even after skipping undecodable content', async () => {
    const provider = createProvider(await createDocumentKey());
    // Plaintext backup has been applied into the local Y.Doc.
    provider.getYDoc().getMap('m').set('restored', 'content');
    const fakeWs = createFakeWebSocket();
    primeForForceReplace(provider, fakeWs);
    // The server rows this client could not decrypt -- the exact disaster the
    // backup exists to recover. Routine compaction is blocked in this state.
    (provider as any).skippedUndecodablePayload = true;

    const promise = provider.forceReplaceServerState(1000);

    const compact = await waitFor(() => fakeWs.sent.find((m) => m.type === 'docCompact'));
    expect(compact.replacesUpTo).toBe(500);
    expect(typeof compact.encryptedState).toBe('string');

    (provider as any).handleCompactionAck({
      type: 'docCompactAck',
      clientCompactId: compact.clientCompactId,
      accepted: true,
      replacesUpTo: compact.replacesUpTo,
    });

    expect(await promise).toBe(true);
    provider.destroy();
  });

  it('refuses to force-replace the room with an empty Y.Doc', async () => {
    const provider = createProvider(await createDocumentKey());
    const fakeWs = createFakeWebSocket();
    primeForForceReplace(provider, fakeWs);
    (provider as any).skippedUndecodablePayload = true;

    await expect(provider.forceReplaceServerState(1000)).rejects.toThrow(/empty/i);
    expect(fakeWs.sent.some((m) => m.type === 'docCompact')).toBe(false);
    provider.destroy();
  });

  it('resolves false when the server never acknowledges the replacement', async () => {
    const provider = createProvider(await createDocumentKey());
    provider.getYDoc().getMap('m').set('restored', 'content');
    const fakeWs = createFakeWebSocket();
    primeForForceReplace(provider, fakeWs);

    expect(await provider.forceReplaceServerState(30)).toBe(false);
    provider.destroy();
  });

  it('finalizes a fully decoded empty document without using the recovery override', async () => {
    const provider = createProvider(await createDocumentKey());
    const fakeWs = createFakeWebSocket();
    primeForForceReplace(provider, fakeWs);

    const promise = provider.finalizeServerManagedState(1000);
    const compact = await waitFor(() => fakeWs.sent.find((m) => m.type === 'docCompact'));
    expect(compact.replacesUpTo).toBe(500);

    (provider as any).handleCompactionAck({
      type: 'docCompactAck',
      clientCompactId: compact.clientCompactId,
      accepted: true,
      replacesUpTo: compact.replacesUpTo,
    });

    expect(await promise).toBe(true);
    provider.destroy();
  });

  it('refuses to finalize when any server content was undecodable', async () => {
    const provider = createProvider(await createDocumentKey());
    const fakeWs = createFakeWebSocket();
    primeForForceReplace(provider, fakeWs);
    (provider as any).skippedUndecodablePayload = true;

    await expect(provider.finalizeServerManagedState(1000)).rejects.toThrow(/decrypt/i);
    expect(fakeWs.sent.some((m) => m.type === 'docCompact')).toBe(false);
    provider.destroy();
  });
});
