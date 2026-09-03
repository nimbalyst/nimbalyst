// @vitest-environment node
/**
 * Exclusion between the migration channels and everything else destructive,
 * and the rollback channel end to end.
 *
 * Before the shared lock these four channels guarded themselves with three
 * module-level booleans that only ever excluded migration operations from each
 * other -- and `db:migration:start` checked only its own, so a migration could
 * begin while a dry run was still reading the source. Recovery and backup
 * restore, which close the same engine and rename the same directories, were
 * not considered at all.
 *
 * The rollback case is exercised against real directories: it is the operation
 * that moves two of them in sequence with no database live in between.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetDatabaseOperationLockForTests,
  withDatabaseOperationLock,
} from '../../database/databaseOperationLock';
import { readBackendState, writeBackendState } from '../../database/sqlite/BackendSelector';

const handlers = new Map<string, (event: unknown, ...args: any[]) => any>();

const relaunch = vi.fn();
const quit = vi.fn();

vi.mock('electron', () => ({
  app: {
    getPath: () => '',
    relaunch: () => relaunch(),
    quit: () => quit(),
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

vi.mock('../../services/analytics/AnalyticsService', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));

/** Stands in for the SQLite worker proxy; the only thing rollback asks of it. */
const closeLiveSqlite = vi.fn(async () => {});
const getMigrationProxy = vi.fn(async () => {
  throw new Error('the proxy should not have been reached');
});

vi.mock('../../database/initialize', () => ({
  getLiveSqliteDatabaseProxy: () => ({ close: () => closeLiveSqlite() }),
  getMigrationProxy: () => getMigrationProxy(),
  stopPeriodicBackupTimer: vi.fn(),
}));

import { registerMigrationHandlers } from '../MigrationHandlers';

const MARKER = 'PG_VERSION';

let userDataPath: string;
let pgliteDir: string;
let sqliteDir: string;
let recorded: string;

function invoke(channel: string, args?: unknown) {
  return handlers.get(channel)!(null, args);
}

/** A migrated install: SQLite live, one recorded preserved PGLite store. */
function migratedInstall(): void {
  fs.mkdirSync(sqliteDir, { recursive: true });
  fs.writeFileSync(path.join(sqliteDir, 'nimbalyst.sqlite'), Buffer.alloc(128 * 1024, 1));
  fs.mkdirSync(recorded, { recursive: true });
  fs.writeFileSync(path.join(recorded, MARKER), 'the database this install migrated from');
  writeBackendState(userDataPath, {
    backend: 'sqlite',
    setAt: '2026-01-05T00:00:00.000Z',
    setBy: 'user-migration',
    pgliteMigratedDir: recorded,
  });
}

describe('migration IPC channels', () => {
  beforeEach(() => {
    userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-migration-ipc-'));
    process.env.NIMBALYST_USER_DATA_PATH = userDataPath;
    pgliteDir = path.join(userDataPath, 'pglite-db');
    sqliteDir = path.join(userDataPath, 'sqlite-db');
    recorded = path.join(userDataPath, 'pglite-db.migrated-2026-01-05T00-00-00-000Z');
    handlers.clear();
    resetDatabaseOperationLockForTests();
    relaunch.mockClear();
    quit.mockClear();
    closeLiveSqlite.mockClear();
    getMigrationProxy.mockClear();
    registerMigrationHandlers();
  });

  afterEach(() => {
    delete process.env.NIMBALYST_USER_DATA_PATH;
    fs.rmSync(userDataPath, { recursive: true, force: true });
  });

  /** Hold the lock the way a real operation does, and run `body` inside it. */
  async function whileHolding(
    kind: 'recovery' | 'migration' | 'rollback' | 'backup-restore',
    body: () => Promise<void>,
  ): Promise<void> {
    const held = await withDatabaseOperationLock(kind, body);
    expect(held.acquired).toBe(true);
  }

  it.each([
    ['db:migration:start', 'recovery'],
    ['db:migration:dry-run', 'recovery'],
    ['db:migration:adopt-dry-run', 'backup-restore'],
    ['db:migration:start', 'rollback'],
  ] as const)('%s refuses while %s holds the lock', async (channel, holder) => {
    await whileHolding(holder, async () => {
      const result = await invoke(channel);
      expect(result.success).toBe(false);
      expect(result.error).toContain(holder);
      // Refused before anything was asked of the worker: a handler that
      // reported the conflict *after* spawning the migration pipeline would
      // have already started reading the source.
      expect(getMigrationProxy).not.toHaveBeenCalled();
    });
  });

  it('rollback refuses while a migration holds the lock, and moves nothing', async () => {
    migratedInstall();
    const before = fs.readdirSync(userDataPath).sort();

    await whileHolding('migration', async () => {
      const result = await invoke('db:migration:rollback');
      expect(result.success).toBe(false);
      expect(result.error).toContain('migration');
    });

    expect(fs.readdirSync(userDataPath).sort()).toEqual(before);
    expect(closeLiveSqlite).not.toHaveBeenCalled();
    expect(readBackendState(userDataPath)?.backend).toBe('sqlite');
  });

  it('rollback restores the recorded store and releases the lock afterwards', async () => {
    migratedInstall();
    // A second preserved store that sorts later. The rollback that shipped
    // took the lexically last name, which is this one.
    const stranger = path.join(userDataPath, 'pglite-db.migrated-2026-09-01T00-00-00-000Z');
    fs.mkdirSync(stranger, { recursive: true });
    fs.writeFileSync(path.join(stranger, MARKER), 'an unrelated preserved store');

    const result = await invoke('db:migration:rollback');

    expect(result.success).toBe(true);
    expect(result.restoredFrom).toBe(path.basename(recorded));
    expect(fs.readFileSync(path.join(pgliteDir, MARKER), 'utf-8')).toBe(
      'the database this install migrated from',
    );
    expect(closeLiveSqlite).toHaveBeenCalledTimes(1);
    expect(readBackendState(userDataPath)?.setBy).toBe('rollback');
    // Nothing is deleted: the retired SQLite store and the stranger both stay.
    expect(fs.readdirSync(userDataPath).some((e) => e.startsWith('sqlite-db.rolledback-'))).toBe(true);
    expect(fs.existsSync(path.join(stranger, MARKER))).toBe(true);

    // The lock is released on the way out, so a second operation can run.
    const second = await withDatabaseOperationLock('recovery', async () => 'ran');
    expect(second).toEqual({ acquired: true, value: 'ran' });
  });

  it('reports the status of whichever operation holds the lock', async () => {
    await whileHolding('migration', async () => {
      const status = await invoke('db:migration:get-status');
      expect(status.running).toBe(true);
      expect(status.runningDryRun).toBe(false);
    });
    const idle = await invoke('db:migration:get-status');
    expect(idle.running).toBe(false);
  });
});
