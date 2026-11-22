// @vitest-environment node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createCipheriv } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/unused' }, safeStorage: { isEncryptionAvailable: () => false } }));

const warn = vi.fn();
const info = vi.fn();
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: (...a: unknown[]) => info(...a), warn: (...a: unknown[]) => warn(...a) } },
}));

import { LEGACY_KEY_FILES, findLegacyRecoveryKeyFiles, withLegacyRecoveryKeys } from '../LegacyRecoveryKeyFiles';

describe('findLegacyRecoveryKeyFiles', () => {
  let userData: string;

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-key-purge-'));
    info.mockClear();
    warn.mockClear();
  });

  afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('preserves every legacy recovery source and leaves unrelated files alone', () => {
    for (const name of LEGACY_KEY_FILES) {
      fs.writeFileSync(path.join(userData, name), 'secret');
    }
    fs.writeFileSync(path.join(userData, 'config.json'), '{}');

    const present = findLegacyRecoveryKeyFiles(userData);

    expect(present.sort()).toEqual([...LEGACY_KEY_FILES].sort());
    for (const name of LEGACY_KEY_FILES) {
      expect(fs.readFileSync(path.join(userData, name), 'utf8')).toBe('secret');
    }
    expect(fs.existsSync(path.join(userData, 'config.json'))).toBe(true);
    expect(info).toHaveBeenCalled();
  });

  it('reports the same sources across repeated launches', () => {
    fs.writeFileSync(path.join(userData, 'org-encryption-keys.enc'), 'secret');

    expect(findLegacyRecoveryKeyFiles(userData)).toEqual(['org-encryption-keys.enc']);

    info.mockClear();
    expect(findLegacyRecoveryKeyFiles(userData)).toEqual(['org-encryption-keys.enc']);
  });

  it('survives an inaccessible file without deleting any sources', () => {
    const doomed = path.join(userData, 'org-key-history.enc');
    fs.writeFileSync(doomed, 'secret');
    fs.writeFileSync(path.join(userData, 'trust-verifications.enc'), 'secret');
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementationOnce(() => {
      throw new Error('EPERM');
    });

    findLegacyRecoveryKeyFiles(userData);

    expect(warn).toHaveBeenCalled();
    existsSpy.mockRestore();
    expect(fs.readFileSync(doomed, 'utf8')).toBe('secret');
  });

  it('uses only the requested org keys during explicit recovery and leaves the source bytes unchanged', async () => {
    const key = Buffer.alloc(32, 7), iv = Buffer.alloc(12, 8);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('tracker-item:item'));
    const ciphertext = Buffer.concat([cipher.update('retained source'), cipher.final(), cipher.getAuthTag()]).toString('base64');
    const source = JSON.stringify([['org-a', key.toString('base64')], ['org-b', Buffer.alloc(32, 9).toString('base64')]]);
    fs.writeFileSync(path.join(userData, 'org-encryption-keys.enc'), source);
    await withLegacyRecoveryKeys('org-a', async decrypt => {
      expect(decrypt(ciphertext, iv.toString('base64'), 'tracker-item:item').toString()).toBe('retained source');
      expect(() => decrypt(ciphertext, iv.toString('base64'), 'tracker-item:other')).toThrow('No retained key');
    }, userData);
    await expect(withLegacyRecoveryKeys('org-b', async decrypt => decrypt(ciphertext, iv.toString('base64'), 'tracker-item:item'), userData)).rejects.toThrow('No retained key');
    expect(fs.readFileSync(path.join(userData, 'org-encryption-keys.enc'), 'utf8')).toBe(source);
  });

  it('keeps the readable retained keys and reports an unreadable key file by name only', async () => {
    const key = Buffer.alloc(32, 3), iv = Buffer.alloc(12, 4);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update('historical source'), cipher.final(), cipher.getAuthTag()]).toString('base64');
    // A file that no longer unlocks on this device, and a history entry with one malformed epoch.
    fs.writeFileSync(path.join(userData, 'org-encryption-keys.enc'), 'not json {');
    fs.writeFileSync(path.join(userData, 'org-key-history.enc'), JSON.stringify([['org-a', [{ rawKeyBase64: 'c2VjcmV0LWtleS1tYXRlcmlhbA==' }, { rawKeyBase64: key.toString('base64') }]]]));
    const unreadable = await withLegacyRecoveryKeys('org-a', async (decrypt, files) => {
      expect(decrypt(ciphertext, iv.toString('base64')).toString()).toBe('historical source');
      return files;
    }, userData);
    expect(unreadable).toEqual(['org-encryption-keys.enc', 'org-key-history.enc']);
    expect(JSON.stringify(unreadable)).not.toContain('c2VjcmV0');
  });
});
