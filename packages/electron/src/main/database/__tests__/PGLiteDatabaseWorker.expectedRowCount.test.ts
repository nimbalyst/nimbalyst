import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electronShell = vi.hoisted(() => {
  const noop = () => undefined;
  return {
    app: {
      getAppPath: () => `${process.cwd()}\\packages\\electron`,
      getPath: (name: string) => name === 'userData'
        ? (process.env.NIMBALYST_USER_DATA_PATH ?? `${process.cwd()}\\.tmp-user-data`)
        : `${process.cwd()}\\.tmp-electron-path`,
      isPackaged: false,
      quit: noop,
    },
    dialog: { showMessageBox: async () => ({ response: 1 }), showErrorBox: noop },
  };
});
const loggerFacade = vi.hoisted(() => {
  const sink = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
  return { logger: { main: sink, database: sink, analytics: sink, ai: sink } };
});

vi.mock('electron', () => electronShell);
vi.mock('../../utils/logger', () => loggerFacade);
vi.mock('../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: () => undefined }) },
}));
vi.mock('../../services/database/DatabaseBackupService', () => ({
  DatabaseBackupService: class { async initialize() {} hasBackups() { return false; } },
}));
import { PGLiteDatabaseWorker, resolveCheckedInPGLiteWorkerPath } from '../PGLiteDatabaseWorker';

describe('PGLiteDatabaseWorker expectedRowCount transport', () => {
  let database: PGLiteDatabaseWorker | undefined;
  let userData: string | undefined;
  let priorUserData: string | undefined;

  afterEach(async () => {
    await database?.close().catch(() => undefined);
    if (priorUserData === undefined) delete process.env.NIMBALYST_USER_DATA_PATH;
    else process.env.NIMBALYST_USER_DATA_PATH = priorUserData;
    if (userData) fs.rmSync(userData, { recursive: true, force: true });
  });

  it('rolls back a guarded prefix through the checked-in worker transport', async () => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'nim364-pglite-worker-'));
    priorUserData = process.env.NIMBALYST_USER_DATA_PATH;
    process.env.NIMBALYST_USER_DATA_PATH = userData;
    database = new PGLiteDatabaseWorker({ workerPathOverride: resolveCheckedInPGLiteWorkerPath() });
    await database.initialize();
    await database.exec('CREATE TABLE tx_guard (id TEXT PRIMARY KEY, value TEXT)');

    await expect(database.runTransaction([
      { sql: 'INSERT INTO tx_guard(id, value) VALUES ($1, $2) RETURNING id', params: ['a', 'prefix'], expectedRowCount: 1 },
      { sql: 'UPDATE tx_guard SET value = $1 WHERE id = $2 RETURNING id', params: ['miss', 'missing'], expectedRowCount: 1 },
    ])).rejects.toThrow('transaction expected row count mismatch at statement 1: expected 1, got 0');

    const result = await database.query<{ id: string }>('SELECT id FROM tx_guard WHERE id = $1', ['a']);
    expect(result.rows).toEqual([]);
  });
});
