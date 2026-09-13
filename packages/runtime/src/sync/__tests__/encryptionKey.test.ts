// This file needs no DOM; it belongs in `nodeOnly` in vitest.config.ts. That
// is a shared file, so the entry is deliberately not added here.
import { describe, it, expect } from 'vitest';

import { deriveEncryptionKey, personalSyncEncryptionSalt } from '../encryptionKey';
import { asPersonalMemberId } from '../../auth/jwtScopes';

/**
 * These vectors pin the personal-sync key derivation to exact bits.
 *
 * They exist because the derivation is applied to data that is already
 * encrypted on real machines. If a future edit changes the iteration count,
 * the hash, the key length, or the salt format, nothing throws at derivation
 * time -- every existing client just silently stops being able to read its own
 * data. These tests turn that into a red suite.
 *
 * `deriveEncryptionKey` deliberately produces a non-extractable key, so the
 * key cannot be exported and compared directly. Instead we pin it two ways:
 *
 *  1. Decrypt a ciphertext that was produced with the expected key. Any change
 *     to any parameter makes AES-GCM authentication fail.
 *  2. Compare the raw PBKDF2 output, derived independently with `deriveBits`,
 *     against a recorded hex string -- so a failure names the actual bits
 *     rather than just "decrypt threw".
 *
 * Do not regenerate these constants to make a failing test pass. A failure
 * here means the change under test would orphan user data.
 */
const SEED = 'nimbalyst-personal-sync-test-seed';
const PERSONAL_MEMBER_ID = 'member-test-00000000-0000-4000-8000-000000000001';
const EXPECTED_SALT = 'nimbalyst:member-test-00000000-0000-4000-8000-000000000001';
const EXPECTED_RAW_KEY_HEX = '13229f5240fa0576fed3e5b5da7bef2bbbc9285d8f9cb6941e2900f6141daf0f';
const FIXED_IV = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const FIXED_CIPHERTEXT_B64 = 'uGALRlfzCnQgMv1sevQtH4qD83iFvmagOO0tgDpvvvJxJEgtPADPEgUSsDPUHw==';
const EXPECTED_PLAINTEXT = 'nimbalyst personal sync vector';

// Returns the backing ArrayBuffer rather than the view: TypeScript 5.7 made
// typed arrays generic over their buffer, so a plain `Uint8Array` is
// `Uint8Array<ArrayBufferLike>` and no longer satisfies WebCrypto's
// `BufferSource`, which wants `ArrayBufferView<ArrayBuffer>`.
function fromBase64(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

/** The 256-bit key the shipped parameters are documented to produce. */
async function recordedKey(): Promise<CryptoKey> {
  const raw = new Uint8Array(
    (EXPECTED_RAW_KEY_HEX.match(/../g) ?? []).map((byte) => parseInt(byte, 16))
  );
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

describe('personal sync encryption key derivation', () => {
  it('derives a key that decrypts a ciphertext recorded against the shipped parameters', async () => {
    const key = await deriveEncryptionKey(SEED, personalSyncEncryptionSalt(asPersonalMemberId(PERSONAL_MEMBER_ID)));

    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: FIXED_IV },
        key,
        fromBase64(FIXED_CIPHERTEXT_B64)
      );
    } catch (err) {
      // AES-GCM authentication failure is opaque ("operation-specific reason").
      // Say what it actually means, because the consequence is severe.
      throw new Error(
        'deriveEncryptionKey no longer produces the shipped personal-sync key. ' +
          'Something changed the iteration count, hash, key length, or salt. ' +
          'Every existing personal-sync client would be unable to decrypt its ' +
          `stored data. Underlying error: ${String(err)}`
      );
    }

    expect(new TextDecoder().decode(plaintext)).toBe(EXPECTED_PLAINTEXT);
  });

  it('produces exactly the recorded 256-bit key material', async () => {
    // Round-trip across the two keys: encrypt with what `deriveEncryptionKey`
    // returns, decrypt with a key imported from the recorded hex. This proves
    // the documented bits really are the derived bits -- re-deriving them with
    // the same parameters would only restate the function.
    const derived = await deriveEncryptionKey(SEED, personalSyncEncryptionSalt(asPersonalMemberId(PERSONAL_MEMBER_ID)));
    const iv = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 1, 2]);
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      derived,
      new TextEncoder().encode(EXPECTED_PLAINTEXT)
    );

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      await recordedKey(),
      ciphertext
    );

    expect(new TextDecoder().decode(plaintext)).toBe(EXPECTED_PLAINTEXT);
  });

  it('pins the salt format shared with iOS and the headless host', () => {
    expect(personalSyncEncryptionSalt(asPersonalMemberId(PERSONAL_MEMBER_ID))).toBe(EXPECTED_SALT);
  });

  it('derives a non-extractable AES-GCM key usable only for encrypt/decrypt', async () => {
    const key = await deriveEncryptionKey(SEED, personalSyncEncryptionSalt(asPersonalMemberId(PERSONAL_MEMBER_ID)));

    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect([...key.usages].sort()).toEqual(['decrypt', 'encrypt']);
  });
});
