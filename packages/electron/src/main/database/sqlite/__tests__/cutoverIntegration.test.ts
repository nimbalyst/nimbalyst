// @vitest-environment node
/**
 * Cutover failure handling for the two callers that perform one.
 *
 * The data plane is stubbed on purpose -- `MigrationOrchestrator.test.ts` and
 * `MigrationAdopter`'s own coverage already drive a real PGLite through a real
 * copy, and repeating that here would buy nothing but ten seconds. What is
 * under test is the five filesystem-and-flag steps after the copy, so the
 * migrator is a stub and the failures are injected at the exact syscall the
 * field hits: a rename of a directory the OS will not let go of.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Only for the bridge-transport test at the bottom, which constructs a real
// `SQLiteDatabaseProxy`. The narrowest mocks that let that module load in a
// node environment; nothing else in this file touches either.
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir(), getAppPath: () => os.tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: () => {}, warn: () => {}, error: () => {} } },
}));

import { MigrationOrchestrator } from '../MigrationOrchestrator';
import { SQLiteDatabaseProxy } from '../SQLiteDatabaseProxy';
import { MigrationAdopter } from '../MigrationAdopter';
import { readBackendState } from '../BackendSelector';
import { createMigrationControl } from '../migrationControl';
import { abortRequiresRelaunch, asCutoverAbort } from '../cutoverMachine';
import { readCutoverJournal, type CutoverFs } from '../cutoverJournal';
import { DRY_RUN_MANIFEST_FILENAME } from '../MigrationDryRunner';
import type {
  CatchUpResult,
  DryRunManifest,
  MigrationSummary,
  PGLiteToSQLiteMigrator,
} from '../PGLiteToSQLiteMigrator';

const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');

const MANIFEST: DryRunManifest = { completedAt: new Date().toISOString(), durationMs: 1, perTable: [] };

const SUMMARY: MigrationSummary = {
  totalRowsCopied: 3,
  tablesCopied: [{ name: 'ai_sessions', rows: 3 }],
  durationMs: 5,
  integrityCheck: 'ok',
  foreignKeyViolations: 0,
  spotCheckCount: 1,
  manifest: MANIFEST,
};

const CATCH_UP: CatchUpResult = { rowsAdded: 0, perTable: [], manifest: MANIFEST };

/** Enough of the migrator for the cutover steps; the copy itself is not under test. */
function stubMigrator(): PGLiteToSQLiteMigrator {
  return {
    migrate: async () => ({ ...SUMMARY }),
    catchUp: async () => ({ ...CATCH_UP }),
  } as unknown as PGLiteToSQLiteMigrator;
}

const fakeReader = {
  queryReadOnly: async <T,>() => ({ rows: [{ c: 7 }] as unknown as T[] }),
};

const fakeReopen = async () => ({
  query: async <T,>() => ({ rows: [] as T[] }),
  exec: async () => undefined,
  close: async () => {},
});

/**
 * Real filesystem for everything except one rename, which fails with the error
 * code Windows produces when another handle still holds the directory. We do
 * not have Windows here; injecting the code is the honest substitute, and it
 * exercises the production branch that has to cope with it.
 */
function fsFailingRenameFrom(target: string, code: 'EPERM' | 'EBUSY'): CutoverFs {
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
        const err = new Error(`${code}: operation not permitted, rename '${from}'`) as NodeJS.ErrnoException;
        err.code = code;
        throw err;
      }
      fs.renameSync(from, to);
    },
  };
}

describe('cutover failure handling', () => {
  let tmp: string;
  let pgliteDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-cutover-'));
    pgliteDir = path.join(tmp, 'pglite-db');
    fs.mkdirSync(pgliteDir, { recursive: true });
    fs.writeFileSync(path.join(pgliteDir, 'PG_VERSION'), '15\n');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('migration: a source that will not close never gets renamed and never flips the flag', async () => {
    const orchestrator = new MigrationOrchestrator({
      userDataPath: tmp,
      schemaDir: SCHEMA_DIR,
      pglite: fakeReader,
      closeRunningPglite: async () => {
        throw new Error('PGLite worker did not acknowledge close');
      },
      reopenPgliteAfterClose: fakeReopen,
      migrator: stubMigrator(),
    });

    await expect(orchestrator.run()).rejects.toThrow(/did not acknowledge close/);

    expect(fs.existsSync(pgliteDir)).toBe(true);
    expect(fs.readdirSync(tmp).filter((d) => d.startsWith('pglite-db.migrated-'))).toEqual([]);
    expect(readBackendState(tmp)).toBeNull();
  });

  // The test above injects a `closeRunningPglite` that rejects, which proves
  // the cutover machine handles a rejected quiesce -- and proves nothing about
  // whether the thing production installs there ever rejects. It did not: the
  // callback in `initialize.ts` caught `database.close()` and logged
  // "proceeding anyway", so every layer below it saw a successful quiesce.
  // This runs the real control object; the transport that carries its answer
  // back to the worker is covered separately at the bottom of this file.
  it('migration: the production close handler propagates a failed PGLite close instead of reporting success', async () => {
    const control = createMigrationControl({
      closePglite: async () => {
        throw new Error('PGLite worker did not acknowledge close');
      },
    });

    const orchestrator = new MigrationOrchestrator({
      userDataPath: tmp,
      schemaDir: SCHEMA_DIR,
      pglite: fakeReader,
      // Exactly the composition production uses: the proxy's control handler
      // is what the worker's `closePglite` bridge call resolves to.
      closeRunningPglite: () => control.closePglite(),
      reopenPgliteAfterClose: fakeReopen,
      migrator: stubMigrator(),
    });

    await expect(orchestrator.run()).rejects.toThrow(/did not acknowledge close/);

    // A source that may still be taking writes was never moved, and nothing
    // pointed the next launch at SQLite.
    expect(fs.existsSync(path.join(pgliteDir, 'PG_VERSION'))).toBe(true);
    expect(fs.readdirSync(tmp).filter((d) => d.startsWith('pglite-db.migrated-'))).toEqual([]);
    expect(readBackendState(tmp)?.backend).not.toBe('sqlite');
    expect(readCutoverJournal(tmp)).toBeNull();
  });

  it('migration: a rename the OS refuses aborts the cutover instead of flipping the flag anyway', async () => {
    const orchestrator = new MigrationOrchestrator({
      userDataPath: tmp,
      schemaDir: SCHEMA_DIR,
      pglite: fakeReader,
      closeRunningPglite: async () => {},
      reopenPgliteAfterClose: fakeReopen,
      migrator: stubMigrator(),
      cutoverFs: fsFailingRenameFrom(pgliteDir, 'EPERM'),
    });

    await expect(orchestrator.run()).rejects.toThrow();

    // The old authoritative database is exactly where it was, and nothing told
    // the next launch to look somewhere else.
    expect(fs.existsSync(path.join(pgliteDir, 'PG_VERSION'))).toBe(true);
    expect(readBackendState(tmp)?.backend).not.toBe('sqlite');
    // The verified target is retained -- it is a recoverable copy, not garbage.
    expect(fs.existsSync(path.join(tmp, 'sqlite-db', 'nimbalyst.sqlite'))).toBe(true);
  });

  // PGLite is closed by `quiesceSource`, and the final catch-up runs after it.
  // The journal has to say so before the catch-up starts, because the caller's
  // only durable evidence that this launch has no database left is the phase.
  // Recording `source_quiesced` after the catch-up meant a catch-up failure
  // left the journal at `target_verified`, and boot read that as "PGLite is
  // still serving" and carried on against a closed worker.
  it('migration: a failed final catch-up leaves the journal recording that PGLite was closed', async () => {
    const orchestrator = new MigrationOrchestrator({
      userDataPath: tmp,
      schemaDir: SCHEMA_DIR,
      pglite: fakeReader,
      closeRunningPglite: async () => {},
      reopenPgliteAfterClose: async () => {
        throw new Error('could not reopen the quiesced PGLite store for final catch-up');
      },
      migrator: stubMigrator(),
    });

    const err = await orchestrator.run().then(
      () => null,
      (e) => e as Error,
    );

    expect(err?.message).toMatch(/could not reopen/);
    expect(asCutoverAbort(err)?.requiresRelaunch).toBe(true);

    const journal = readCutoverJournal(tmp);
    expect(journal?.phase).toBe('source_quiesced');
    // And the caller can act on it without re-deriving the rule.
    expect(abortRequiresRelaunch(asCutoverAbort(err), journal?.phase ?? null)).toBe(true);

    // Nothing moved: the source is intact and the flag still points at it.
    expect(fs.existsSync(path.join(pgliteDir, 'PG_VERSION'))).toBe(true);
    expect(readBackendState(tmp)?.backend).not.toBe('sqlite');
  });

  it('adoption: a rename the OS refuses leaves the dry run staged and the flag untouched', async () => {
    const dryRunDir = path.join(tmp, 'sqlite-db.dry-run-2026-09-02T00-00-00-000Z');
    fs.mkdirSync(dryRunDir, { recursive: true });
    fs.writeFileSync(path.join(dryRunDir, DRY_RUN_MANIFEST_FILENAME), JSON.stringify(MANIFEST));

    const adopter = new MigrationAdopter({
      userDataPath: tmp,
      schemaDir: SCHEMA_DIR,
      pglite: fakeReader,
      closeRunningPglite: async () => {},
      reopenPgliteAfterClose: fakeReopen,
      migrator: stubMigrator(),
      cutoverFs: fsFailingRenameFrom(pgliteDir, 'EBUSY'),
    });

    await expect(adopter.run()).rejects.toThrow();

    expect(fs.existsSync(path.join(pgliteDir, 'PG_VERSION'))).toBe(true);
    // The old adopter renamed the dry run into place regardless, which made the
    // flag file the only thing standing between the user and a store the app
    // could not find its way back from.
    expect(fs.existsSync(path.join(tmp, 'sqlite-db'))).toBe(false);
    expect(fs.existsSync(dryRunDir)).toBe(true);
    expect(readBackendState(tmp)?.backend).not.toBe('sqlite');
  });

  it('adoption: promotes the dry run, preserves the source, and leaves no journal', async () => {
    const dryRunDir = path.join(tmp, 'sqlite-db.dry-run-2026-09-02T00-00-00-000Z');
    fs.mkdirSync(dryRunDir, { recursive: true });
    fs.writeFileSync(path.join(dryRunDir, DRY_RUN_MANIFEST_FILENAME), JSON.stringify(MANIFEST));

    const adopter = new MigrationAdopter({
      userDataPath: tmp,
      schemaDir: SCHEMA_DIR,
      pglite: fakeReader,
      closeRunningPglite: async () => {},
      reopenPgliteAfterClose: fakeReopen,
      migrator: stubMigrator(),
    });

    const result = await adopter.run();

    expect(fs.existsSync(path.join(tmp, 'sqlite-db', 'nimbalyst.sqlite'))).toBe(true);
    expect(fs.existsSync(dryRunDir)).toBe(false);
    expect(fs.existsSync(path.join(result.pgliteMigratedDir, 'PG_VERSION'))).toBe(true);
    expect(readBackendState(tmp)?.backend).toBe('sqlite');
    expect(readBackendState(tmp)?.pgliteMigratedDir).toBe(result.pgliteMigratedDir);
    expect(readCutoverJournal(tmp)).toBeNull();
  });

  it('a completed migration leaves no journal behind', async () => {
    const orchestrator = new MigrationOrchestrator({
      userDataPath: tmp,
      schemaDir: SCHEMA_DIR,
      pglite: fakeReader,
      closeRunningPglite: async () => {},
      reopenPgliteAfterClose: fakeReopen,
      migrator: stubMigrator(),
    });

    await orchestrator.run();

    expect(readBackendState(tmp)?.backend).toBe('sqlite');
    expect(readCutoverJournal(tmp)).toBeNull();
    expect(fs.readdirSync(tmp).filter((d) => d.startsWith('pglite-db.migrated-'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

/**
 * The transport underneath that close.
 *
 * `createMigrationControl` is not what the worker talks to. The worker posts a
 * `workerControlRequest` event with a bridge id and waits for a
 * `bridgeResponse`; `SQLiteDatabaseProxy.handleWorkerEvent` is what turns the
 * control object's answer into that response. A test that calls
 * `control.closePglite()` directly proves the control object rejects and says
 * nothing about whether the rejection ever reaches the worker -- and a bridge
 * that answered `success: true` on a rejected close would put the cutover
 * exactly where the `initialize.ts` catch-and-log did.
 *
 * A stub worker rather than a real one: what is under test is the two branches
 * of `respondToBridge`, and spawning a thread to observe them would add seconds
 * and a build artifact dependency for no extra coverage.
 */
describe('the worker control bridge', () => {
  function proxyWithStubWorker(): { proxy: SQLiteDatabaseProxy; posted: unknown[] } {
    const posted: unknown[] = [];
    const proxy = new SQLiteDatabaseProxy({ dbDir: '/unused', schemaDir: '/unused' });
    // The worker is never spawned; the bridge only needs something to post to.
    (proxy as unknown as { worker: { postMessage(m: unknown): void } }).worker = {
      postMessage: (m) => { posted.push(m); },
    };
    return { proxy, posted };
  }

  const deliverCloseRequest = (proxy: SQLiteDatabaseProxy) =>
    (proxy as unknown as {
      handleWorkerEvent(msg: { event: string; bridgeId?: string; payload?: unknown }): void;
    }).handleWorkerEvent({
      event: 'workerControlRequest',
      bridgeId: 'bridge-1',
      payload: { action: 'closePglite' },
    });

  const settled = async (posted: unknown[]) => {
    for (let i = 0; i < 10 && posted.length === 0; i++) await Promise.resolve();
    return posted[0] as { bridgeId: string; success: boolean; error?: { message?: string } };
  };

  it('answers a rejected close with a failed bridge response', async () => {
    const { proxy, posted } = proxyWithStubWorker();
    proxy.setMigrationControl(
      createMigrationControl({
        closePglite: async () => {
          throw new Error('PGLite worker did not acknowledge close');
        },
      }),
    );

    deliverCloseRequest(proxy);

    const response = await settled(posted);
    expect(response.bridgeId).toBe('bridge-1');
    expect(response.success).toBe(false);
    expect(response.error?.message).toContain('did not acknowledge close');
  });

  it('answers a successful close with a successful bridge response', async () => {
    const { proxy, posted } = proxyWithStubWorker();
    proxy.setMigrationControl(createMigrationControl({ closePglite: async () => {} }));

    deliverCloseRequest(proxy);

    expect((await settled(posted)).success).toBe(true);
  });

  // No handler registered is not "the close worked". Nothing on the far side
  // of this bridge may read an unanswerable request as a quiesced database.
  it('answers a close it has no handler for as a failure', async () => {
    const { proxy, posted } = proxyWithStubWorker();

    deliverCloseRequest(proxy);

    const response = await settled(posted);
    expect(response.success).toBe(false);
    expect(response.error?.message).toContain('No migration control handler');
  });
});
