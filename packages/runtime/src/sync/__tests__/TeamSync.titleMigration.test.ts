/**
 * Doc-index TITLE read path across the legacy-e2e -> server-managed migration
 * (NIM-906 / NIM-910).
 *
 * When a team migrates, title rows written before the flip stay AES-ciphertext
 * on the server (the TeamRoom passes them through with their original non-empty
 * iv; only DEK-fingerprinted rows are server-decrypted to plaintext with an
 * empty-iv sentinel). The org key may also have been ROTATED while the team was
 * legacy-e2e, so titles can span multiple org-key EPOCHS. The client must:
 *   - pass through rows with an empty iv (server plaintext),
 *   - AES-decrypt rows with a non-empty iv by trying EACH retained epoch key,
 *   - surface a row no epoch can decrypt as `decryptFailed` (locked), never as
 *     raw base64, and never blanking the rest of the list,
 *   - and a client that can decrypt re-registers titles as plaintext (backfill)
 *     AND verifies the writes persisted server-side (not just that they sent).
 */

import { describe, expect, it } from 'vitest';
import { TeamSyncProvider } from '../TeamSync';
import type { TeamSyncConfig } from '../teamSyncTypes';

async function createAesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
}

/** Encrypt a title the way the legacy wire did: AES-256-GCM, base64 ct + iv. */
async function wireEncryptTitle(title: string, key: CryptoKey): Promise<{ encryptedTitle: string; titleIv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(title) as BufferSource);
  return {
    encryptedTitle: Buffer.from(new Uint8Array(ct)).toString('base64'),
    titleIv: Buffer.from(iv).toString('base64'),
  };
}

function serverManagedProvider(legacyOrgKeys?: CryptoKey[]): TeamSyncProvider {
  const config: TeamSyncConfig = {
    serverUrl: 'ws://example.test',
    getJwt: async () => 'token',
    orgId: 'org-1',
    userId: 'user-1',
    keyCustody: 'server-managed',
    orgKeyFingerprint: null,
    legacyOrgKeys,
  };
  return new TeamSyncProvider(config);
}

function encEntry(documentId: string, encryptedTitle: string, titleIv: string) {
  return {
    documentId,
    encryptedTitle,
    titleIv,
    documentType: 'markdown',
    createdBy: 'user-1',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('TeamSync doc-index title server-managed migration read path', () => {
  it('passes through plaintext titles with the empty-iv sentinel', async () => {
    const provider = serverManagedProvider();
    const entry = await (provider as any).decryptEntry(encEntry('doc-1', 'My Plain Title', ''));
    expect(entry.title).toBe('My Plain Title');
    expect(entry.decryptFailed).toBeFalsy();
    provider.destroy();
  });

  it('decrypts a legacy title by trying each org-key epoch (rotation support)', async () => {
    const wrongKey = await createAesKey();
    const rightKey = await createAesKey();
    // Title encrypted under the SECOND epoch; the wrong (current) key is tried first.
    const provider = serverManagedProvider([wrongKey, rightKey]);
    const { encryptedTitle, titleIv } = await wireEncryptTitle('Folder/Real Doc', rightKey);
    const entry = await (provider as any).decryptEntry(encEntry('doc-2', encryptedTitle, titleIv));
    expect(entry.title).toBe('Folder/Real Doc');
    expect(entry.decryptFailed).toBeFalsy();
    provider.destroy();
  });

  it('throws (so the caller marks it locked) when NO epoch can decrypt', async () => {
    const onlyKey = await createAesKey();
    const otherKey = await createAesKey();
    const provider = serverManagedProvider([onlyKey]); // does not hold the encrypting key
    const { encryptedTitle, titleIv } = await wireEncryptTitle('secret', otherKey);
    await expect((provider as any).decryptEntry(encEntry('doc-3', encryptedTitle, titleIv))).rejects.toThrow();
    provider.destroy();
  });

  it('marks an undecryptable legacy title as decryptFailed without raw base64 or blanking siblings', async () => {
    const otherKey = await createAesKey();
    const provider = serverManagedProvider([await createAesKey()]); // wrong epoch only

    const legacy = await wireEncryptTitle('unreadable', otherKey);
    const docs = await (provider as any).decryptDocuments([
      encEntry('plain-1', 'Visible Plain', ''),
      encEntry('legacy-1', legacy.encryptedTitle, legacy.titleIv),
    ]);

    const plain = docs.find((d: any) => d.documentId === 'plain-1');
    const locked = docs.find((d: any) => d.documentId === 'legacy-1');
    expect(plain.title).toBe('Visible Plain');
    expect(plain.decryptFailed).toBeFalsy();
    expect(locked.decryptFailed).toBe(true);
    expect(locked.title).not.toBe(legacy.encryptedTitle); // never the raw ciphertext
    provider.destroy();
  });

  it('backfill re-registers recovered titles as PLAINTEXT and CONFIRMS server persistence', async () => {
    const key = await createAesKey();
    const provider = serverManagedProvider([key]);
    (provider as any).legacyTitleBackfillRan = true; // disable the fire-and-forget auto-heal race

    const sent: any[] = [];
    (provider as any).send = (msg: any) => {
      sent.push(msg);
      // Simulate the server: on the verification re-sync (docIndexSync), report
      // the re-registered doc as server-plaintext (empty iv) => persisted.
      if (msg.type === 'docIndexSync') {
        void (provider as any).handleDocIndexSyncResponse({
          type: 'docIndexSyncResponse',
          documents: [
            encEntry('plain-1', 'Already Plain', ''),
            encEntry('legacy-1', 'Notes/Recovered', ''), // now plaintext on the server
          ],
        });
      }
    };

    const legacy = await wireEncryptTitle('Notes/Recovered', key);
    await (provider as any).handleDocIndexSyncResponse({
      type: 'docIndexSyncResponse',
      documents: [
        encEntry('plain-1', 'Already Plain', ''),
        encEntry('legacy-1', legacy.encryptedTitle, legacy.titleIv),
      ],
    });

    const res = await provider.backfillLegacyTitles();
    expect(res.sent).toBe(1);
    expect(res.confirmed).toBe(1);

    const updates = sent.filter((m) => m.type === 'docIndexUpdate');
    expect(updates).toHaveLength(1);
    expect(updates[0].documentId).toBe('legacy-1');
    expect(updates[0].encryptedTitle).toBe('Notes/Recovered'); // plaintext
    expect(updates[0].titleIv).toBe(''); // empty-iv sentinel => server DEK-encrypts at rest
    provider.destroy();
  });

  it('backfill re-queues writes the server did NOT persist (e.g. rotation lock)', async () => {
    const key = await createAesKey();
    const provider = serverManagedProvider([key]);
    (provider as any).legacyTitleBackfillRan = true;

    const sent: any[] = [];
    const legacy = await wireEncryptTitle('Notes/Stuck', key);
    (provider as any).send = (msg: any) => {
      sent.push(msg);
      // Simulate the server REJECTING the write (rotation lock): the re-sync
      // still reports the row as legacy ciphertext (non-empty iv).
      if (msg.type === 'docIndexSync') {
        void (provider as any).handleDocIndexSyncResponse({
          type: 'docIndexSyncResponse',
          documents: [
            encEntry('legacy-1', legacy.encryptedTitle, legacy.titleIv),
          ],
        });
      }
    };

    await (provider as any).handleDocIndexSyncResponse({
      type: 'docIndexSyncResponse',
      documents: [encEntry('legacy-1', legacy.encryptedTitle, legacy.titleIv)],
    });

    const res = await provider.backfillLegacyTitles();
    expect(res.sent).toBe(1);
    expect(res.confirmed).toBe(0); // not persisted
    // Unconfirmed doc is re-queued for a later retry.
    expect((provider as any).legacyTitleDocIds.has('legacy-1')).toBe(true);
    provider.destroy();
  });
});
