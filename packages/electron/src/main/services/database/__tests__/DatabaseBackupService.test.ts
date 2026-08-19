import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PGlite } from '@electric-sql/pglite';

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

  it('reports physical session bloat and dry-run guidance before another rolling copy', async () => {
    const gib = 1024 ** 3;
    const mib = 1024 ** 2;
    const query = vi.fn(async (_sql: string) => ({
      rows: [{
        database_size_bytes: String(5 * gib),
        ai_sessions_relation_size_bytes: String(1800 * mib),
        ai_sessions_live_row_bytes: String(2 * mib),
      }],
    }));

    const service = new DatabaseBackupService(
      path.join(tmp, 'pglite-db'),
      { query } as never,
    );
    const serviceWithGrowthProbe = service as unknown as {
      assessPhysicalGrowth: () => Promise<{
        databaseSizeBytes: number;
        aiSessionsRelationSizeBytes: number;
        aiSessionsLiveRowBytes: number;
        retainedBackupBytes: number;
        projectedPeakBytes: number;
        sessionPhysicalToLiveRatio: number;
        maintenanceRecommended: boolean;
        operatorGuidance: string | null;
      }>;
    };
    const retainedSizes = [11, 13, 17];
    for (const [index, slot] of [
      'pglite-db.backup-current',
      'pglite-db.backup-previous',
      'pglite-db.backup-oldest',
    ].entries()) {
      const slotPath = path.join(backupDir, slot);
      await fsp.mkdir(slotPath, { recursive: true });
      await fsp.writeFile(path.join(slotPath, 'page'), Buffer.alloc(retainedSizes[index]));
    }

    const assessment = await serviceWithGrowthProbe.assessPhysicalGrowth();

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain('pg_database_size(current_database())');
    expect(query.mock.calls[0]?.[0]).toContain("pg_table_size('ai_sessions')");
    expect(query.mock.calls[0]?.[0]).toContain('pg_column_size(s)');
    expect(assessment).toMatchObject({
      databaseSizeBytes: 5 * gib,
      aiSessionsRelationSizeBytes: 1800 * mib,
      aiSessionsLiveRowBytes: 2 * mib,
      retainedBackupBytes: 41,
      projectedPeakBytes: (10 * gib) + 41,
      sessionPhysicalToLiveRatio: 900,
      maintenanceRecommended: true,
    });
    expect(assessment.operatorGuidance).toMatch(/Settings.*dry-run.*before the next backup/i);
  });

  it('compares physical table storage with live complete-row bytes in PGlite', async () => {
    const db = new PGlite({ dataDir: path.join(tmp, 'growth-query-db') });
    try {
      await db.exec(`
        CREATE TABLE ai_sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          metadata JSONB NOT NULL DEFAULT '{}'
        );
        INSERT INTO ai_sessions (id, title, metadata)
        VALUES ('s1', 'Session', '{"tokenUsage":{"totalTokens":16}}');
      `);
      const service = new DatabaseBackupService(
        path.join(tmp, 'growth-query-db'),
        { query: (sql: string) => db.query(sql) } as never,
      );

      const assessment = await service.assessPhysicalGrowth();

      expect(assessment.aiSessionsRelationSizeBytes).toBeGreaterThan(0);
      expect(assessment.aiSessionsLiveRowBytes).toBeGreaterThan(0);
      expect(assessment.sessionPhysicalToLiveRatio).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });
});
