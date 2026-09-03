// @vitest-environment node
/**
 * The SQLite worker's migration dispatch, exercised through the production
 * entry point rather than a hand-built options object.
 *
 * `MigrationAdopter` already had a plausibility test, and it was false-green:
 * it constructed the adopter itself and passed `configuredProjectCount`, while
 * the worker case that actually runs an adoption in production never did. The
 * adopter therefore assessed every real install as having zero projects, which
 * is the permissive value -- the check could not fire on the one path that
 * commits a cutover. So the assertion has to be about what the *caller* hands
 * over, which is why the adopter and orchestrator are the mocks here and the
 * dispatch is the code under test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const adopterCtor = vi.fn();
const orchestratorCtor = vi.fn();

vi.mock('../MigrationAdopter', () => ({
  MigrationAdopter: class {
    constructor(opts: unknown) {
      adopterCtor(opts);
    }
    findDryRunDir() {
      return null;
    }
    run() {
      return Promise.resolve({
        rowsAdded: 0,
        perTable: [],
        pgliteMigratedDir: '/tmp/pglite-db.migrated-x',
        sqliteDir: '/tmp/sqlite-db',
        durationMs: 1,
      });
    }
  },
}));

vi.mock('../MigrationOrchestrator', () => ({
  MigrationOrchestrator: class {
    constructor(opts: unknown) {
      orchestratorCtor(opts);
    }
    preflight() {
      return Promise.resolve({ ok: true, pgliteDirBytes: 1, freeBytes: 2, requiredBytes: 1 });
    }
    run() {
      return Promise.resolve({
        totalRowsCopied: 0,
        tablesCopied: [],
        durationMs: 1,
        integrityCheck: 'ok',
        foreignKeyViolations: 0,
        spotCheckCount: 0,
      });
    }
  },
}));

import { handleMigrationRequest, type MigrationRequestDeps } from '../worker/migrationRequests';

let deps: MigrationRequestDeps;

beforeEach(() => {
  adopterCtor.mockClear();
  orchestratorCtor.mockClear();
  deps = {
    buildPgliteReader: () => ({ queryReadOnly: async () => ({ rows: [] }) }),
    closeRunningPglite: async () => undefined,
    reopenPgliteAfterClose: async () => {
      throw new Error('not used');
    },
    makeReporter: () => undefined,
    emit: vi.fn(),
    log: () => {},
    countConfiguredProjects: () => 7,
  };
});

const payload = { userDataPath: '/tmp/nim', schemaDir: '/tmp/schemas', operationId: 'op-1' };

describe('worker migration dispatch', () => {
  it('gives the adopter the same project count the orchestrator gets', async () => {
    await handleMigrationRequest('migrationAdoptDryRun', payload, deps);

    expect(adopterCtor).toHaveBeenCalledTimes(1);
    expect(adopterCtor.mock.calls[0][0]).toMatchObject({ configuredProjectCount: 7 });
  });

  it('gives the orchestrator the project count on both preflight and run', async () => {
    await handleMigrationRequest('migrationPreflight', payload, deps);
    await handleMigrationRequest('migrationStart', payload, deps);

    expect(orchestratorCtor).toHaveBeenCalledTimes(2);
    for (const call of orchestratorCtor.mock.calls) {
      expect(call[0]).toMatchObject({ configuredProjectCount: 7 });
    }
  });
});
