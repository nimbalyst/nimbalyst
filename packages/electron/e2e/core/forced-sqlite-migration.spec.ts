/**
 * PGLite -> SQLite migration and rollback, through real Electron launches, with
 * a known piece of user data on the line.
 *
 * `autoMigrate.test.ts` already proves the migration logic against a PGLite
 * fixture. What only a launch can prove is that a row the app wrote through
 * `sessions:create` is still readable through `sessions:get` after the cutover,
 * after the restart, after the rollback, and after the restart back. Safety
 * invariant 10 of `pglite-to-sqlite-migration-retry.md`: directory existence,
 * backend flags and app readiness are secondary; preservation of known user
 * data through restart is the assertion.
 *
 * ## Which migration path this drives, and why not the boot one
 *
 * The previous version of this spec armed a boot-time migration by writing
 * `forceMigrationFlag: true` into `database-backend.json`. That field is now
 * `@deprecated Never read` (`BackendSelector.ts`). Boot migration asks
 * `authorizeRollout()` on the launch that would migrate, which needs a live
 * PostHog payload whose `configVersion` appears in `ACCEPTED_CONFIG_VERSIONS`
 * -- and that list is deliberately empty, so no payload of any shape can
 * authorize one. There is no env var, IPC channel or file that arms it either.
 *
 * So a packaged E2E cannot currently reach the automatic path at all. It can
 * reach the user-directed one: `db:migration:start` and `db:migration:rollback`
 * are what Settings > Database calls, and they run the same journaled cutover
 * (`runCutover`) that the boot path runs. That is what this spec drives. The
 * gap -- no test seam for the authorization decision -- is real and is called
 * out here so the next reader does not conclude the automatic path is covered.
 *
 * Note the app quits rather than relaunches under PLAYWRIGHT (see
 * `MigrationHandlers.relaunchAfterReply`) so the runner is never left holding
 * an Electron process it did not spawn.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs';
import { PGlite } from '@electric-sql/pglite';
import * as path from 'path';

import { launchElectronApp, createTempWorkspace, waitForAppReady } from '../helpers';
import {
  DB_LIFECYCLE_DIR,
  DB_LIFECYCLE_ENV,
  FLAG_FILE,
  PGLITE_DIR,
  SQLITE_DIR,
  dirsMatching,
  ensureConfiguredProject,
  expectSentinelIntact,
  makeSentinel,
  pinToPglite,
  readFlag,
  readSentinel,
  resetDbLifecycleDir,
  writeSentinel,
  writeSentinelFile,
  type DatabaseSentinel,
} from '../utils/databaseSentinel';

/** Four Electron launches plus a real cutover; the 15s default is for UI specs. */
const LIFECYCLE_TIMEOUT_MS = 300_000;

let workspace: string;
let app: ElectronApplication | null = null;

async function launch(): Promise<Page> {
  app = await launchElectronApp({
    workspace,
    preserveTestDatabase: true,
    env: DB_LIFECYCLE_ENV,
  });
  const page = await app.firstWindow();
  await waitForAppReady(page);
  return page;
}

async function shutdown(): Promise<void> {
  await app?.close().catch(() => undefined);
  app = null;
}

/** Invoke a `db:migration:*` channel and return whatever it answered. */
async function migrationCall(page: Page, channel: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (ch) => {
    const api = (window as { electronAPI?: { invoke: (c: string) => Promise<unknown> } }).electronAPI;
    if (!api) return { success: false, error: 'no electronAPI' };
    try {
      return await api.invoke(ch) as Record<string, unknown>;
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }, channel);
}

test.beforeEach(async () => {
  workspace = await createTempWorkspace();
  resetDbLifecycleDir();
});

test.afterEach(async () => {
  await shutdown();
});

test('a sentinel written on PGLite survives migration, the SQLite boot, rollback, and the PGLite boot back', async () => {
  test.setTimeout(LIFECYCLE_TIMEOUT_MS);

  // --- Boot 1: build a genuine PGLite store with known data in it -----------
  pinToPglite();
  let sentinel: DatabaseSentinel;
  {
    const page = await launch();
    sentinel = makeSentinel(workspace);
    writeSentinelFile(sentinel);
    await writeSentinel(page, sentinel);
    expectSentinelIntact(await readSentinel(page, sentinel), sentinel, 'on PGLite before migrating');
    await shutdown();
  }
  ensureConfiguredProject(workspace);
  expect(fs.existsSync(PGLITE_DIR), 'a real PGLite store was built').toBe(true);

  // --- Boot 2: migrate, the way Settings > Database does --------------------
  {
    const page = await launch();
    const result = await migrationCall(page, 'db:migration:start');
    expect(result, 'db:migration:start').toMatchObject({ success: true });
    await shutdown();
  }

  // Secondary, in the plan's sense: true of a successful migration, but also
  // true of one that copied an empty database.
  expect(fs.existsSync(SQLITE_DIR)).toBe(true);
  expect(readFlag()).toMatchObject({ backend: 'sqlite' });
  expect(dirsMatching('pglite-db.migrated-').length, 'the pre-migration store is preserved').toBe(1);

  // --- Boot 3: the claim that matters. Read it back through SQLite ----------
  {
    const page = await launch();
    expectSentinelIntact(await readSentinel(page, sentinel), sentinel, 'after migrating to SQLite');

    // --- Roll back from the same launch, again the way Settings does --------
    const rollback = await migrationCall(page, 'db:migration:rollback');
    expect(rollback, 'db:migration:rollback').toMatchObject({ success: true });
    await shutdown();
  }

  expect(readFlag()).toMatchObject({ backend: 'pglite' });
  expect(fs.existsSync(PGLITE_DIR), 'the PGLite store is back').toBe(true);

  // --- Boot 4: and it is still the user's data --------------------------
  {
    const page = await launch();
    expectSentinelIntact(await readSentinel(page, sentinel), sentinel, 'after rolling back to PGLite');
    await shutdown();
  }
});

test('an install with no rollout authorization boots normally on PGLite and keeps its data', async () => {
  test.setTimeout(LIFECYCLE_TIMEOUT_MS);

  pinToPglite();
  let sentinel: DatabaseSentinel;
  {
    const page = await launch();
    sentinel = makeSentinel(workspace);
    writeSentinelFile(sentinel);
    await writeSentinel(page, sentinel);
    await shutdown();
  }

  // Migration-due by the flag, but nothing has authorized one. The launch must
  // boot PGLite and leave the decision to a later launch -- and must not
  // quietly do anything to the store while deciding.
  fs.writeFileSync(
    FLAG_FILE,
    JSON.stringify({
      backend: 'pglite',
      setAt: new Date().toISOString(),
      setBy: 'auto-migration-deferred',
    }),
  );

  const page = await launch();
  expectSentinelIntact(await readSentinel(page, sentinel), sentinel, 'after an unauthorized boot');
  expect(readFlag()).toMatchObject({ backend: 'pglite' });
  expect(dirsMatching('pglite-db.migrated-').length).toBe(0);
  expect(fs.existsSync(PGLITE_DIR)).toBe(true);
});


test('dry-run adoption preserves saved content through an immediate restart and acknowledges the cutover', async () => {
  test.setTimeout(LIFECYCLE_TIMEOUT_MS);
  pinToPglite();
  const original = makeSentinel(workspace);
  const added = { ...makeSentinel(workspace), filePath: path.join(workspace, 'added-after-dry-run.md') };
  writeSentinelFile(original);
  writeSentinelFile(added);
  const journalPath = path.join(DB_LIFECYCLE_DIR, 'database-cutover.json');
  {
    const page = await launch();
    await writeSentinel(page, original);
    expect(await migrationCall(page, 'db:migration:dry-run')).toMatchObject({ success: true });
    // Writes after the dry run must make it through final catch-up too.
    await writeSentinel(page, added);
    expect(await migrationCall(page, 'db:migration:adopt-dry-run')).toMatchObject({ success: true });
    expect(JSON.parse(fs.readFileSync(journalPath, 'utf8')).phase).toBe('backend_committed');
    expect(await migrationCall(page, 'db:migration:get-status')).toMatchObject({ operation: { status: 'awaiting-restart', requiresRestart: true } });
    await shutdown();
  }
  {
    const page = await launch();
    expectSentinelIntact(await readSentinel(page, original), original, 'original content after immediate restart');
    expectSentinelIntact(await readSentinel(page, added), added, 'post-dry-run content after immediate restart');
    expect(fs.existsSync(journalPath)).toBe(false);
  }
});


test('partial history recovery survives dry-run adoption and immediate restart', async () => {
  test.setTimeout(LIFECYCLE_TIMEOUT_MS);
  pinToPglite();
  const sentinel = makeSentinel(workspace);
  {
    const page = await launch();
    writeSentinelFile(sentinel);
    await writeSentinel(page, sentinel);
    await shutdown();
  }
  // Relax the isolated, closed E2E store's constraint to seed a genuinely missing snapshot.
  const source = new PGlite({ dataDir: PGLITE_DIR });
  try {
    await source.waitReady;
    await source.exec(`ALTER TABLE document_history ALTER COLUMN content DROP NOT NULL;
      INSERT INTO document_history(workspace_id,file_path,content,timestamp,metadata)
      SELECT 'history-recovery-test', 'history-recovery-' || n,
        CASE WHEN n = 100 THEN NULL ELSE decode('00ff10','hex') END, ${Date.now()} + n, '{}'::jsonb
      FROM generate_series(1,100) n`);
  } finally { await source.close(); }
  ensureConfiguredProject(workspace);
  {
    const page = await launch();
    expect(await migrationCall(page, 'db:migration:dry-run')).toMatchObject({ success: true, result: { summary: { historyRowsQuarantined: 1 } } });
    expect(await migrationCall(page, 'db:migration:get-status')).toMatchObject({ dryRunAvailable: { historyRowsQuarantined: 1 } });
    expect(await migrationCall(page, 'db:migration:adopt-dry-run')).toMatchObject({ success: true, result: { historyRowsQuarantined: 1 } });
    await shutdown();
  }
  {
    const page = await launch();
    expectSentinelIntact(await readSentinel(page, sentinel), sentinel, 'after partial-history adoption and immediate restart');
    expect(await migrationCall(page, 'db:migration:get-status')).toMatchObject({ success: true, activeBackend: 'sqlite', historyRowsQuarantined: 1 });
    expect(dirsMatching('pglite-db.migrated-')).toHaveLength(1);
    await shutdown();
  }
});
