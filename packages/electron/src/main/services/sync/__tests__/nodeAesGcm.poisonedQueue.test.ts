// @vitest-environment node
//
// Regression for GitHub #1979. Node 24.21.0 (Electron 43.7.0) aborts the whole
// process at crypto_cipher.h:252 `errors->Empty()` when a WebCrypto AES job
// finishes while an unrelated OpenSSL error is still queued on the main thread.
// The abort is native, so no promise rejects and no try/catch helps; a mocked
// test cannot see it. This runs the real sync crypto path inside the real
// Electron binary, with the queue deliberately poisoned first.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

const require = createRequire(import.meta.url);
const electronBinary = require('electron') as unknown as string;

const repoRoot = path.resolve(__dirname, '../../../../../../..');
const runtimeSync = path.join(repoRoot, 'packages/runtime/src/sync');
const mainSync = path.resolve(__dirname, '..');

const entrySource = `
import { getCipherInfo } from 'node:crypto';
import { installNodeAesGcm } from ${JSON.stringify(path.join(mainSync, 'nodeAesGcm.ts'))};
import { encrypt, decrypt } from ${JSON.stringify(path.join(runtimeSync, 'collabV3Crypto.ts'))};
import { aesGcmEncrypt, aesGcmDecrypt } from ${JSON.stringify(path.join(runtimeSync, 'aesGcm.ts'))};

(async () => {
  installNodeAesGcm();
  const key = await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const sealed = await encrypt('hello #1979', key);
  // Leaves an OpenSSL error on the main thread's queue without throwing.
  getCipherInfo('aes-256-gcm', { keyLength: 1 });
  const opened = await decrypt(sealed.encrypted, sealed.iv, key);
  getCipherInfo('aes-256-gcm', { keyLength: 1 });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bin = await aesGcmEncrypt(key, iv, new Uint8Array([1, 2, 3]));
  const back = await aesGcmDecrypt(key, iv, bin);
  console.log('RESULT ' + JSON.stringify({ opened, back: Array.from(back) }));
})().catch((err) => { console.log('ERROR ' + (err && err.message)); process.exit(2); });
`;

describe('sync AES-GCM with a poisoned OpenSSL error queue (#1979)', () => {
  it('encrypts and decrypts inside Electron without a native abort', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'nim-1979-'));
    try {
      const outfile = path.join(dir, 'entry.cjs');
      buildSync({
        stdin: { contents: entrySource, resolveDir: mainSync, loader: 'ts' },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        outfile,
        logLevel: 'silent',
        alias: { '@nimbalyst/runtime': path.join(repoRoot, 'packages/runtime/src') },
      });
      writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');

      const result = spawnSync(electronBinary, [outfile], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        timeout: 15_000,
      });

      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(output).not.toContain('errors->Empty()');
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      const line = (result.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
      expect(JSON.parse(line!.slice('RESULT '.length))).toEqual({ opened: 'hello #1979', back: [1, 2, 3] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
