/**
 * AES-GCM for personal sync, with a host-swappable implementation.
 *
 * The default is WebCrypto, which is correct for the renderer, browsers and
 * tests. The Electron main process installs a classic `node:crypto`
 * implementation instead: Node 24.21.0 (Electron 43.7.0) aborts the whole
 * process at crypto_cipher.h:252 `errors->Empty()` when a WebCrypto AES job
 * completes while an unrelated OpenSSL error is still queued on the main
 * thread (GitHub #1979). The abort is native, so no caller can catch it.
 *
 * Every implementation must keep the WebCrypto wire format: the output is
 * ciphertext followed by the 16-byte tag, and an authentication failure
 * rejects with a DOMException named 'OperationError'.
 *
 * Sync code must call these functions, never `crypto.subtle.encrypt/decrypt`
 * with AES directly.
 */

export interface AesGcmImplementation {
  /** Returns ciphertext || 16-byte tag. */
  encrypt(key: CryptoKey, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
  /** Accepts ciphertext || 16-byte tag. Rejects with DOMException 'OperationError' on auth failure. */
  decrypt(key: CryptoKey, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
}

export const webCryptoAesGcm: AesGcmImplementation = {
  async encrypt(key, iv, data) {
    const out = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data as BufferSource);
    return new Uint8Array(out);
  },
  async decrypt(key, iv, data) {
    const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, data as BufferSource);
    return new Uint8Array(out);
  },
};

let implementation: AesGcmImplementation = webCryptoAesGcm;

export function setAesGcmImplementation(impl: AesGcmImplementation): void {
  implementation = impl;
}

export function aesGcmEncrypt(key: CryptoKey, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  return implementation.encrypt(key, iv, data);
}

export function aesGcmDecrypt(key: CryptoKey, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  return implementation.decrypt(key, iv, data);
}
