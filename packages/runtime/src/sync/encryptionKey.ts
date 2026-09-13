/**
 * Personal-sync encryption key derivation.
 *
 * This lives in the runtime, not in a host package, because every host that
 * speaks personal sync has to arrive at bit-identical keys: the Electron main
 * process, the headless Node host, and the native iOS client
 * (`packages/ios/NimbalystNative/Sources/Crypto/CryptoManager.swift`, which
 * reimplements the same parameters in CryptoKit and must be kept in step by
 * hand).
 *
 * The parameters below are applied to data that is already encrypted and
 * stored on real machines. Changing the iteration count, the hash, the key
 * length, or a single character of the salt format silently orphans every
 * existing client's data -- nothing fails at derivation time, decryption just
 * starts returning garbage. `__tests__/encryptionKey.test.ts` pins them
 * against fixed vectors so that edit fails loudly instead.
 */

import type { PersonalMemberId } from '../auth/jwtScopes';

/**
 * Derive an encryption key from a passphrase using PBKDF2.
 * This is used for E2E encryption in CollabV3.
 */
export async function deriveEncryptionKey(passphrase: string, salt: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * The salt every host must use for personal sync.
 *
 * Takes the branded `PersonalMemberId` rather than a bare string on purpose.
 * A user has a different member id per org, so passing the active/team member
 * id here derives a different key and silently makes previously-encrypted data
 * undecryptable -- the personal/team mix-up this codebase calls its most
 * repeated sync bug, in the one place where getting it wrong costs data rather
 * than a failed request. The brand makes that a compile error.
 */
export function personalSyncEncryptionSalt(personalMemberId: PersonalMemberId): string {
  return `nimbalyst:${personalMemberId}`;
}
