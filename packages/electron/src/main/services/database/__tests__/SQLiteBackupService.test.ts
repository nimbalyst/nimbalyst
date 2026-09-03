// @vitest-environment node
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

  const slotPath = (slot: 'current' | 'previous' | 'oldest') =>
    path.join(backupDir, `nimbalyst.backup-${slot}.sqlite`);

  it('keeps two generations by default: current -> previous', async () => {
    // Each generation is a FULL copy, so this count is a direct multiplier on
    // disk. The old hardcoded rolling-3 made a 4.6 GiB store occupy 18.5 GiB
    // (#1248); two keeps a fallback generation at 3x instead of 4x.
    await svc.createBackup();
    await svc.createBackup();
    await svc.createBackup();

    expect(fs.existsSync(slotPath('current'))).toBe(true);
    expect(fs.existsSync(slotPath('previous'))).toBe(true);
    expect(fs.existsSync(slotPath('oldest'))).toBe(false);
  });

  it('rolls all three generations when the user opts back up to 3', async () => {
    svc.setCopiesKept(3);

    await svc.createBackup();
    await svc.createBackup();
    await svc.createBackup();

    expect(fs.existsSync(slotPath('current'))).toBe(true);
    expect(fs.existsSync(slotPath('previous'))).toBe(true);
    expect(fs.existsSync(slotPath('oldest'))).toBe(true);
  });

  it('reclaims the extra copies when retention is lowered', async () => {
    svc.setCopiesKept(3);
    await svc.createBackup();
    await svc.createBackup();
    await svc.createBackup();
    expect(fs.existsSync(slotPath('oldest'))).toBe(true);

    // Lowering the setting has to actually delete the surplus file, not just
    // stop writing to it -- otherwise the disk never comes back.
    svc.setCopiesKept(1);
    await svc.createBackup();

    expect(fs.existsSync(slotPath('current'))).toBe(true);
    expect(fs.existsSync(slotPath('previous'))).toBe(false);
    expect(fs.existsSync(slotPath('oldest'))).toBe(false);
  });

  it('never drops below one backup, whatever the setting says', async () => {
    svc.setCopiesKept(0);
    await svc.createBackup();
    expect(fs.existsSync(slotPath('current'))).toBe(true);

    // A second pass must still leave a backup on disk.
    await svc.createBackup();
    expect(fs.existsSync(slotPath('current'))).toBe(true);
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

  it('verifies through the injected verifier, never the live connection', async () => {
    // The whole point of the injection: verification is a synchronous multi-GB
    // scan, and the live connection lives on the thread that serves every
    // `query`. If this ever falls back to `sqlite.verifyBackup` inside the
    // worker, the worker stops dequeuing messages for the duration and every
    // queued request times out. Nothing at the call site shows that.
    const inlineVerify = vi.spyOn(sqlite, 'verifyBackup');
    const verify = vi.fn().mockResolvedValue({ valid: true, hasData: true });
    const injected = new SQLiteBackupService({ sqliteDir, backupDir, sqlite, verify });
    await injected.initialize();

    const result = await injected.createBackup();

    expect(result.success).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(inlineVerify).not.toHaveBeenCalled();
  });

  it('coalesces a second createBackup while one is in flight', async () => {
    // #1369: the periodic timer and the resume-from-sleep check both fire a
    // full copy on wake. The second caller must ride on the first copy, get
    // its result, and not start a second online backup.
    let releaseVerify!: () => void;
    const verifyGate = new Promise<void>((resolve) => { releaseVerify = resolve; });
    const verify = vi.fn(async () => {
      await verifyGate;
      return { valid: true, hasData: true };
    });
    const injected = new SQLiteBackupService({ sqliteDir, backupDir, sqlite, verify });
    await injected.initialize();
    const backupSpy = vi.spyOn(sqlite.getRawHandle()!, 'backup');

    const first = injected.createBackup();
    const second = injected.createBackup();
    releaseVerify();
    const [a, b] = await Promise.all([first, second]);

    expect(backupSpy).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ success: true });
    expect(b).toEqual({ success: true });

    // The guard must clear once the backup settles so the next window runs.
    await injected.createBackup();
    expect(backupSpy).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight guard when the backup throws', async () => {
    const verify = vi.fn()
      .mockRejectedValueOnce(new Error('synthetic verify failure'))
      .mockResolvedValue({ valid: true, hasData: true });
    const injected = new SQLiteBackupService({ sqliteDir, backupDir, sqlite, verify });
    await injected.initialize();

    const [a, b] = await Promise.all([injected.createBackup(), injected.createBackup()]);
    expect(a.success).toBe(false);
    expect(b.success).toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);

    // A later call must start a fresh backup rather than replay the failure.
    expect(await injected.createBackup()).toEqual({ success: true });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('does not promote a backup the verifier rejects', async () => {
    const verify = vi.fn().mockResolvedValue({ valid: false, error: 'quick_check returned: bad' });
    const injected = new SQLiteBackupService({ sqliteDir, backupDir, sqlite, verify });
    await injected.initialize();

    const result = await injected.createBackup();

    expect(result.success).toBe(false);
    expect(result.error).toContain('quick_check returned: bad');
    expect(fs.existsSync(slotPath('current'))).toBe(false);
    expect(fs.readdirSync(backupDir).filter((n) => n.startsWith('temp-backup-'))).toEqual([]);
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
