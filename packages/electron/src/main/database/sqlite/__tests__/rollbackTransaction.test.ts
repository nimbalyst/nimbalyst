// @vitest-environment node
/**
 * Rolling a migration back.
 *
 * Rollback is the only operation that moves two directories in sequence with
 * the app holding no database in between, and it is the one that had no
 * journal: it renamed `sqlite-db/` aside, renamed a PGLite copy into place,
 * and only then wrote the backend flag. A process that died in the middle left
 * both live paths absent with the flag still saying SQLite, and the next
 * launch created an empty SQLite database on top of that.
 *
 * Real directories and real renames throughout; the only injected failure is a
 * single rename, which is how the interruption is reproduced without killing
 * the test runner.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runRollback } from '../rollbackTransaction';
import { readBackendState, writeBackendState } from '../BackendSelector';
import { reconcileCutoverOnStartup } from '../cutoverReconciler';
import { readCutoverJournal, type CutoverFs } from '../cutoverJournal';

const MARKER = 'PG_VERSION';

describe('migration rollback', () => {
  let tmp: string;
  let pgliteDir: string;
  let sqliteDir: string;
  /** The store this install actually migrated from. */
  let recorded: string;
  /** An unrelated preserved store that sorts after it. */
  let stranger: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-rollback-'));
    pgliteDir = path.join(tmp, 'pglite-db');
    sqliteDir = path.join(tmp, 'sqlite-db');
    recorded = path.join(tmp, 'pglite-db.migrated-2026-01-05T00-00-00-000Z');
    stranger = path.join(tmp, 'pglite-db.migrated-2026-09-01T00-00-00-000Z');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makePgliteStore(dir: string, contents: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MARKER), contents);
  }

  function makeSqliteStore(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'nimbalyst.sqlite'), Buffer.alloc(128 * 1024, 1));
  }

  /** A migrated install: SQLite live, `recorded` named as the rollback source. */
  function migratedInstall(): void {
    makeSqliteStore(sqliteDir);
    makePgliteStore(recorded, 'the database this install migrated from');
    writeBackendState(tmp, {
      backend: 'sqlite',
      setAt: '2026-01-05T00:00:00.000Z',
      setBy: 'user-migration',
      pgliteMigratedDir: recorded,
    });
  }

  /** Real fs, except one rename, which fails the way a held handle does. */
  function fsFailingRenameFrom(target: string): CutoverFs {
    return {
      exists: (p) => fs.existsSync(p),
      isNonEmptyDir: (p) => {
        try {
          return fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0;
        } catch {
          return false;
        }
      },
      rename: (from, to) => {
        if (from === target) {
          const err = new Error(`EPERM: operation not permitted, rename '${from}'`) as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }
        fs.renameSync(from, to);
      },
    };
  }

  it('activates the store the backend flag recorded, not the newest name on disk', async () => {
    migratedInstall();
    // A second preserved store from some earlier experiment, sorting later.
    // Restoring this one gives the user back a database that is not theirs.
    makePgliteStore(stranger, 'an unrelated preserved store');

    const result = await runRollback({ userDataPath: tmp, quiesceSqlite: async () => {} });

    expect(result.restoredFrom).toBe(recorded);
    expect(fs.readFileSync(path.join(pgliteDir, MARKER), 'utf-8')).toBe(
      'the database this install migrated from',
    );
    // The stranger is left exactly where it was; nothing deletes copies.
    expect(fs.existsSync(path.join(stranger, MARKER))).toBe(true);
    expect(readBackendState(tmp)?.backend).toBe('pglite');
    expect(readBackendState(tmp)?.setBy).toBe('rollback');
    expect(readCutoverJournal(tmp)).toBeNull();
  });

  it('refuses when the recorded store is gone and the disk offers a choice', async () => {
    makeSqliteStore(sqliteDir);
    makePgliteStore(stranger, 'an unrelated preserved store');
    makePgliteStore(path.join(tmp, 'pglite-db.migrated-2026-02-02T00-00-00-000Z'), 'another one');
    writeBackendState(tmp, {
      backend: 'sqlite',
      setAt: '2026-01-05T00:00:00.000Z',
      setBy: 'user-migration',
      pgliteMigratedDir: recorded, // never created: the user removed it
    });

    await expect(
      runRollback({ userDataPath: tmp, quiesceSqlite: async () => {} }),
    ).rejects.toThrow(/migrated from \(pglite-db\.migrated-2026-01-05.*\) is not on disk/);

    // Refusing means refusing: SQLite is still live and still committed.
    expect(fs.existsSync(path.join(sqliteDir, 'nimbalyst.sqlite'))).toBe(true);
    expect(readBackendState(tmp)?.backend).toBe('sqlite');
  });

  it('does not move anything when SQLite will not close', async () => {
    migratedInstall();

    await expect(
      runRollback({
        userDataPath: tmp,
        quiesceSqlite: async () => {
          throw new Error('SQLite worker did not acknowledge close');
        },
      }),
    ).rejects.toThrow(/did not acknowledge close/);

    expect(fs.existsSync(path.join(sqliteDir, 'nimbalyst.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(recorded, MARKER))).toBe(true);
    expect(fs.existsSync(pgliteDir)).toBe(false);
    expect(readBackendState(tmp)?.backend).toBe('sqlite');
    expect(readCutoverJournal(tmp)).toBeNull();
  });

  describe('interrupted between the two renames', () => {
    /**
     * The window: `sqlite-db/` has been moved aside and the PGLite store has
     * not been moved back. Both live paths are absent and the flag still says
     * SQLite.
     */
    async function interrupt(): Promise<void> {
      migratedInstall();
      await expect(
        runRollback({
          userDataPath: tmp,
          quiesceSqlite: async () => {},
          cutoverFs: fsFailingRenameFrom(recorded),
        }),
      ).rejects.toThrow(/EPERM/);

      expect(fs.existsSync(sqliteDir)).toBe(false);
      expect(fs.existsSync(pgliteDir)).toBe(false);
    }

    it('leaves a journal naming both stores rather than nothing at all', async () => {
      await interrupt();
      const journal = readCutoverJournal(tmp);
      expect(journal?.operation).toBe('rollback');
      expect(journal?.commitBackend).toBe('pglite');
      expect(journal?.target.stagingPath).toBe(recorded);
      expect(journal?.source.preservedPath).toMatch(/sqlite-db\.rolledback-/);
    });

    it('the next launch finishes the rollback instead of creating an empty database', async () => {
      await interrupt();

      const result = reconcileCutoverOnStartup({ userDataPath: tmp });

      expect(result.outcome).toBe('completed');
      expect(result.authoritativeBackend).toBe('pglite');
      expect(fs.readFileSync(path.join(pgliteDir, MARKER), 'utf-8')).toBe(
        'the database this install migrated from',
      );
      expect(readBackendState(tmp)?.backend).toBe('pglite');
      expect(readCutoverJournal(tmp)).toBeNull();
    });

    it('blocks opening SQLite while it cannot finish', async () => {
      await interrupt();

      // The same rename still fails on the next launch. Startup has no
      // database it can name, and `sqlite-db/` is the one it must not create.
      const result = reconcileCutoverOnStartup({
        userDataPath: tmp,
        cutoverFs: fsFailingRenameFrom(recorded),
      });

      expect(result.outcome).toBe('held');
      expect(result.sqliteCreationBlocked).toBe(true);
      expect(result.pgliteCreationBlocked).toBe(false);
      // Both copies still on disk, journal retained for the next attempt.
      expect(fs.existsSync(path.join(recorded, MARKER))).toBe(true);
      expect(fs.readdirSync(tmp).some((e) => e.startsWith('sqlite-db.rolledback-'))).toBe(true);
      expect(readCutoverJournal(tmp)).not.toBeNull();
    });
  });

  it('does not move the SQLite store when the recorded PGLite store cannot be verified', async () => {
    makeSqliteStore(sqliteDir);
    // Recorded, present, but empty -- not a PGLite store.
    fs.mkdirSync(recorded, { recursive: true });
    writeBackendState(tmp, {
      backend: 'sqlite',
      setAt: '2026-01-05T00:00:00.000Z',
      setBy: 'user-migration',
      pgliteMigratedDir: recorded,
    });

    await expect(
      runRollback({ userDataPath: tmp, quiesceSqlite: async () => {} }),
    ).rejects.toThrow();

    expect(fs.existsSync(path.join(sqliteDir, 'nimbalyst.sqlite'))).toBe(true);
    expect(readBackendState(tmp)?.backend).toBe('sqlite');
  });
});
