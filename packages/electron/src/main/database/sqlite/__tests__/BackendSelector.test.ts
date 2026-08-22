// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  commitFreshInstallSqlite,
  commitMigrationToSqlite,
  commitRollbackToPglite,
  readBackendState,
  recordAutoMigrationFailure,
  resolveBackend,
  updateBackendState,
} from '../BackendSelector';

describe('BackendSelector', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-backend-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns sqlite on a fresh install (no pglite-db, no flag)', () => {
    const result = resolveBackend({ userDataPath: tmp });
    expect(result.backend).toBe('sqlite');
    expect(result.reason).toBe('fresh-install-defaults-sqlite');
  });

  it('marks an existing pglite-db directory with no flag as migration-due', () => {
    fs.mkdirSync(path.join(tmp, 'pglite-db'));
    const result = resolveBackend({ userDataPath: tmp });
    expect(result.backend).toBe('pglite');
    expect(result.reason).toBe('existing-pglite-migration-due');
    expect(result.migrationDue).toBe(true);
  });

  it('obeys the flag file when present (sqlite)', () => {
    commitMigrationToSqlite(tmp, '/some/pglite-db.migrated-12345');
    const result = resolveBackend({ userDataPath: tmp });
    expect(result.backend).toBe('sqlite');
    expect(result.reason).toBe('flag-file-sqlite');
    expect(result.state?.pgliteMigratedDir).toBe('/some/pglite-db.migrated-12345');
  });

  it('never re-migrates an install that rolled back to pglite', () => {
    fs.mkdirSync(path.join(tmp, 'pglite-db'));
    commitRollbackToPglite(tmp);
    const result = resolveBackend({ userDataPath: tmp });
    expect(result.backend).toBe('pglite');
    expect(result.reason).toBe('flag-file-pglite-rollback');
    expect(result.state?.setBy).toBe('rollback');
    // The whole point: they told us SQLite went badly. Auto-migration must
    // not drag them back onto it.
    expect(result.migrationDue).toBe(false);
  });

  it('records the fresh-install marker on commitFreshInstallSqlite', () => {
    commitFreshInstallSqlite(tmp);
    const state = readBackendState(tmp);
    expect(state?.backend).toBe('sqlite');
    expect(state?.setBy).toBe('auto-fresh-install');
  });

  // #1347: the kill-switch cache refresh runs on every launch, including a
  // fresh install's first. When it defaulted the backend to pglite, every
  // fresh install flipped to `existing-pglite-migration-due` on its second
  // launch and grew a PGLite database it should never have had.
  it('does not decide the backend when a sibling-field update finds no state', () => {
    expect(updateBackendState(tmp, { forceMigrationFlag: false })).toBeNull();
    expect(readBackendState(tmp)).toBeNull();
    expect(resolveBackend({ userDataPath: tmp }).reason).toBe('fresh-install-defaults-sqlite');
  });

  it('keeps a fresh install on sqlite across the kill-switch cache refresh', () => {
    commitFreshInstallSqlite(tmp);
    updateBackendState(tmp, { forceMigrationFlag: false });
    const result = resolveBackend({ userDataPath: tmp });
    expect(result.backend).toBe('sqlite');
    expect(result.reason).toBe('flag-file-sqlite');
    expect(readBackendState(tmp)?.forceMigrationFlag).toBe(false);
  });

  it('still merges sibling fields into existing state without losing them', () => {
    commitMigrationToSqlite(tmp, '/some/pglite-db.migrated-12345');
    updateBackendState(tmp, { forceMigrationFlag: true });
    const state = readBackendState(tmp);
    expect(state?.backend).toBe('sqlite');
    expect(state?.setBy).toBe('user-migration');
    expect(state?.pgliteMigratedDir).toBe('/some/pglite-db.migrated-12345');
    expect(state?.forceMigrationFlag).toBe(true);
  });

  // The one caller that legitimately creates state from nothing: it names both
  // backend and setBy, so the guard above must not block it.
  it('records a first auto-migration failure even with no prior flag file', () => {
    expect(recordAutoMigrationFailure(tmp, 'disk_space')).toBe(1);
    const state = readBackendState(tmp);
    expect(state?.backend).toBe('pglite');
    expect(state?.setBy).toBe('auto-migration-deferred');
    expect(state?.migrationAttempts?.count).toBe(1);
  });

  it('ignores a malformed flag file and falls back to inferring from disk', () => {
    fs.writeFileSync(path.join(tmp, 'database-backend.json'), '{not json');
    const result = resolveBackend({ userDataPath: tmp });
    expect(result.backend).toBe('sqlite'); // no pglite-db -> fresh install
  });

  // #1347, second variant. The write-side fix above stops NEW poison; these
  // cover installs whose flag file was already wrong when they upgraded.
  // Every signal here comes from outside the flag file, because a flag file
  // cannot vouch for itself -- see `migrationSourcePlausibility.ts` (NIM-3632).
  describe('contradicted flag file (NIM-3686)', () => {
    /** A SQLite store with plausible content in it. */
    const writeSqliteDb = (bytes: number) => {
      fs.mkdirSync(path.join(tmp, 'sqlite-db'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'sqlite-db', 'nimbalyst.sqlite'), Buffer.alloc(bytes));
    };

    /** The exact state pre-0.74.2 builds wrote over a fresh SQLite install. */
    const writePoisonedFlag = () => {
      fs.writeFileSync(
        path.join(tmp, 'database-backend.json'),
        JSON.stringify({
          backend: 'pglite',
          setAt: '2026-08-20T15:00:46.561Z',
          setBy: 'auto-migration-deferred',
          forceMigrationFlag: false,
        }),
      );
    };

    it('refuses a pglite flag when pglite-db is absent and sqlite-db holds data', () => {
      writePoisonedFlag();
      writeSqliteDb(64 * 1024 * 1024);
      const result = resolveBackend({ userDataPath: tmp });
      expect(result.backend).toBe('sqlite');
      expect(result.reason).toBe('flag-contradiction-healed-sqlite');
      expect(result.migrationDue).toBe(false);
    });

    // Two boots, because the bug only appears on launch two and because
    // `commitFreshInstallSqlite` was once green-tested with zero callers.
    it('persists the correction so the second launch is no longer contradicted', () => {
      writePoisonedFlag();
      writeSqliteDb(64 * 1024 * 1024);

      resolveBackend({ userDataPath: tmp }); // boot 1: heals
      expect(readBackendState(tmp)?.backend).toBe('sqlite');

      const second = resolveBackend({ userDataPath: tmp }); // boot 2: ordinary
      expect(second.backend).toBe('sqlite');
      expect(second.reason).toBe('flag-file-sqlite');
      expect(second.migrationDue).toBe(false);
    });

    it('heals the symmetric case: sqlite flag, no sqlite-db, pglite-db present', () => {
      fs.mkdirSync(path.join(tmp, 'pglite-db'));
      commitMigrationToSqlite(tmp, '/some/pglite-db.migrated-12345');
      const result = resolveBackend({ userDataPath: tmp });
      expect(result.backend).toBe('pglite');
      expect(result.reason).toBe('flag-contradiction-healed-pglite');
    });

    it('honours the flag when both stores exist -- that is the ordinary migration path', () => {
      fs.mkdirSync(path.join(tmp, 'pglite-db'));
      writePoisonedFlag();
      writeSqliteDb(64 * 1024 * 1024);
      const result = resolveBackend({ userDataPath: tmp });
      expect(result.backend).toBe('pglite');
      expect(result.reason).toBe('existing-pglite-migration-due');
      expect(result.migrationDue).toBe(true);
    });

    // A zero-byte or half-created file is not evidence of anything, and
    // overriding on it would be its own way to strand a user.
    it('does not heal on a stub sqlite file below the floor', () => {
      writePoisonedFlag();
      writeSqliteDb(1024);
      const result = resolveBackend({ userDataPath: tmp });
      expect(result.reason).toBe('existing-pglite-migration-due');
    });

    // The floor must sit below a schema-only store, not above it. An empty
    // database at migration v34 is ~836 KB before any message is written; the
    // first draft used a 1 MB floor and left exactly this install booting
    // empty. Sized from a real fixture, not guessed.
    it('heals a light install whose store is barely larger than the bare schema', () => {
      writePoisonedFlag();
      writeSqliteDb(856_064);
      const result = resolveBackend({ userDataPath: tmp });
      expect(result.backend).toBe('sqlite');
      expect(result.reason).toBe('flag-contradiction-healed-sqlite');
    });

    it('leaves a rollback install alone even with no pglite-db on disk', () => {
      commitRollbackToPglite(tmp);
      writeSqliteDb(64 * 1024 * 1024);
      const result = resolveBackend({ userDataPath: tmp });
      expect(result.backend).toBe('pglite');
      expect(result.reason).toBe('flag-file-pglite-rollback');
    });
  });
});
