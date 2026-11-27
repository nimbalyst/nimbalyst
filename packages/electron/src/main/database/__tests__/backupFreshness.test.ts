// @vitest-environment node
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateQuitBackupFreshness,
  readLatestBackupTimestampMs,
  unmangleIsoTimestamp,
} from '../backupFreshness';

const tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-backup-freshness-'));
  tmpDirs.push(dir);
  return dir;
}

function writeMetadata(userDataPath: string, subdir: string, lastSuccessfulBackup: string | null) {
  const dir = path.join(userDataPath, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'backup-metadata.json'),
    JSON.stringify({ lastSuccessfulBackup }),
    'utf-8',
  );
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('backupFreshness', () => {
  it('unmangles backup ISO timestamps back to standard ISO-8601', () => {
    expect(unmangleIsoTimestamp('2026-06-02T03-04-41-264Z')).toBe('2026-06-02T03:04:41.264Z');
  });

  it('skips quit backup when the latest SQLite backup is within the periodic window', () => {
    const dir = makeTempDir();
    const nowMs = Date.parse('2026-11-24T12:00:00.000Z');
    writeMetadata(dir, 'sqlite-db.backups', '2026-11-24T10-30-00-000Z'); // 90m ago

    const res = evaluateQuitBackupFreshness(dir, 4 * 60 * 60 * 1000, nowMs);
    expect(res.skip).toBe(true);
    expect(res.ageMs).toBe(90 * 60 * 1000);
  });

  it('runs quit backup when the latest backup is older than the periodic window', () => {
    const dir = makeTempDir();
    const nowMs = Date.parse('2026-11-24T12:00:00.000Z');
    writeMetadata(dir, 'sqlite-db.backups', '2026-11-24T06-00-00-000Z'); // 6h ago

    const res = evaluateQuitBackupFreshness(dir, 4 * 60 * 60 * 1000, nowMs);
    expect(res.skip).toBe(false);
    expect(res.ageMs).toBe(6 * 60 * 60 * 1000);
  });

  it('never skips quit backup when periodic backups are disabled (on-quit-only mode)', () => {
    const dir = makeTempDir();
    const nowMs = Date.parse('2026-11-24T12:00:00.000Z');
    writeMetadata(dir, 'sqlite-db.backups', '2026-11-24T11-59-00-000Z'); // 1m ago

    const res = evaluateQuitBackupFreshness(dir, 0, nowMs);
    expect(res.skip).toBe(false);
  });

  it('runs quit backup when no metadata exists or JSON is corrupt', () => {
    const dir = makeTempDir();
    expect(evaluateQuitBackupFreshness(dir, 4 * 60 * 60 * 1000).skip).toBe(false);

    const backupDir = path.join(dir, 'sqlite-db.backups');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'backup-metadata.json'), '{not-json', 'utf-8');
    expect(readLatestBackupTimestampMs(dir)).toBe(0);
    expect(evaluateQuitBackupFreshness(dir, 4 * 60 * 60 * 1000).skip).toBe(false);
  });

  it('picks the newer timestamp across sqlite-db.backups and db-backups', () => {
    const dir = makeTempDir();
    writeMetadata(dir, 'db-backups', '2026-11-24T08-00-00-000Z');
    writeMetadata(dir, 'sqlite-db.backups', '2026-11-24T11-00-00-000Z');

    expect(readLatestBackupTimestampMs(dir)).toBe(Date.parse('2026-11-24T11:00:00.000Z'));
  });
});
