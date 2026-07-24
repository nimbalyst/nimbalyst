import { describe, expect, it } from 'vitest';
import { DocumentSyncProvider } from '../DocumentSync';

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
