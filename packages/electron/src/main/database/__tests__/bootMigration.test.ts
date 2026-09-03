// @vitest-environment node
/**
 * Where the boot migration takes its lease, and what a refused one means.
 *
 * Two properties, both of which are quiet failures if they break:
 *
 *   - **Exactly one lease per operation.** `migration` has two entry points --
 *     this one and `db:migration:start` -- and the lease belongs at each of
 *     them, never below. The lock is not reentrant, so a second acquisition
 *     anywhere under `runForcedMigration` would be refused and the migration
 *     would fail against itself. Asserting that `maybeAutoMigrate` actually
 *     runs is what catches that.
 *   - **A refused lease at boot is not a startup error.** Something else is
 *     already moving the database; the right answer is to leave it alone and
 *     boot on PGLite, which is what every non-migrating outcome does anyway.
 *
 * The lock is the real one. Everything either side of it is stubbed, because
 * the decision to migrate and the migration itself are covered elsewhere.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  currentDatabaseOperation,
  resetDatabaseOperationLockForTests,
  withDatabaseOperationLock,
} from '../databaseOperationLock';
import type { ResolvedBackend } from '../sqlite/BackendSelector';
import type { SQLiteDatabaseProxy } from '../sqlite/SQLiteDatabaseProxy';

const maybeAutoMigrate = vi.fn(async () => ({ action: 'skipped', reason: 'not-due' as const }));

vi.mock('electron', () => ({ app: { relaunch: vi.fn(), quit: vi.fn() } }));
vi.mock('../sqlite/autoMigrate', () => ({ maybeAutoMigrate: (...a: unknown[]) => maybeAutoMigrate(...(a as [])) }));
vi.mock('../sqlite/migrationFlag', () => ({ authorizeRollout: async () => ({ authorized: false }) }));
vi.mock('../../utils/store', () => ({ getReleaseChannel: () => 'alpha' }));
vi.mock('../../window/SplashScreen', () => ({
  enterSplashMigrationMode: vi.fn(),
  updateSplashMigrationProgress: vi.fn(),
}));
vi.mock('../../window/migrationProgressView', () => ({ buildSplashView: () => ({ percent: 0 }) }));
vi.mock('../sqlite/migrationEventMapper', () => ({ emitMigrationOutcome: vi.fn() }));
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { runForcedMigration } from '../bootMigration';

const resolved = { backend: 'pglite', reason: 'existing-pglite-migration-due', state: null, migrationDue: true } as ResolvedBackend;
const proxy = { setMigrationObserver: vi.fn() } as unknown as SQLiteDatabaseProxy;

describe('the boot migration lease', () => {
  let userDataPath: string;

  beforeEach(() => {
    userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-boot-migration-'));
    resetDatabaseOperationLockForTests();
    maybeAutoMigrate.mockClear();
  });

  afterEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  });

  function run() {
    return runForcedMigration({ userDataPath, schemaDir: path.join(userDataPath, 'schemas'), resolved, proxy });
  }

  it('boots on PGLite instead of failing when another operation holds the lock', async () => {
    const held = await withDatabaseOperationLock('recovery', async () => {
      // Resolves false rather than throwing: the caller's contract is "false
      // means carry on with the database you already have".
      await expect(run()).resolves.toBe(false);
      // And it decided that without asking whether to migrate, because the
      // answer would have been gathered against paths a recovery is moving.
      expect(maybeAutoMigrate).not.toHaveBeenCalled();
    });
    expect(held.acquired).toBe(true);
  });

  it('takes the lease at this level only, and releases it', async () => {
    // A second acquisition anywhere below here would be refused and this call
    // would never reach the decision.
    await expect(run()).resolves.toBe(false);
    expect(maybeAutoMigrate).toHaveBeenCalledTimes(1);
    expect(currentDatabaseOperation()).toBeNull();
  });
});
