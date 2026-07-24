import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { SQLiteBackupService } from '../SQLiteBackupService';

// Vitest can't import electron in unit tests; the service uses `logger` which
// pulls in main-only modules. Stub it.
vi.mock('../../../utils/logger', () => ({
  logger: {
    main: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  },
}));

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', '..', 'database', 'sqlite', 'schemas');

describe('SQLiteBackupService', () => {
  let tmp: string;
  let sqliteDir: string;
  let backupDir: string;
  let sqlite: SQLiteDatabase;
  let svc: SQLiteBackupService;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-bkp-'));
    sqliteDir = path.join(tmp, 'sqlite-db');
    backupDir = path.join(tmp, 'sqlite-db.backups');
    fs.mkdirSync(sqliteDir, { recursive: true });

    sqlite = new SQLiteDatabase({ dbDir: sqliteDir, schemaDir: SCHEMA_DIR });
    await sqlite.initialize();

    // Seed some data so the verifier sees session/history counts > 0.
    const handle = sqlite.getRawHandle()!;
    handle.prepare(`INSERT INTO ai_sessions(id, provider) VALUES (?, ?)`).run('s1', 'claude');

    svc = new SQLiteBackupService({ sqliteDir, backupDir, sqlite });
    await svc.initialize();
  });

  afterEach(async () => {
    try { await sqlite.close(); } catch { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a verified backup with the Online Backup API and writes metadata', async () => {
    const result = await svc.createBackup();
    expect(result.success).toBe(true);

    const currentPath = path.join(backupDir, 'nimbalyst.backup-current.sqlite');
    expect(fs.existsSync(currentPath)).toBe(true);

    const status = svc.getBackupStatus();
    expect(status.currentBackup).not.toBeNull();
    expect(status.currentBackup!.sizeBytes).toBeGreaterThan(0);
    expect(status.lastSuccessfulBackup).toBeTruthy();
  });

  it('rolls 3 backups: current -> previous -> oldest with each new backup', async () => {
    await svc.createBackup();
    await svc.createBackup();
    await svc.createBackup();

    expect(fs.existsSync(path.join(backupDir, 'nimbalyst.backup-current.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, 'nimbalyst.backup-previous.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, 'nimbalyst.backup-oldest.sqlite'))).toBe(true);
  });

  it('rejects a new backup that is < 50% of the current size', async () => {
    // Inflate the first backup with a big metadata blob so the ratio swing
    // crosses the 50% threshold after we delete everything + VACUUM.
    const bigPayload = 'x'.repeat(64 * 1024); // 64KB per row
    const handle = sqlite.getRawHandle()!;
    handle.prepare('DELETE FROM ai_sessions').run();
    const insert = handle.prepare(
      'INSERT INTO ai_sessions(id, provider, metadata) VALUES (?, ?, ?)',
    );
    for (let i = 0; i < 50; i++) {
      insert.run(`bkpsz-${i}`, 'claude', JSON.stringify({ pad: bigPayload }));
    }
    await svc.createBackup();
    const sizeBefore = svc.getBackupStatus().currentBackup!.sizeBytes;

    // Wipe data to shrink the next backup well past the size-guard threshold.
    handle.prepare('DELETE FROM ai_sessions').run();
    handle.pragma('wal_checkpoint(TRUNCATE)');
    handle.exec('VACUUM');

    const result = await svc.createBackup();
    // createBackup returns success even on rejection (data was protected).
    expect(result.success).toBe(true);
    const sizeAfter = svc.getBackupStatus().currentBackup!.sizeBytes;
    // Size guard kept the larger backup; sizeAfter should equal sizeBefore.
    expect(sizeAfter).toBe(sizeBefore);
  });

  it('restoreFromBackup replaces nimbalyst.sqlite with the backup file', async () => {
    await svc.createBackup();

    // Mutate the live db, then close and restore.
    const handle = sqlite.getRawHandle()!;
    handle.prepare('INSERT INTO ai_sessions(id, provider) VALUES (?, ?)').run('after-bkp', 'openai');
    expect(
      (handle.prepare('SELECT COUNT(*) AS c FROM ai_sessions').get() as { c: number }).c,
    ).toBe(2);

    const result = await svc.restoreFromBackup();
    expect(result.success).toBe(true);
    expect(result.source).toBe('current');

    // The live db is closed by restoreFromBackup; reopen it and verify the
    // mutation is gone.
    const reopen = new SQLiteDatabase({ dbDir: sqliteDir, schemaDir: SCHEMA_DIR });
    await reopen.initialize();
    const count = reopen
      .getRawHandle()!
      .prepare('SELECT COUNT(*) AS c FROM ai_sessions')
      .get() as { c: number };
    expect(count.c).toBe(1);
    await reopen.close();
  });

  it('hasBackups returns false when no backups exist, true after a backup', async () => {
    expect(svc.hasBackups()).toBe(false);
    await svc.createBackup();
    expect(svc.hasBackups()).toBe(true);
  });

  it('does not leave temp-backup-* WAL/SHM siblings behind after success', async () => {
    // better-sqlite3's online backup writes the destination in WAL mode, so
    // every call leaves `temp-backup-<ts>.sqlite-shm` and `.sqlite-wal` next
    // to the temp file. The rotation only renames the main `.sqlite`; the
    // siblings used to accumulate one pair per backup until the 30-day
    // cleanup ran on quit. The fix removes them immediately.
    await svc.createBackup();
    await svc.createBackup();
    await svc.createBackup();

    const stragglers = fs
      .readdirSync(backupDir)
      .filter((n) => n.startsWith('temp-backup-'));
    expect(stragglers).toEqual([]);
  });

  it('cleanupOldCorruptedBackups removes pre-existing stranded temp files', async () => {
    // Simulate stragglers from an older build that didn't clean WAL/SHM siblings.
    fs.writeFileSync(path.join(backupDir, 'temp-backup-2024-01-01.sqlite'), 'x');
    fs.writeFileSync(path.join(backupDir, 'temp-backup-2024-01-01.sqlite-wal'), '');
    fs.writeFileSync(path.join(backupDir, 'temp-backup-2024-01-01.sqlite-shm'), 'y');
    // A rolling backup file that must survive cleanup.
    fs.writeFileSync(path.join(backupDir, 'nimbalyst.backup-current.sqlite'), 'real');

    await svc.cleanupOldCorruptedBackups();

    const remaining = fs.readdirSync(backupDir);
    expect(remaining.some((n) => n.startsWith('temp-backup-'))).toBe(false);
    expect(remaining).toContain('nimbalyst.backup-current.sqlite');
  });
});
