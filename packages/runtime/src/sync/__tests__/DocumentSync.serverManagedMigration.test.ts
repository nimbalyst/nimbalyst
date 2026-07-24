/**
 * Server-managed key migration read path (NIM-878).
 *
 * When a team migrates legacy-e2e -> server-managed, rows written before the
 * flip stay AES-ciphertext (the collabv3 DocumentRoom passes them through with
 * their original iv; only DEK-fingerprinted rows are server-decrypted to
 * plaintext with an empty-iv sentinel). The client must:
 *   - base64-passthrough rows with an empty iv (server plaintext), and
 *   - AES-decrypt rows with a non-empty iv using the legacy org key.
 * And a single undecodable row must be skipped, never blank the whole doc.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DocumentSyncProvider } from '../DocumentSync';

async function createAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
}

/** Encrypt bytes the way the legacy wire did: AES-256-GCM, base64 ciphertext + iv. */
async function wireEncrypt(data: Uint8Array, key: CryptoKey): Promise<{ encrypted: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data as BufferSource);
  return {
    encrypted: Buffer.from(new Uint8Array(ct)).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
  };
}

function b64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

function serverManagedProvider(legacyDocumentKey?: CryptoKey): DocumentSyncProvider {
  return new DocumentSyncProvider({
    serverUrl: 'ws://example.test',
    getJwt: async () => 'token',
    orgId: 'org-1',
    keyCustody: 'server-managed',
    legacyDocumentKey,
    userId: 'user-1',
    documentId: 'doc-1',
    reviewGateEnabled: false,
  });
}

describe('DocumentSync server-managed migration read path', () => {
  it('passes through plaintext rows with the empty-iv sentinel', async () => {
    const provider = serverManagedProvider();
    const plain = new Uint8Array([10, 20, 30, 40]);
    const out: Uint8Array = await (provider as any).decryptFromWire(b64(plain), '');
    expect(Array.from(out)).toEqual(Array.from(plain));
    provider.destroy();
  });

  it('AES-decrypts legacy ciphertext rows (non-empty iv) with the legacy org key', async () => {
    const legacyKey = await createAesKey();
    const provider = serverManagedProvider(legacyKey);
    const plain = new Uint8Array([1, 2, 3, 4, 5]);
    const { encrypted, iv } = await wireEncrypt(plain, legacyKey);
    expect(iv).not.toBe('');
    const out: Uint8Array = await (provider as any).decryptFromWire(encrypted, iv);
    expect(Array.from(out)).toEqual(Array.from(plain));
    provider.destroy();
  });

  it('throws (so the caller can skip) on a legacy row when no legacy key is available', async () => {
    const provider = serverManagedProvider(/* no legacy key */);
    const legacyKey = await createAesKey();
    const { encrypted, iv } = await wireEncrypt(new Uint8Array([9, 9, 9]), legacyKey);
    await expect((provider as any).decryptFromWire(encrypted, iv)).rejects.toThrow();
    provider.destroy();
  });

  it('applies a valid plaintext broadcast (server-managed) to the Y.Doc', async () => {
    const provider = serverManagedProvider();
    const tmp = new Y.Doc();
    tmp.getMap('m').set('k', 'v');
    const update = Y.encodeStateAsUpdate(tmp);

    await (provider as any).handleUpdateBroadcast({
      type: 'docUpdateBroadcast',
      senderId: 'someone-else',
      sequence: 1,
      encryptedUpdate: b64(update),
      iv: '',
    });

    expect(provider.getYDoc().getMap('m').get('k')).toBe('v');
    provider.destroy();
  });

  it('skips an undecodable legacy broadcast without throwing or corrupting the doc', async () => {
    const provider = serverManagedProvider(/* no legacy key -> legacy row unreadable */);
    const legacyKey = await createAesKey();
    const { encrypted, iv } = await wireEncrypt(new Uint8Array([7, 7, 7, 7]), legacyKey);

    // Must NOT throw -- one bad row can't blank the body.
    await expect((provider as any).handleUpdateBroadcast({
      type: 'docUpdateBroadcast',
      senderId: 'someone-else',
      sequence: 5,
      encryptedUpdate: encrypted,
      iv,
    })).resolves.toBeUndefined();

    // Doc untouched by the skipped row.
    expect(provider.getYDoc().getMap('m').size).toBe(0);
    provider.destroy();
  });
});
