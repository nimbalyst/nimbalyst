/**
 * Multi-epoch legacy-key read path for server-managed document CONTENT (NIM-959).
 *
 * When a team rotated its org key while still legacy-e2e and later migrated to
 * server-managed, a pre-migration row (AES ciphertext, non-empty iv) may have
 * been written under a now-archived epoch. The doc INDEX path already tries
 * every candidate epoch (NIM-906/910); the doc CONTENT path must too, or the
 * body decrypts to nothing and the document opens blank.
 *
 * decryptFromWire must try each provided legacy key until one succeeds, and
 * still throw (so the per-payload catch skips just that row) when none match.
 */

import { describe, expect, it } from 'vitest';
import { DocumentSyncProvider } from '../DocumentSync';

async function createAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
}

async function wireEncrypt(data: Uint8Array, key: CryptoKey): Promise<{ encrypted: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data as BufferSource);
  return {
    encrypted: Buffer.from(new Uint8Array(ct)).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
  };
}

function serverManagedProvider(legacyDocumentKeys?: CryptoKey[]): DocumentSyncProvider {
  return new DocumentSyncProvider({
    serverUrl: 'ws://example.test',
    getJwt: async () => 'token',
    orgId: 'org-1',
    keyCustody: 'server-managed',
    legacyDocumentKeys,
    userId: 'user-1',
    documentId: 'doc-1',
    reviewGateEnabled: false,
  });
}

describe('DocumentSync server-managed multi-epoch legacy keys (NIM-959)', () => {
  it('decrypts a legacy row written under an archived (non-current) epoch', async () => {
    const currentKey = await createAesKey();
    const archivedKey = await createAesKey();
    // Snapshot was written under the OLD epoch; current epoch is listed first.
    const provider = serverManagedProvider([currentKey, archivedKey]);
    const plain = new Uint8Array([42, 7, 13, 99]);
    const { encrypted, iv } = await wireEncrypt(plain, archivedKey);
    expect(iv).not.toBe('');

    const out: Uint8Array = await (provider as any).decryptFromWire(encrypted, iv);
    expect(Array.from(out)).toEqual(Array.from(plain));
    provider.destroy();
  });

  it('throws when the row matches none of the candidate epochs', async () => {
    const provider = serverManagedProvider([await createAesKey(), await createAesKey()]);
    const strayKey = await createAesKey();
    const { encrypted, iv } = await wireEncrypt(new Uint8Array([1, 1, 1]), strayKey);
    await expect((provider as any).decryptFromWire(encrypted, iv)).rejects.toThrow();
    provider.destroy();
  });
});
