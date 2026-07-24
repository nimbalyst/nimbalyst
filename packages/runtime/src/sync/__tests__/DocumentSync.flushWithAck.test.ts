import { describe, expect, it } from 'vitest';
import { DocumentSyncProvider } from '../DocumentSync';

/**
 * Phase 0 (collab-foundation-external-editors): the seed a user sees locally
 * must reach the server before the provider tears down. `flushWithAck` is the
 * durability guarantee — it resolves only after the server acknowledges
 * persistence (docUpdateAck), NOT merely after the socket write. The old
 * `flushLocalState` fired-and-forgot, which is the race the mindmap seed
 * data-loss rode in on.
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

/** Minimal OPEN WebSocket stand-in capturing sent frames. */
function createFakeWebSocket(): { readyState: number; send: (d: string) => void; close: () => void; sent: any[] } {
  const sent: any[] = [];
  return {
    readyState: 1, // WebSocket.OPEN
    send: (data: string) => sent.push(JSON.parse(data)),
    close: () => {},
    sent,
  };
}

async function waitUntil(pred: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('DocumentSyncProvider.flushWithAck', () => {
  it('resolves true immediately for an empty doc (nothing to persist)', async () => {
    const provider = createProvider(await createDocumentKey());
    await expect(provider.flushWithAck(30)).resolves.toBe(true);
    provider.destroy();
  });

  it('resolves only after the server acknowledges the seed update', async () => {
    const provider = createProvider(await createDocumentKey());

    // Seed some content while "offline" so the encoded state exceeds the
    // empty-doc guard without the update observer racing a second replay.
    provider.getYDoc().getMap('m').set('k', 'v');

    const fakeWs = createFakeWebSocket();
    (provider as any).ws = fakeWs;
    (provider as any).synced = true;

    let resolved = false;
    const flushPromise = provider.flushWithAck(1000).then((ok) => {
      resolved = true;
      return ok;
    });

    // The docUpdate must go out on the wire...
    await waitUntil(() => fakeWs.sent.some((m) => m.type === 'docUpdate'));
    // ...but flushWithAck must NOT resolve until the server acks it.
    expect(resolved).toBe(false);

    const docUpdate = fakeWs.sent.find((m) => m.type === 'docUpdate');
    (provider as any).handleUpdateAck({
      type: 'docUpdateAck',
      clientUpdateId: docUpdate.clientUpdateId,
      sequence: 1,
    });

    await expect(flushPromise).resolves.toBe(true);
    provider.destroy();
  });

  it('resolves false when the server never acks (the seed data-loss race)', async () => {
    const provider = createProvider(await createDocumentKey());
    const fakeWs = createFakeWebSocket();
    (provider as any).ws = fakeWs;
    (provider as any).synced = true;

    provider.getYDoc().getMap('m').set('k', 'v');

    // No ack ever arrives -> flush reports failure so the host can warn/retry
    // instead of tearing down and losing the seed.
    await expect(provider.flushWithAck(40)).resolves.toBe(false);
    provider.destroy();
  });
});
