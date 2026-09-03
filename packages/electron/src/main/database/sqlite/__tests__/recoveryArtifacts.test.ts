// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  classifyBackupEntry,
  findRecoveryArtifacts,
  findRestorableBackups,
  formatBytes,
  largestDirBytes,
} from '../recoveryArtifacts';

describe('recoveryArtifacts', () => {
  let tmp: string;

  const seedDir = (name: string, bytes: number) => {
    fs.mkdirSync(path.join(tmp, name), { recursive: true });
    fs.writeFileSync(path.join(tmp, name, 'base'), Buffer.alloc(bytes));
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-recovery-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('uses the containing directory to separate rolling backups from corruption artifacts', () => {
    expect(classifyBackupEntry(path.join(tmp, 'db-backups'), 'pglite-db.backup-current'))
      .toBe('rolling-backup');
    expect(classifyBackupEntry(tmp, 'pglite-db.backup-2026-08-21T12-00-00-000Z'))
      .toBe('corruption-artifact');
  });

  it('separates renamed-aside databases from preserved migration dirs', () => {
    seedDir('pglite-db', 10);
    seedDir('pglite-db.backup-2026-08-20T11-00-00-000Z', 200);
    seedDir('pglite-db.migrated-2026-05-28T18-03-48-434Z', 300);
    seedDir('sqlite-db', 400);

    const found = findRecoveryArtifacts(tmp);
    expect(found.corruptionBackupDirs).toEqual(['pglite-db.backup-2026-08-20T11-00-00-000Z']);
    expect(found.migratedDirs).toEqual(['pglite-db.migrated-2026-05-28T18-03-48-434Z']);
  });

  // The live `pglite-db` prefixes both names, so a sloppy startsWith check on
  // the bare directory folds it into one of the buckets and every install
  // looks like it had a database renamed aside.
  it('does not count the live pglite-db as an artifact', () => {
    seedDir('pglite-db', 10);
    const found = findRecoveryArtifacts(tmp);
    expect(found.corruptionBackupDirs).toEqual([]);
    expect(found.migratedDirs).toEqual([]);
  });

  it('reports the largest backup, which is what says data is recoverable', () => {
    seedDir('pglite-db.backup-2026-08-19T09-00-00-000Z', 50);
    seedDir('pglite-db.backup-2026-08-20T11-00-00-000Z', 5000);

    const found = findRecoveryArtifacts(tmp);
    expect(found.corruptionBackupDirs).toHaveLength(2);
    expect(largestDirBytes(tmp, found.corruptionBackupDirs)).toBeGreaterThanOrEqual(5000);
  });

  // The database-failure dialog reads this to decide whether it can promise
  // the user their data is recoverable. Getting it wrong in either direction
  // is what made #1347 destructive.
  it('breaks size ties by discovery order: rolling backups before renamed-aside ones', () => {
    seedDir(path.join('db-backups', 'pglite-db.backup-current'), 800);
    seedDir(path.join('db-backups', 'pglite-db.backup-previous'), 800);
    seedDir('pglite-db.backup-2026-08-20T11-00-00-000Z', 800);

    const names = findRestorableBackups(tmp).map((b) => b.name);
    expect(names).toEqual([
      'pglite-db.backup-current',
      'pglite-db.backup-previous',
      'pglite-db.backup-2026-08-20T11-00-00-000Z',
    ]);
  });

  /**
   * The failure dialog restores the first entry and quits. In slot order that
   * meant an install whose `current` slot held a small valid copy of nothing
   * -- a database that lost its contents and was then backed up on schedule,
   * which is #1347's exact shape -- restored the useless copy on every launch
   * forever while months of history sat in `previous`.
   */
  it('puts the copy holding the most first, whatever slot it is in', () => {
    seedDir(path.join('db-backups', 'pglite-db.backup-current'), 900);
    seedDir(path.join('db-backups', 'pglite-db.backup-previous'), 400_000);
    seedDir('pglite-db.backup-2026-08-20T11-00-00-000Z', 50_000);

    const names = findRestorableBackups(tmp).map((b) => b.name);
    expect(names).toEqual([
      'pglite-db.backup-previous',
      'pglite-db.backup-2026-08-20T11-00-00-000Z',
      'pglite-db.backup-current',
    ]);
  });

  /**
   * A SQLite install that will not start keeps its copies under
   * `sqlite-db.backups/`. The scanner only knew the PGLite names, so the
   * dialog said "nothing recoverable" and quit on an install with three
   * healthy backups.
   */
  it('finds SQLite rolling backups, not just PGLite ones', () => {
    fs.mkdirSync(path.join(tmp, 'sqlite-db.backups'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'sqlite-db.backups', 'nimbalyst.backup-current.sqlite'),
      Buffer.alloc(4096, 1),
    );

    const found = findRestorableBackups(tmp);
    expect(found.map((b) => b.name)).toEqual(['nimbalyst.backup-current.sqlite']);
    expect(found[0].bytes).toBe(4096);
  });

  it('omits empty backups rather than offering a 0-byte recovery', () => {
    fs.mkdirSync(path.join(tmp, 'db-backups', 'pglite-db.backup-current'), { recursive: true });
    seedDir(path.join('db-backups', 'pglite-db.backup-previous'), 640);

    const found = findRestorableBackups(tmp);
    expect(found.map((b) => b.name)).toEqual(['pglite-db.backup-previous']);
    expect(found[0].bytes).toBeGreaterThanOrEqual(640);
    expect(found[0].path).toContain(path.join('db-backups', 'pglite-db.backup-previous'));
  });

  it('says there is nothing to restore when no backup holds data', () => {
    seedDir('pglite-db', 4096);
    expect(findRestorableBackups(tmp)).toEqual([]);
  });

  it('formats sizes for the dialog', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(30 * 1024 * 1024)).toBe('30 MB');
    expect(formatBytes(1536 * 1024 * 1024)).toBe('1.5 GB');
  });

  it('returns nothing rather than throwing when userData is unreadable', () => {
    expect(findRecoveryArtifacts(path.join(tmp, 'does-not-exist'))).toEqual({
      migratedDirs: [],
      corruptionBackupDirs: [],
    });
    expect(largestDirBytes(tmp, ['does-not-exist'])).toBe(0);
  });
});
