/**
 * Classic node:crypto AES-GCM for personal sync in the Electron main process.
 *
 * Node 24.21.0 (Electron 43.7.0) aborts the process at crypto_cipher.h:252
 * `errors->Empty()` when a WebCrypto AES job completes while an unrelated
 * OpenSSL error is still queued on the main thread (GitHub #1979; upstream fix
 * nodejs/node ae35a8fe). A caught safeStorage decrypt failure is one way the
 * queue gets that error. createCipheriv/createDecipheriv do not inspect the
 * shared queue that way, so they survive it.
 *
 * Output matches WebCrypto exactly (ciphertext || 16-byte tag), and failures
 * reject with DOMException 'OperationError' so callers that classify
 * WebCrypto errors (DocumentSync, index-row decryption) behave the same.
 */

import { createCipheriv, createDecipheriv, KeyObject } from 'node:crypto';
import { setAesGcmImplementation, type AesGcmImplementation } from '@nimbalyst/runtime/sync/aesGcm';

const TAG_LENGTH = 16;

// KeyObject.from accepts non-extractable CryptoKeys, so key custody is unchanged.
const keyObjects = new WeakMap<CryptoKey, KeyObject>();

function keyObjectFor(key: CryptoKey): KeyObject {
  let keyObject = keyObjects.get(key);
  if (!keyObject) {
    keyObject = KeyObject.from(key);
    keyObjects.set(key, keyObject);
  }
  return keyObject;
}

function cipherNameFor(keyObject: KeyObject): 'aes-128-gcm' | 'aes-192-gcm' | 'aes-256-gcm' {
  switch (keyObject.symmetricKeySize) {
    case 16: return 'aes-128-gcm';
    case 24: return 'aes-192-gcm';
    case 32: return 'aes-256-gcm';
    default: throw new DOMException(`Unsupported AES key size ${keyObject.symmetricKeySize}`, 'OperationError');
  }
}

export const nodeAesGcm: AesGcmImplementation = {
  async encrypt(key, iv, data) {
    const keyObject = keyObjectFor(key);
    const cipher = createCipheriv(cipherNameFor(keyObject), keyObject, iv, { authTagLength: TAG_LENGTH });
    const head = cipher.update(data);
    const tail = cipher.final();
    const tag = cipher.getAuthTag();
    const out = new Uint8Array(head.length + tail.length + tag.length);
    out.set(head, 0);
    out.set(tail, head.length);
    out.set(tag, head.length + tail.length);
    return out;
  },

  async decrypt(key, iv, data) {
    if (data.length < TAG_LENGTH) {
      throw new DOMException('AES-GCM input is shorter than the authentication tag', 'OperationError');
    }
    const keyObject = keyObjectFor(key);
    const tagStart = data.length - TAG_LENGTH;
    try {
      const decipher = createDecipheriv(cipherNameFor(keyObject), keyObject, iv, { authTagLength: TAG_LENGTH });
      decipher.setAuthTag(data.subarray(tagStart));
      const head = decipher.update(data.subarray(0, tagStart));
      // final() throws on an authentication failure; nothing is returned before it succeeds.
      const tail = decipher.final();
      const out = new Uint8Array(head.length + tail.length);
      out.set(head, 0);
      out.set(tail, head.length);
      return out;
    } catch (err) {
      if (err instanceof DOMException) throw err;
      throw new DOMException(`AES-GCM decryption failed: ${(err as Error).message}`, 'OperationError');
    }
  },
};

export function installNodeAesGcm(): void {
  setAesGcmImplementation(nodeAesGcm);
}

// Installed as a side effect of importing this module, the same way
// ./hostEnvironment registers itself: bootstrap.ts imports it above
// `./index.js`, so it runs before any sync service can encrypt.
installNodeAesGcm();
