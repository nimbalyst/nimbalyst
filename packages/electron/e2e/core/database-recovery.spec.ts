/**
 * Recovering a database that a previous version of Nimbalyst renamed aside.
 *
 * This is the spec for the population #1347 actually created: an install whose
 * live `pglite-db/` is empty and whose real data is sitting in a root-level
 * `pglite-db.backup-<timestamp>/` directory. Six confirmed installs came up on
 * empty databases; three then migrated the empty database and made it
 * permanent. Everything in `database/recovery/` exists to put those back.
 *
 * The shape of each test is the incident shape, built with real launches rather
 * than fixtures: launch once and write a known session and document-history
 * sentinel through production IPC, close, rename the store aside, and let the
 * app come up on the empty slot it would come up on for a real user. From there
 * the spec drives the surface a user drives -- `db:recovery:list-candidates`
 * then `db:recovery:recover`, which is what Settings > Database calls -- and
 * the only assertion that counts is whether the sentinel reads back afterwards
 * through the production query path.
 *
 * Two things this deliberately does NOT assert on: that the artifact directory
 * exists (it always does; nothing deletes it) and that the app reached
 * `.workspace-sidebar` (it does that on an empty database too). Those were the
 * assertions that let a broken recovery path look green.
 */

import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { launchElectronApp, createTempWorkspace, waitForAppReady } from '../helpers';
import {
  DB_LIFECYCLE_DIR,
  DB_LIFECYCLE_ENV,
  PGLITE_DIR,
  RECOVERY_JOURNAL,
  dirsMatching,
  ensureConfiguredProject,
  expectSentinelIntact,
  makeSentinel,
  pinToPglite,
  readSentinel,
  resetDbLifecycleDir,
  writeSentinel,
  writeSentinelFile,
  type DatabaseSentinel,
} from '../utils/databaseSentinel';

const RECOVERY_TIMEOUT_MS = 300_000;

/** The timestamp shape `worker.js` uses when it renames a store aside. */
function artifactStamp(daysAgo = 12): string {
  const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return when.toISOString().replace(/[:.]/g, '-');
}

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

/**
 * Launch without insisting the window comes up.
 *
 * A launch that finds an interrupted recovery is allowed to refuse to open a
 * database and show the failure dialog instead. That is a correct outcome, and
 * a spec that required `waitForAppReady` would report it as a failure of the
 * thing it is actually asserting.
 */
async function launchTolerantly(): Promise<Page | null> {
  app = await launchElectronApp({
    workspace,
    preserveTestDatabase: true,
    env: DB_LIFECYCLE_ENV,
  });
  try {
    const page = await app.firstWindow();
    await waitForAppReady(page);
    return page;
  } catch {
    return null;
  }
}

async function shutdown(): Promise<void> {
  await app?.close().catch(() => undefined);
  app = null;
}

interface CandidateView {
  id: string;
  name: string;
  verdict: string;
  reasonCode: string;
  mayOfferProactively: boolean;
  factsFingerprint: string;
  restoreAvailable: boolean;
}

async function listCandidates(page: Page): Promise<{ success: boolean; error?: string; candidates: CandidateView[] }> {
  return page.evaluate(async () => {
    const api = (window as { electronAPI?: { invoke: (c: string) => Promise<unknown> } }).electronAPI;
    if (!api) return { success: false, error: 'no electronAPI', candidates: [] };
    try {
      const res = await api.invoke('db:recovery:list-candidates') as { success: boolean; error?: string; candidates?: unknown[] };
      return { success: res.success, error: res.error, candidates: (res.candidates ?? []) as never[] };
    } catch (err) {
      return { success: false, error: String(err), candidates: [] };
    }
  });
}

async function recover(page: Page, candidate: CandidateView): Promise<Record<string, unknown>> {
  return page.evaluate(async (args) => {
    const api = (window as { electronAPI?: { invoke: (c: string, a: unknown) => Promise<unknown> } }).electronAPI;
    if (!api) return { success: false, error: 'no electronAPI' };
    try {
      return await api.invoke('db:recovery:recover', args) as Record<string, unknown>;
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }, { candidateId: candidate.id, expectedFingerprint: candidate.factsFingerprint });
}

/**
 * Build the #1347 install: a populated store renamed to a corruption artifact,
 * and nothing at the live path. The launch that follows is the one where a
 * real user's app created an empty database on top of the hole.
 */
async function buildStrandedInstall(): Promise<{ sentinel: DatabaseSentinel; artifactName: string }> {
  pinToPglite();
  const page = await launch();
  const sentinel = makeSentinel(workspace);
  writeSentinelFile(sentinel);
  await writeSentinel(page, sentinel);
  expectSentinelIntact(await readSentinel(page, sentinel), sentinel, 'before the store was renamed aside');
  await shutdown();
  ensureConfiguredProject(workspace);

  const artifactName = `pglite-db.backup-${artifactStamp()}`;
  fs.renameSync(PGLITE_DIR, path.join(DB_LIFECYCLE_DIR, artifactName));
  expect(fs.existsSync(PGLITE_DIR), 'the live store is gone, as it was for affected installs').toBe(false);
  return { sentinel, artifactName };
}

test.beforeEach(async () => {
  workspace = await createTempWorkspace();
  resetDbLifecycleDir();
});

test.afterEach(async () => {
  await shutdown();
});

test('a stranded install recovers its data from the corruption artifact and still has it after a restart', async () => {
  test.setTimeout(RECOVERY_TIMEOUT_MS);

  const { sentinel, artifactName } = await buildStrandedInstall();

  // The launch a real affected user made: comes up on a brand new empty store.
  const page = await launch();
  const empty = await readSentinel(page, sentinel);
  expect(empty.sessionTitle, 'the live database really is empty at this point').toBeNull();

  // Settings > Database. Recovery is recommended only when the candidate holds
  // content, the live database holds none, and the install has projects
  // configured -- which is exactly this install.
  const listed = await listCandidates(page);
  expect(listed.success, `db:recovery:list-candidates failed: ${listed.error ?? ''}`).toBe(true);
  const candidate = listed.candidates.find((c) => c.name === artifactName);
  expect(candidate, `the artifact ${artifactName} was not discovered`).toBeDefined();
  expect(candidate!.restoreAvailable).toBe(true);
  expect(
    { verdict: candidate!.verdict, reasonCode: candidate!.reasonCode },
    'a readable artifact with content, next to an empty live database on an install with projects',
  ).toEqual({ verdict: 'recovery_recommended', reasonCode: 'live_empty_on_established_install' });

  const outcome = await recover(page, candidate!);
  expect(outcome, 'db:recovery:recover').toMatchObject({ success: true });
  expect((outcome.outcome as { ok?: boolean } | undefined)?.ok, 'the recovery transaction').toBe(true);

  expectSentinelIntact(await readSentinel(page, sentinel), sentinel, 'immediately after recovery');
  await shutdown();

  // Recovery keeps every copy, so the artifact and the displaced empty store
  // are both still on disk. Nothing here is allowed to delete them.
  expect(fs.existsSync(path.join(DB_LIFECYCLE_DIR, artifactName))).toBe(true);
  expect(dirsMatching('pglite-db.displaced-').length).toBeGreaterThan(0);

  const after = await launch();
  expectSentinelIntact(await readSentinel(after, sentinel), sentinel, 'after restarting on the recovered database');
});

test('a recovery killed between the two renames is finished by the next launch', async () => {
  test.setTimeout(RECOVERY_TIMEOUT_MS);

  const { sentinel } = await buildStrandedInstall();

  // Reconstruct, on disk, exactly what a process killed in the `live_displaced`
  // window leaves behind: the user's database renamed to the journalled
  // displaced path, the verified replacement still sitting in staging, and
  // nothing at the live path. The artifact from `buildStrandedInstall` plays
  // the part of the displaced database because it is the copy holding the
  // sentinel -- which is the whole reason the next launch must not ignore it.
  const stamp = artifactStamp(0);
  const displaced = path.join(DB_LIFECYCLE_DIR, `pglite-db.displaced-${stamp}`);
  const staging = path.join(DB_LIFECYCLE_DIR, `pglite-db.recovery-staging-${stamp}`);
  const artifact = path.join(DB_LIFECYCLE_DIR, dirsMatching('pglite-db.backup-')[0]);
  fs.renameSync(artifact, displaced);
  fs.cpSync(displaced, staging, { recursive: true });

  fs.writeFileSync(RECOVERY_JOURNAL, JSON.stringify({
    version: 1,
    operationId: 'e2e-interrupted-recovery',
    candidateId: 'artifact:e2e',
    backend: 'pglite',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: 'live_displaced',
    reconcileAttempts: 0,
    liveExisted: true,
    paths: {
      livePath: PGLITE_DIR,
      stagingPath: staging,
      displacedPath: displaced,
      preRestoreSnapshotPath: null,
      sourceArtifactPath: staging,
    },
  }, null, 2), 'utf-8');

  const page = await launchTolerantly();
  expect(page, 'the app should come back up on the restored database').not.toBeNull();
  expectSentinelIntact(await readSentinel(page!, sentinel), sentinel, 'after reconciling an interrupted recovery');
  expect(fs.existsSync(RECOVERY_JOURNAL), 'a reconciled journal is cleared').toBe(false);
});

test('an interrupted recovery whose journal cannot be read does not become an empty install', async () => {
  test.setTimeout(RECOVERY_TIMEOUT_MS);

  const { sentinel } = await buildStrandedInstall();

  const stamp = artifactStamp(0);
  const displaced = path.join(DB_LIFECYCLE_DIR, `pglite-db.displaced-${stamp}`);
  const artifact = path.join(DB_LIFECYCLE_DIR, dirsMatching('pglite-db.backup-')[0]);
  fs.renameSync(artifact, displaced);

  // The journal is present but its contents did not survive. `readRecoveryJournal`
  // reports absent and unreadable identically, so startup gets "no interrupted
  // recovery" for an install that plainly has one: there is no database at the
  // live path and a displaced copy is sitting right next to it. Opening PGLite
  // there creates an empty database on top of the only copy of the user's data,
  // which is #1347's ending, reached a second way.
  fs.writeFileSync(RECOVERY_JOURNAL, '{"version":1,"phase":"live_disp', 'utf-8');

  const page = await launchTolerantly();

  // Two acceptable endings, and one unacceptable one. Either the launch put the
  // displaced database back, or it refused to open a database at all and left
  // every copy alone. Creating a fresh empty store is neither.
  const liveExists = fs.existsSync(PGLITE_DIR);
  const readback = page ? await readSentinel(page, sentinel) : null;
  await shutdown();

  expect(fs.existsSync(displaced) || readback?.sessionTitle === sentinel.sessionTitle,
    'the displaced database still exists, or its contents are back at the live path').toBe(true);

  if (liveExists) {
    expect(readback, 'a database was opened, so the window must have come up').not.toBeNull();
    expectSentinelIntact(readback!, sentinel,
      'a live database was created despite an unreadable journal, so it had better be the user\'s');
  }
});
