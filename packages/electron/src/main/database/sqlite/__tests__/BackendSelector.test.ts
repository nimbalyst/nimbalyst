import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  commitFreshInstallSqlite,
  commitMigrationToSqlite,
  commitRollbackToPglite,
  readBackendState,
  resolveBackend,
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

  it('stays on pglite when an existing pglite-db directory is present and no flag is set', () => {
    fs.mkdirSync(path.join(tmp, 'pglite-db'));
    const result = resolveBackend({ userDataPath: tmp });
    expect(result.backend).toBe('pglite');
    expect(result.reason).toBe('existing-pglite-no-flag');
  });

  it('obeys the flag file when present (sqlite)', () => {
    commitMigrationToSqlite(tmp, '/some/pglite-db.migrated-12345');
    const result = resolveBackend({ userDataPath: tmp });
    expect(result.backend).toBe('sqlite');
    expect(result.reason).toBe('flag-file-sqlite');
    expect(result.state?.pgliteMigratedDir).toBe('/some/pglite-db.migrated-12345');
  });

  it('obeys the flag file when present (pglite, after rollback)', () => {
    commitRollbackToPglite(tmp);
    const result = resolveBackend({ userDataPath: tmp });
    expect(result.backend).toBe('pglite');
    expect(result.reason).toBe('flag-file-pglite');
    expect(result.state?.setBy).toBe('rollback');
  });

  it('records the fresh-install marker on commitFreshInstallSqlite', () => {
    commitFreshInstallSqlite(tmp);
    const state = readBackendState(tmp);
    expect(state?.backend).toBe('sqlite');
    expect(state?.setBy).toBe('auto-fresh-install');
  });

  it('ignores a malformed flag file and falls back to inferring from disk', () => {
    fs.writeFileSync(path.join(tmp, 'database-backend.json'), '{not json');
    const result = resolveBackend({ userDataPath: tmp });
    expect(result.backend).toBe('sqlite'); // no pglite-db -> fresh install
  });
});
