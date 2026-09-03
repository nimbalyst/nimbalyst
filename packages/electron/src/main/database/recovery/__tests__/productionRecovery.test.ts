// @vitest-environment node
/**
 * That the production wiring composes at all.
 *
 * Small on purpose, and here because the defect it guards against is "the
 * engine exists and nothing reaches it". Settings marked every PGLite artifact
 * on a SQLite install unrestorable because no migrating materializer was
 * supplied, and the failure dialog reached none of this at all. Both are
 * wiring, and wiring is invisible to tests that construct their own adapters.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/nimbalyst-wiring',
    getAppPath: () => '/tmp/nimbalyst-wiring',
    isPackaged: false,
  },
  shell: { showItemInFolder: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
}));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildProductionRecoveryAdapter,
  liveDatabasePath,
} from '../productionRecovery';
import { createSqliteRecoveryAdapter } from '../backendAdapters';
import { buildRecoveryEvent } from '../recoveryEventMapper';
import { createPgliteArtifactMaterializer } from '../pgliteToSqliteMaterializer';

describe('production recovery wiring', () => {
  it('builds a usable adapter for each backend', () => {
    expect(liveDatabasePath('/u', 'pglite')).toContain('pglite-db');
    expect(liveDatabasePath('/u', 'sqlite')).toContain('nimbalyst.sqlite');
    expect(buildProductionRecoveryAdapter('/u', 'pglite').backend).toBe('pglite');
    expect(buildProductionRecoveryAdapter('/u', 'sqlite').backend).toBe('sqlite');
  });

  /**
   * The affected population from the incident: a PGLite artifact next to a
   * SQLite live database. Without a materializer the adapter's `stage` rejects
   * every directory, which is what made recovery unavailable for exactly the
   * installs that needed it.
   *
   * Two adapters over the same directory, and the difference between the two
   * rejections is the whole assertion. The previous version of this asserted
   * only `rejects.not.toThrow(/no migrating materializer/)`, which any
   * rejection at all satisfies -- including one thrown before the stage
   * function was even reached.
   */
  it('gives the SQLite adapter a materializer, so a directory candidate is not refused outright', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-wiring-'));
    const artifact = path.join(userData, 'pglite-db.backup-x');
    fs.mkdirSync(path.join(userData, 'sqlite-db'), { recursive: true });
    fs.mkdirSync(artifact, { recursive: true });
    fs.writeFileSync(path.join(artifact, 'PG_VERSION'), '15\n');
    const dest = path.join(userData, 'sqlite-db', 'staged.sqlite');

    // No materializer: the adapter refuses the directory on sight, which is
    // what every SQLite-active install saw for every artifact it had.
    const withoutMaterializer = createSqliteRecoveryAdapter({
      livePath: '/u/sqlite-db/nimbalyst.sqlite',
      engine: {
        initialize: async () => {},
        close: async () => {},
        queryReadOnly: async () => ({ rows: [] }),
      },
      verify: async () => ({
        valid: false,
        integrity: 'unreadable' as const,
        requiredSchemaPresent: false,
        indicators: { sessionCount: null, documentHistoryCount: null, projectCount: null },
      }),
    });
    await expect(withoutMaterializer.stage(artifact, dest)).rejects.toThrow(
      /no migrating materializer/,
    );

    // What production builds. It gets as far as needing the PGLite worker
    // bundle, which is absent in this environment -- so it fails naming the
    // bundle, not naming the missing materializer.
    await expect(
      buildProductionRecoveryAdapter(userData, 'sqlite').stage(artifact, dest),
    ).rejects.toThrow(/worker bundle not found/);

    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('maps every recovery domain event to a bounded, categorical payload', () => {
    const started = buildRecoveryEvent({
      type: 'recovery_started',
      backend: 'sqlite',
      candidateSizeBucket: 'under-1gb',
      liveSizeBucket: 'empty',
      reasonCode: null,
    });
    expect(started.name).toBe('database_recovery_started');
    expect(started.properties.reason_code).toBe('none');

    const failed = buildRecoveryEvent({
      type: 'recovery_failed',
      backend: 'pglite',
      code: 'swap_failed',
      failedStep: 'swap-promote',
      rolledBack: true,
    });
    expect(failed.properties).toEqual({
      backend: 'pglite',
      code: 'swap_failed',
      failed_step: 'swap-promote',
      rolled_back: true,
    });

    // Nothing free-form reaches analytics.
    for (const value of Object.values(failed.properties)) {
      expect(typeof value === 'boolean' || (value as string).length < 40).toBe(true);
    }
  });

  /**
   * The materializer handles both shapes a candidate can take. The SQLite-file
   * branch is the one that can be driven without a PGLite worker, and it is
   * also the branch a rolling SQLite backup takes, so it is worth holding to
   * the byte.
   *
   * The directory branch -- copy to scratch, open in a worker, migrate, close,
   * move -- needs `out/worker.bundle.js` and a real PGLite, so it is covered by
   * `e2e/core/database-recovery.spec.ts` rather than here.
   */
  it('copies a SQLite-file candidate byte for byte', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-materialize-'));
    const src = path.join(dir, 'candidate.sqlite');
    const dest = path.join(dir, 'staged.sqlite');
    const bytes = Buffer.from('SQLite format 3\0not really, but the copy must not care');
    fs.writeFileSync(src, bytes);

    await createPgliteArtifactMaterializer({
      workerPath: '/nonexistent',
      schemaDir: '/nonexistent',
      scratchDir: dir,
    })(src, dest);

    expect(fs.readFileSync(dest)).toEqual(bytes);
    // The candidate is never modified, whatever happens to the copy.
    expect(fs.readFileSync(src)).toEqual(bytes);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
