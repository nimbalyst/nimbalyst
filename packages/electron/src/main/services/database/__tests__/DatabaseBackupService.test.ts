// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// PGLite backup service is `app.getPath('userData')`-backed for the legacy
// cleanup scan; stub it before the import.
let tmp: string;
vi.mock('electron', () => ({
  app: {
    getPath: (_name: string) => tmp,
  },
}));
vi.mock('../../../utils/logger', () => ({
  logger: {
    main: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  },
}));

import { DatabaseBackupService } from '../DatabaseBackupService';

describe('DatabaseBackupService temp-dir cleanup', () => {
  let backupDir: string;
  let svc: DatabaseBackupService;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-pgbkp-'));
    backupDir = path.join(tmp, 'db-backups');
    fs.mkdirSync(backupDir, { recursive: true });

    // dbWorker is only used by createBackup/verifyBackup; cleanup doesn't need it.
    svc = new DatabaseBackupService(
      path.join(tmp, 'pglite-db'),
      {} as never,
    );
    await svc.initialize();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('preserves aged root-level corruption artifacts and their contents', async () => {
    const artifact = path.join(tmp, 'pglite-db.backup-2026-08-21T12-00-00-000Z');
    const payload = path.join(artifact, 'base', '1');
    fs.mkdirSync(path.dirname(payload), { recursive: true });
    fs.writeFileSync(payload, 'recoverable-user-data');
    const olderThanThirtyDays = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    fs.utimesSync(artifact, olderThanThirtyDays, olderThanThirtyDays);

    await svc.cleanupOldCorruptedBackups();

    expect(fs.existsSync(artifact)).toBe(true);
    expect(fs.readFileSync(payload, 'utf8')).toBe('recoverable-user-data');
  });

  it('cleanupOldCorruptedBackups removes stranded temp-backup-* dirs in backupDir', async () => {
    // Simulate a leaked temp dir from a previous failed backup. The pre-fix
    // cleanup function scanned userDataPath with the wrong prefix, so these
    // accumulated forever (~36 of them observed on one user's machine).
    const stranded = path.join(backupDir, 'temp-backup-2025-12-16T16-23-36-406Z');
    fs.mkdirSync(stranded);
    fs.writeFileSync(path.join(stranded, 'some-page.0'), 'x');

    // Rolling slots must survive cleanup.
    const currentSlot = path.join(backupDir, 'pglite-db.backup-current');
    fs.mkdirSync(currentSlot);
    fs.writeFileSync(path.join(currentSlot, 'real'), 'y');

    await svc.cleanupOldCorruptedBackups();

    expect(fs.existsSync(stranded)).toBe(false);
    expect(fs.existsSync(currentSlot)).toBe(true);
  });

  it('createBackup catch path removes the partial temp dir on failure', async () => {
    // Force a failure by pointing dbPath at a non-existent path AND poisoning
    // copyDirectory through the dbWorker shim. Simpler: trigger the failure
    // via the docs-fast path of dbPath-does-not-exist — that returns early
    // and never creates a temp dir, so doesn't exercise the new catch.
    // Instead: stub copyDirectory to create the dir then throw.
    const tempPath = path.join(backupDir, 'temp-backup-failtest');
    const svcAny = svc as unknown as {
      copyDirectory: (src: string, dest: string) => Promise<void>;
      hasEnoughDiskSpace: () => Promise<boolean>;
    };
    // Make dbPath exist so the createBackup() pre-checks pass.
    fs.mkdirSync(path.join(tmp, 'pglite-db'));
    svcAny.hasEnoughDiskSpace = async () => true;
    svcAny.copyDirectory = async (_src: string, dest: string) => {
      await fsp.mkdir(dest, { recursive: true });
      await fsp.writeFile(path.join(dest, 'partial'), 'x');
      throw new Error('synthetic copy failure');
    };

    const result = await svc.createBackup();
    expect(result.success).toBe(false);

    // The catch block must have cleaned up the partial temp directory.
    const stragglers = fs
      .readdirSync(backupDir)
      .filter((n) => n.startsWith('temp-backup-'));
    expect(stragglers).toEqual([]);

    // Sanity: the synthetic tempPath was never created (real code uses a
    // timestamped name), but no temp-backup-* should remain anywhere.
    expect(fs.existsSync(tempPath)).toBe(false);
  });
});

describe('DatabaseBackupService createBackup', () => {
  let backupDir: string;
  let dbPath: string;

  const verifyingWorker = () =>
    ({ verifyBackup: async () => ({ valid: true, hasData: true }) }) as never;

  const makeService = (getCopiesKept?: () => number) => {
    const svc = new DatabaseBackupService(dbPath, verifyingWorker(), { getCopiesKept });
    (svc as unknown as { hasEnoughDiskSpace: () => Promise<boolean> }).hasEnoughDiskSpace =
      async () => true;
    return svc;
  };

  const slotPath = (slot: 'current' | 'previous' | 'oldest') =>
    path.join(backupDir, `pglite-db.backup-${slot}`);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-pgbkp-'));
    backupDir = path.join(tmp, 'db-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    dbPath = path.join(tmp, 'pglite-db');
    fs.mkdirSync(dbPath);
    fs.writeFileSync(path.join(dbPath, 'page.0'), 'x'.repeat(1024));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('coalesces a second createBackup while one is in flight', async () => {
    // #1369: the periodic timer and the resume-from-sleep check both fire a
    // full copy on wake. Two concurrent multi-GB copies of the same store
    // starve each other and both fail verification. The second caller must
    // ride on the first copy instead of starting its own.
    const svc = makeService();
    await svc.initialize();
    let releaseCopy!: () => void;
    const copyGate = new Promise<void>((resolve) => { releaseCopy = resolve; });
    const copyDirectory = vi.fn(async (_src: string, dest: string) => {
      await copyGate;
      await fsp.mkdir(dest, { recursive: true });
      await fsp.writeFile(path.join(dest, 'page.0'), 'x'.repeat(1024));
    });
    (svc as unknown as { copyDirectory: typeof copyDirectory }).copyDirectory = copyDirectory;

    const first = svc.createBackup();
    const second = svc.createBackup();
    releaseCopy();
    const [a, b] = await Promise.all([first, second]);

    expect(copyDirectory).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ success: true });
    expect(b).toEqual({ success: true });

    // The guard must clear once the backup settles so the next window runs.
    await svc.createBackup();
    expect(copyDirectory).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight guard when the backup throws', async () => {
    const svc = makeService();
    await svc.initialize();
    const svcAny = svc as unknown as { copyDirectory: (src: string, dest: string) => Promise<void> };
    svcAny.copyDirectory = async () => { throw new Error('synthetic copy failure'); };

    const [a, b] = await Promise.all([svc.createBackup(), svc.createBackup()]);
    expect(a.success).toBe(false);
    expect(b.success).toBe(false);

    // A later call must start a fresh backup rather than replay the failure.
    const copyDirectory = vi.fn(async (_src: string, dest: string) => {
      await fsp.mkdir(dest, { recursive: true });
      await fsp.writeFile(path.join(dest, 'page.0'), 'x'.repeat(1024));
    });
    svcAny.copyDirectory = copyDirectory;
    expect(await svc.createBackup()).toEqual({ success: true });
    expect(copyDirectory).toHaveBeenCalledTimes(1);
  });

  it('keeps backupCopiesKept generations instead of a hardcoded three', async () => {
    // The SQLite service already honors the setting; the PGLite rotation
    // still rolled three full copies of the store regardless (#1369).
    const svc = makeService(() => 2);
    await svc.initialize();

    await svc.createBackup();
    await svc.createBackup();
    await svc.createBackup();

    expect(fs.existsSync(slotPath('current'))).toBe(true);
    expect(fs.existsSync(slotPath('previous'))).toBe(true);
    expect(fs.existsSync(slotPath('oldest'))).toBe(false);
    expect(svc.getBackupStatus().oldestBackup).toBeNull();
  });

  it('reclaims surplus generations when the setting is lowered', async () => {
    let copiesKept = 3;
    const svc = makeService(() => copiesKept);
    await svc.initialize();
    await svc.createBackup();
    await svc.createBackup();
    await svc.createBackup();
    expect(fs.existsSync(slotPath('oldest'))).toBe(true);

    copiesKept = 1;
    await svc.createBackup();

    expect(fs.existsSync(slotPath('current'))).toBe(true);
    expect(fs.existsSync(slotPath('previous'))).toBe(false);
    expect(fs.existsSync(slotPath('oldest'))).toBe(false);
  });
});
