// @vitest-environment node
/**
 * The delete guard on `db:recovery:delete-migrated`, and the exclusion between
 * destructive operations.
 *
 * `db:recovery:delete-migrated` is the only channel in RecoveryHandlers that
 * destroys a copy of a user's database, so it is the one worth a test:
 * everything else either reads, or delegates to the recovery transaction's own
 * coverage.
 *
 * The consent case is the important one. The guard used to be an
 * `acknowledgedRollbackLoss: true` boolean supplied by the *caller*, alongside
 * a `list-migrated` channel that hands the caller every directory name. Those
 * two together are a complete delete-everything primitive for anything that can
 * reach the IPC surface, with no human in the loop, so the test asserts that
 * asserting consent no longer buys the caller anything.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetDatabaseOperationLockForTests,
  withDatabaseOperationLock,
} from '../../database/databaseOperationLock';

const handlers = new Map<string, (event: unknown, ...args: any[]) => any>();

/** What the main-process confirmation dialog will answer. 0 = Cancel, 1 = Delete. */
let dialogResponse = 0;
/**
 * Typed on the options argument so the assertions below can read what the user
 * was actually shown. Declared with no parameter, `mock.calls[0]` is an empty
 * tuple and every read of the dialog copy is an unchecked cast.
 */
interface ConfirmDialogOptions {
  detail: string;
  message?: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}
const showMessageBox = vi.fn(async (_options: ConfirmDialogOptions) => ({
  response: dialogResponse,
}));

vi.mock('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  shell: { showItemInFolder: vi.fn() },
  dialog: {
    showMessageBox: (...args: unknown[]) =>
      showMessageBox(...(args as [ConfirmDialogOptions])),
  },
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, handler: (event: unknown, ...args: any[]) => any) => {
    handlers.set(channel, handler);
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('../../utils/appPaths', () => ({ getPackageRoot: () => '/nonexistent' }));

vi.mock('../../database/PGLiteDatabaseWorker', () => ({ database: {} }));

// The recovery engine is not under test here and pulls in native modules. The
// path helpers are the real behaviour, so they are implemented rather than
// stubbed: a `getUserDataPath` that ignored the env var would make every guard
// below assert against the wrong directory.
const recoverSpy = vi.fn(async () => ({ ok: false, code: 'candidate_empty' }));
vi.mock('../../database/recovery', () => ({
  activeBackend: () => 'sqlite',
  buildProductionRecoveryService: () => ({
    listCandidates: () => Promise.resolve([]),
    proactiveOffer: () => Promise.resolve(null),
    recover: (...args: unknown[]) => recoverSpy(...(args as [])),
    markResolved: () => Promise.resolve(),
  }),
  getUserDataPath: () => process.env.NIMBALYST_USER_DATA_PATH!,
  liveDatabasePath: (u: string) => path.join(u, 'sqlite-db', 'nimbalyst.sqlite'),
  pgliteWorkerPath: () => '/nonexistent/worker.bundle.js',
  sizeBucketFor: () => 'empty',
  timestampFromArtifactName: () => null,
}));

import { registerRecoveryHandlers } from '../RecoveryHandlers';

let userDataPath: string;

function deleteMigrated(args: unknown) {
  return handlers.get('db:recovery:delete-migrated')!(null, args);
}

describe('db:recovery:delete-migrated', () => {
  beforeEach(() => {
    userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-recovery-'));
    process.env.NIMBALYST_USER_DATA_PATH = userDataPath;
    dialogResponse = 0;
    showMessageBox.mockClear();
    recoverSpy.mockClear();
    resetDatabaseOperationLockForTests();
    handlers.clear();
    registerRecoveryHandlers();
  });

  afterEach(() => {
    delete process.env.NIMBALYST_USER_DATA_PATH;
    fs.rmSync(userDataPath, { recursive: true, force: true });
  });

  function makeMigratedDir(name: string): string {
    const dir = path.join(userDataPath, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'base.db'), 'x');
    return dir;
  }

  it('refuses a directory that discovery did not find', async () => {
    const bystander = path.join(userDataPath, 'pglite-db');
    fs.mkdirSync(bystander);

    // A live database, a traversal, and a plausible-looking name that is not
    // on disk all have to be refused without touching anything.
    for (const name of ['pglite-db', '../pglite-db', 'pglite-db.migrated-2026-08-19T09-00-00-000Z']) {
      const result = await deleteMigrated({ name });
      expect(result.success).toBe(false);
    }
    expect(fs.existsSync(bystander)).toBe(true);
  });

  const ROLLBACK_SOURCE = 'pglite-db.migrated-2026-08-19T09-00-00-000Z';

  function markAsRollbackSourceInFlag(name: string): void {
    fs.writeFileSync(
      path.join(userDataPath, 'database-backend.json'),
      JSON.stringify({
        backend: 'sqlite',
        setAt: new Date().toISOString(),
        setBy: 'user-migration',
        pgliteMigratedDir: name,
      }),
    );
  }

  /**
   * The finding this test exists for. `acknowledgedRollbackLoss` was consent
   * the untrusted caller supplied about itself, next to a channel that hands
   * that caller every deletable directory name. Passing it must now buy
   * nothing: main asks, and main reads the answer.
   */
  it('ignores a caller-asserted acknowledgement and asks the user itself', async () => {
    const dir = makeMigratedDir(ROLLBACK_SOURCE);
    markAsRollbackSourceInFlag(ROLLBACK_SOURCE);
    dialogResponse = 0; // the user cancels

    const result = await deleteMigrated({
      name: ROLLBACK_SOURCE,
      acknowledgedRollbackLoss: true,
    });

    expect(result.success).toBe(false);
    expect(result.declined).toBe(true);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('deletes only after the user confirms, and names what is being lost', async () => {
    const dir = makeMigratedDir(ROLLBACK_SOURCE);
    markAsRollbackSourceInFlag(ROLLBACK_SOURCE);
    dialogResponse = 1; // the user confirms

    expect((await deleteMigrated({ name: ROLLBACK_SOURCE })).success).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);

    const shown = showMessageBox.mock.calls[0][0] as {
      detail: string;
      buttons: string[];
      defaultId: number;
      cancelId: number;
    };
    expect(shown.detail).toContain(ROLLBACK_SOURCE);
    expect(shown.detail).toContain('rolled back');
    // Neither Enter nor Escape may delete anything.
    expect(shown.buttons[shown.defaultId]).toBe('Cancel');
    expect(shown.buttons[shown.cancelId]).toBe('Cancel');
  });

  /**
   * A cutover renames the source aside and only then commits the backend flag.
   * Consulting the flag alone reported the directory the journal owns as an
   * ordinary migrated copy for the whole of that window.
   */
  it('treats a directory the cutover journal owns as the rollback source', async () => {
    const name = 'pglite-db.migrated-2026-09-01T12-00-00-000Z';
    makeMigratedDir(name);
    // No `pgliteMigratedDir` in the flag: this is mid-cutover.
    fs.writeFileSync(
      path.join(userDataPath, 'database-cutover.json'),
      JSON.stringify({
        version: 1,
        operationId: 'op-1',
        operation: 'migrate',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        phase: 'source_preserved',
        reconcileAttempts: 0,
        source: {
          livePath: path.join(userDataPath, 'pglite-db'),
          preservedPath: path.join(userDataPath, name),
          fingerprint: { entryCount: 1, totalBytes: 1, newestMtimeMs: 0 },
        },
        commitSetBy: 'user-migration',
        target: { livePath: path.join(userDataPath, 'sqlite-db') },
        rollback: { backendBefore: 'pglite', stateBefore: null },
      }),
    );

    const listed = await handlers.get('db:recovery:list-migrated')!(null);
    expect(listed.copies.find((c: { name: string }) => c.name === name).isRollbackSource).toBe(true);

    dialogResponse = 1;
    await deleteMigrated({ name });
    expect((showMessageBox.mock.calls[0][0] as { detail: string }).detail).toContain('rolled back');
  });
});

/**
 * Recovery, migration, adoption, dry-run and rollback all close, rename and
 * reopen the same engine. Nothing excluded them from each other; the worker's
 * `migrationRunning` flag only keeps migrations away from other migrations.
 */
describe('destructive operations exclude each other', () => {
  beforeEach(() => {
    userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-recovery-lock-'));
    process.env.NIMBALYST_USER_DATA_PATH = userDataPath;
    resetDatabaseOperationLockForTests();
    recoverSpy.mockClear();
    handlers.clear();
    registerRecoveryHandlers();
  });

  afterEach(() => {
    resetDatabaseOperationLockForTests();
    delete process.env.NIMBALYST_USER_DATA_PATH;
    fs.rmSync(userDataPath, { recursive: true, force: true });
  });

  it('refuses a recovery while a migration holds the lock, without starting one', async () => {
    let release: () => void = () => {};
    const migrationRunning = withDatabaseOperationLock(
      'migration',
      () => new Promise<void>((resolve) => { release = resolve; }),
    );

    const result = await handlers.get('db:recovery:recover')!(null, {
      candidateId: 'artifact:x',
      expectedFingerprint: 'f',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('migration');
    // The point: it did not start and then discover the conflict.
    expect(recoverSpy).not.toHaveBeenCalled();

    release();
    await migrationRunning;

    // And once the migration is done, recovery runs normally.
    await handlers.get('db:recovery:recover')!(null, {
      candidateId: 'artifact:x',
      expectedFingerprint: 'f',
    });
    expect(recoverSpy).toHaveBeenCalledTimes(1);
  });
});
