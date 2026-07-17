/**
 * Unit tests for `TrackerEnvelopeCrypto`.
 *
 * Focus is on the `itemId` AAD binding added to close the splice-attack
 * gap: the server (or a malicious DO) must not be able to take a valid
 * ciphertext for item X and rewrite the plaintext envelope `itemId` to
 * point at item Y. AES-GCM authentication over the AAD makes that
 * fail-closed.
 *
 * `issueNumber` / `issueKey` are NOT in the AAD because the server
 * allocates them on first write, after the client has encrypted. Splice
 * protection for those fields is provided by the projection (which prefers
 * the decrypted payload's echoes), not by AAD.
 */

import { describe, expect, it } from 'vitest';
import { webcrypto } from 'crypto';
import {
  encryptTrackerPayload,
  decryptTrackerEnvelope,
  encryptTrackerNavigationPayload,
  decryptTrackerNavigationEnvelope,
} from '../TrackerEnvelopeCrypto';
import type {
  EncryptedTrackerItemEnvelope,
  TrackerItemPayload,
  EncryptedTrackerNavigationEnvelope,
} from '../trackerProtocol';

async function genKey(): Promise<CryptoKey> {
  return webcrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  ) as Promise<CryptoKey>;
}

function payload(itemId: string, overrides: Partial<TrackerItemPayload> = {}): TrackerItemPayload {
  return {
    itemId,
    primaryType: 'task',
    archived: false,
    bodyVersion: 0,
    fields: { title: 'hello' },
    labels: {},
    comments: [],
    system: {},
    ...overrides,
  };
}

function envelopeOf(
  itemId: string,
  encryptedPayload: string,
  iv: string,
  extras: Partial<EncryptedTrackerItemEnvelope> = {},
): EncryptedTrackerItemEnvelope {
  return {
    itemId,
    syncId: 1,
    encryptedPayload,
    iv,
    updatedAt: 0,
    deletedAt: null,
    orgKeyFingerprint: 'fp',
    ...extras,
  };
}

describe('TrackerEnvelopeCrypto itemId AAD binding', () => {
  it('round-trips when envelope.itemId matches the AAD bound at encrypt', async () => {
    const key = await genKey();
    const { encryptedPayload, iv } = await encryptTrackerPayload(payload('A'), key, 'A');

    const decrypted = await decryptTrackerEnvelope(
      envelopeOf('A', encryptedPayload, iv),
      key,
    );

    expect(decrypted.itemId).toBe('A');
    expect((decrypted.fields as { title?: string }).title).toBe('hello');
  });

  it('fails AES-GCM auth when itemId is spliced after encrypt', async () => {
    const key = await genKey();
    const { encryptedPayload, iv } = await encryptTrackerPayload(payload('original'), key, 'original');

    // Attacker rewrites the plaintext envelope.itemId. AAD bound at
    // encrypt time was 'original'; decrypt sees 'spliced'.
    const spliced = envelopeOf('spliced', encryptedPayload, iv);

    await expect(decryptTrackerEnvelope(spliced, key)).rejects.toMatchObject({
      name: 'OperationError',
    });
  });

  it('still decrypts when only issueNumber / issueKey vary between encrypt and decrypt', async () => {
    // Server allocates issueNumber/issueKey AFTER the client encrypts on
    // first write, so AAD intentionally excludes them. Verify that a
    // server-side mutation of those fields does NOT break decrypt.
    const key = await genKey();
    const { encryptedPayload, iv } = await encryptTrackerPayload(payload('A'), key, 'A');

    const decrypted = await decryptTrackerEnvelope(
      envelopeOf('A', encryptedPayload, iv, { issueNumber: 99, issueKey: 'OTHER-99' }),
      key,
    );

    expect(decrypted.itemId).toBe('A');
  });

  it('rejects tombstones in decryptTrackerEnvelope (programmer error)', async () => {
    const key = await genKey();
    const tombstone = envelopeOf('A', '', '', { encryptedPayload: null, iv: undefined });
    await expect(decryptTrackerEnvelope(tombstone, key)).rejects.toThrow(/tombstone/);
  });
});

describe('TrackerEnvelopeCrypto navigation entryId AAD binding', () => {
  it('round-trips and rejects ciphertext spliced onto another entry id', async () => {
    const key = await genKey();
    const payloadJson = JSON.stringify({ entryId: 'folder:a', kind: 'folder', folderId: 'a', name: 'A', sortKey: 'a0' });
    const encrypted = await encryptTrackerNavigationPayload(payloadJson, key, 'folder:a');
    const envelope: EncryptedTrackerNavigationEnvelope = {
      entryId: 'folder:a',
      syncId: 1,
      encryptedPayload: encrypted.encryptedPayload,
      iv: encrypted.iv,
      updatedAt: 0,
      deletedAt: null,
      orgKeyFingerprint: 'fp',
    };
    await expect(decryptTrackerNavigationEnvelope(envelope, key)).resolves.toBe(payloadJson);
    await expect(decryptTrackerNavigationEnvelope({ ...envelope, entryId: 'folder:b' }, key)).rejects.toMatchObject({
      name: 'OperationError',
    });
  });
});
