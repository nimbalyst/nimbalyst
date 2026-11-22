// @vitest-environment node
//
// The Node AES-GCM implementation (#1979) must be byte-compatible with
// WebCrypto in both directions, since existing server data and other clients
// (iOS, Android, renderer) all use WebCrypto's ciphertext || tag layout.

import { describe, it, expect } from 'vitest';
import { webcrypto, randomBytes } from 'node:crypto';
import { nodeAesGcm } from '../nodeAesGcm';
import { webCryptoAesGcm } from '@nimbalyst/runtime/sync/aesGcm';

const subtle = webcrypto.subtle;

async function aesKey(bytes = randomBytes(32)): Promise<CryptoKey> {
  return subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
}

const iv = () => new Uint8Array(randomBytes(12));

const payloads: Array<[string, Uint8Array]> = [
  ['empty', new Uint8Array(0)],
  ['unicode', new TextEncoder().encode('naïve 日本語 🔐 \u0000 end')],
  ['binary', new Uint8Array(randomBytes(4099))],
  ['10 MB', new Uint8Array(randomBytes(10 * 1024 * 1024))],
];

describe('nodeAesGcm interop with WebCrypto', () => {
  it.each(payloads)('%s: identical ciphertext and cross-decrypts', async (_name, data) => {
    const key = await aesKey();
    const nonce = iv();
    const fromWeb = await webCryptoAesGcm.encrypt(key, nonce, data);
    const fromNode = await nodeAesGcm.encrypt(key, nonce, data);
    expect(Buffer.from(fromNode).equals(Buffer.from(fromWeb))).toBe(true);
    expect(fromNode.length).toBe(data.length + 16);
    expect(Buffer.from(await nodeAesGcm.decrypt(key, nonce, fromWeb)).equals(Buffer.from(data))).toBe(true);
    expect(Buffer.from(await webCryptoAesGcm.decrypt(key, nonce, fromNode)).equals(Buffer.from(data))).toBe(true);
  });

  it('accepts a non-extractable key derived with PBKDF2, as personal sync derives it', async () => {
    const material = await subtle.importKey('raw', new TextEncoder().encode('passphrase'), 'PBKDF2', false, ['deriveKey']);
    const key = (await subtle.deriveKey(
      { name: 'PBKDF2', salt: new TextEncoder().encode('salt'), iterations: 1000, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )) as CryptoKey;
    const nonce = iv();
    const sealed = await nodeAesGcm.encrypt(key, nonce, new Uint8Array([7, 8, 9]));
    expect(Array.from(await webCryptoAesGcm.decrypt(key, nonce, sealed))).toEqual([7, 8, 9]);
  });
});

describe('nodeAesGcm failures reject like WebCrypto', () => {
  async function expectOperationError(promise: Promise<unknown>) {
    const err = await promise.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('OperationError');
  }

  it('wrong key', async () => {
    const nonce = iv();
    const sealed = await nodeAesGcm.encrypt(await aesKey(), nonce, new Uint8Array([1, 2, 3]));
    await expectOperationError(nodeAesGcm.decrypt(await aesKey(), nonce, sealed));
  });

  it('tampered tag and tampered ciphertext', async () => {
    const key = await aesKey();
    const nonce = iv();
    const sealed = await nodeAesGcm.encrypt(key, nonce, new Uint8Array(64));
    const badTag = sealed.slice(); badTag[badTag.length - 1] ^= 1;
    const badBody = sealed.slice(); badBody[0] ^= 1;
    await expectOperationError(nodeAesGcm.decrypt(key, nonce, badTag));
    await expectOperationError(nodeAesGcm.decrypt(key, nonce, badBody));
  });

  it('input shorter than the tag', async () => {
    await expectOperationError(nodeAesGcm.decrypt(await aesKey(), iv(), new Uint8Array(15)));
  });
});

describe('no direct WebCrypto AES in Node-hosted sync code', () => {
  it('only runtime/sync/aesGcm.ts calls subtle.encrypt or subtle.decrypt', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    const repoRoot = path.resolve(__dirname, '../../../../../../..');
    const roots = ['packages/runtime/src/sync', 'packages/electron/src/main'].map((r) => path.join(repoRoot, r));
    const allowed = path.join(repoRoot, 'packages/runtime/src/sync/aesGcm.ts');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') walk(full);
        } else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name) && full !== allowed) {
          if (/subtle\s*\.\s*(en|de)crypt\s*\(/.test(readFileSync(full, 'utf8'))) offenders.push(path.relative(repoRoot, full));
        }
      }
    };
    roots.forEach(walk);
    // Use aesGcmEncrypt/aesGcmDecrypt from @nimbalyst/runtime/sync/aesGcm instead (#1979).
    expect(offenders).toEqual([]);
  });
});
