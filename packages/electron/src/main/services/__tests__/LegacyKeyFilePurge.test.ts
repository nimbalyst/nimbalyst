import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }));

const warn = vi.fn();
const info = vi.fn();
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: (...a: unknown[]) => info(...a), warn: (...a: unknown[]) => warn(...a) } },
}));

import { LEGACY_KEY_FILES, purgeLegacyKeyFiles } from '../LegacyKeyFilePurge';

describe('purgeLegacyKeyFiles', () => {
  let userData: string;

  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-key-purge-'));
    info.mockClear();
    warn.mockClear();
  });

  afterEach(() => {
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('deletes every legacy key file and leaves unrelated files alone', () => {
    for (const name of LEGACY_KEY_FILES) {
      fs.writeFileSync(path.join(userData, name), 'secret');
    }
    fs.writeFileSync(path.join(userData, 'config.json'), '{}');

    const removed = purgeLegacyKeyFiles(userData);

    expect(removed.sort()).toEqual([...LEGACY_KEY_FILES].sort());
    for (const name of LEGACY_KEY_FILES) {
      expect(fs.existsSync(path.join(userData, name))).toBe(false);
    }
    expect(fs.existsSync(path.join(userData, 'config.json'))).toBe(true);
    expect(info).toHaveBeenCalled();
  });

  it('is idempotent -- a second run removes nothing and stays silent', () => {
    fs.writeFileSync(path.join(userData, 'org-encryption-keys.enc'), 'secret');

    expect(purgeLegacyKeyFiles(userData)).toEqual(['org-encryption-keys.enc']);

    info.mockClear();
    expect(purgeLegacyKeyFiles(userData)).toEqual([]);
    expect(info).not.toHaveBeenCalled();
  });

  it('survives a file it cannot delete', () => {
    const doomed = path.join(userData, 'org-key-history.enc');
    fs.writeFileSync(doomed, 'secret');
    fs.writeFileSync(path.join(userData, 'trust-verifications.enc'), 'secret');
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      throw new Error('EPERM');
    });

    const removed = purgeLegacyKeyFiles(userData);

    expect(removed).toEqual(['trust-verifications.enc']);
    expect(warn).toHaveBeenCalled();
    unlinkSpy.mockRestore();
  });
});
