// @vitest-environment node
/**
 * The transaction that replaces a live database, and the service that decides
 * it may run.
 *
 * Real SQLite databases in real temp directories throughout. Nothing here
 * mocks `fs`: the claim under test is what is on disk after each failure, and
 * a test that stubs the filesystem cannot make that claim.
 *
 * The fault-injection table is the test this slice exists for. #1347 turned
 * recoverable into permanent at exactly one boundary — the live database moved
 * aside and the replacement not yet in place — and every row below asserts
 * that whatever fails, the old authoritative database is still readable and
 * every recovery copy is still on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Sqlite from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../../sqlite/SQLiteDatabase';
import { createSqliteRecoveryAdapter, type CandidateMaterializer } from '../backendAdapters';
import { RecoveryService } from '../RecoveryService';
import { mayTryAnotherCandidate, runRecoveryTransaction } from '../recoveryTransaction';
import { moveSqliteDatabase } from '../recoveryFs';
import {
  createRecoveryJournalPort,
  getRecoveryJournalPath,
  readRecoveryJournal,
  readRecoveryJournalStatus,
} from '../recoveryJournal';
import { planRecoveryReconcile, reconcileRecoveryOnStartup } from '../recoveryReconciler';
import { verifyRecoveryTargetFile } from '../recoveryVerification';
import { sizeBucketFor, type RecoveryStep, type RecoveryVerification } from '../types';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'sqlite', 'schemas');

let tmp: string;
let sqliteDir: string;
let livePath: string;
let live: SQLiteDatabase;

async function makeSqliteDatabase(
  dir: string,
  sessionIds: string[],
  projectSlugs: string[] = [],
): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const db = new SQLiteDatabase({ dbDir: dir, schemaDir: SCHEMA_DIR });
  await db.initialize();
  const handle = db.getRawHandle()!;
  const stmt = handle.prepare('INSERT INTO ai_sessions(id, provider) VALUES (?, ?)');
  for (const id of sessionIds) stmt.run(id, 'claude');
  const project = handle.prepare('INSERT INTO projects(id, org_id, slug) VALUES (?, ?, ?)');
  for (const slug of projectSlugs) project.run(`proj-${slug}`, 'org-1', slug);
  await db.close();
  return path.join(dir, 'nimbalyst.sqlite');
}

function projectSlugsIn(file: string): string[] {
  const handle = new Sqlite(file, { fileMustExist: true, readonly: true });
  try {
    return (handle.prepare('SELECT slug FROM projects ORDER BY slug').all() as { slug: string }[])
      .map((r) => r.slug);
  } finally {
    handle.close();
  }
}

function sessionIdsIn(file: string): string[] {
  const handle = new Sqlite(file, { fileMustExist: true, readonly: true });
  try {
    return (handle.prepare('SELECT id FROM ai_sessions ORDER BY id').all() as { id: string }[]).map(
      (r) => r.id,
    );
  } finally {
    handle.close();
  }
}

function adapterOver(materialize?: CandidateMaterializer) {
  return createSqliteRecoveryAdapter({
    livePath,
    engine: {
      initialize: () => live.initialize(),
      close: () => live.close(),
      queryReadOnly: <T,>(sql: string, params?: unknown[]) =>
        live.queryReadOnly<T>(sql, params as unknown[] | undefined),
    },
    verify: async (p) => verifyRecoveryTargetFile(p),
    materialize,
  });
}

const NEUTRAL_CONTEXT = {
  candidateSizeBucket: sizeBucketFor(1),
  liveSizeBucket: sizeBucketFor(1),
  reasonCode: null,
};

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-rec-'));
  sqliteDir = path.join(tmp, 'sqlite-db');
  livePath = await makeSqliteDatabase(sqliteDir, ['live-1', 'live-2', 'live-3']);
  live = new SQLiteDatabase({ dbDir: sqliteDir, schemaDir: SCHEMA_DIR });
  await live.initialize();
});

afterEach(async () => {
  try {
    await live.close();
  } catch {
    /* a rolled-back transaction may have left it closed */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('runRecoveryTransaction fault injection', () => {
  const STEPS: RecoveryStep[] = [
    'snapshot',
    'stage',
    'verify',
    'swap-displace',
    'swap-promote',
    'reopen',
    'final-verify',
  ];

  it.each(STEPS)(
    'a failure at %s leaves the old database intact and every copy on disk',
    async (failAt) => {
      const candidate = await makeSqliteDatabase(path.join(tmp, 'candidate'), [
        'cand-1',
        'cand-2',
        'cand-3',
        'cand-4',
        'cand-5',
        'cand-6',
      ]);

      const outcome = await runRecoveryTransaction({
        candidateId: 'artifact:test',
        candidatePath: candidate,
        adapter: adapterOver(),
        context: NEUTRAL_CONTEXT,
        beforeStep: (step) => {
          if (step === failAt) throw new Error(`injected failure at ${step}`);
        },
      });

      expect(outcome.ok).toBe(false);

      // The old authoritative database is back where the app looks for it,
      // with exactly the rows it had.
      expect(fs.existsSync(livePath)).toBe(true);
      expect(sessionIdsIn(livePath)).toEqual(['live-1', 'live-2', 'live-3']);

      // The artifact we were recovering from was never touched.
      expect(sessionIdsIn(candidate)).toHaveLength(6);

      // Once the snapshot step has run, the pre-restore copy is kept too --
      // failing does not clean up the evidence.
      if (failAt !== 'snapshot') {
        const snapshots = fs
          .readdirSync(sqliteDir)
          .filter((n) => n.includes('.pre-restore-') && n.endsWith('.sqlite'));
        expect(snapshots).toHaveLength(1);
        expect(sessionIdsIn(path.join(sqliteDir, snapshots[0]))).toEqual([
          'live-1',
          'live-2',
          'live-3',
        ]);
      }
    },
  );

  it('reports the failing step and whether it had to roll back', async () => {
    const candidate = await makeSqliteDatabase(path.join(tmp, 'candidate'), ['c1', 'c2']);
    const outcome = await runRecoveryTransaction({
      candidateId: 'artifact:test',
      candidatePath: candidate,
      adapter: adapterOver(),
      context: NEUTRAL_CONTEXT,
      beforeStep: (step) => {
        if (step === 'swap-promote') throw new Error('injected');
      },
    });
    expect(outcome).toMatchObject({ ok: false, code: 'swap_failed', failedStep: 'swap-promote', rolledBack: true });
  });

  /**
   * The final check compares against what staging verified, not against zero.
   *
   * `rowsOf(indicators) > 0` accepts any database with a single row, which is
   * not the claim this step makes. It was seen accepting one in the E2E: a
   * recovery whose staged copy verified intact reopened reporting a single
   * session, and the transaction reported SUCCESS and cleared the journal --
   * telling the user their data was back while the copy holding it sat under a
   * `.displaced-*` name. A recovery that comes back short must roll back and
   * say so, whatever caused the shortfall.
   */
  it('fails and rolls back when the reopened database holds fewer rows than staging verified', async () => {
    const candidate = await makeSqliteDatabase(path.join(tmp, 'candidate'), ['c1', 'c2', 'c3']);
    const base = adapterOver();

    const outcome = await runRecoveryTransaction({
      candidateId: 'artifact:test',
      candidatePath: candidate,
      adapter: {
        ...base,
        // Staging verifies with three sessions; the reopened database answers
        // with one. Non-zero, so the old gate passed it.
        readLiveIndicators: async () => ({
          sessionCount: 1,
          documentHistoryCount: 0,
          projectCount: 0,
        }),
      },
      context: NEUTRAL_CONTEXT,
    });

    expect(outcome).toMatchObject({
      ok: false,
      code: 'final_verify_failed',
      failedStep: 'final-verify',
      rolledBack: true,
    });
    expect(outcome.ok === false && outcome.message).toContain('fewer rows');
    // Rolled back to the database the install was running on, intact.
    expect(sessionIdsIn(livePath)).toEqual(['live-1', 'live-2', 'live-3']);
  });

  /**
   * The other side of that comparison. A healthy recovery reopens into a
   * running app, which writes a session row for the new window immediately --
   * so live is routinely AHEAD of staging. Requiring equality would fail every
   * real recovery; only a shortfall is a failure.
   */
  it('accepts a reopened database that has gained rows since staging was verified', async () => {
    const candidate = await makeSqliteDatabase(path.join(tmp, 'candidate'), ['c1', 'c2']);
    const base = adapterOver();

    const outcome = await runRecoveryTransaction({
      candidateId: 'artifact:test',
      candidatePath: candidate,
      adapter: {
        ...base,
        readLiveIndicators: async () => ({
          sessionCount: 2,
          documentHistoryCount: 0,
          // The app wrote something of its own between promote and the read.
          projectCount: 5,
        }),
      },
      context: NEUTRAL_CONTEXT,
    });

    expect(outcome.ok).toBe(true);
  });

  it('refuses an empty candidate at verification, before anything moves', async () => {
    const candidate = await makeSqliteDatabase(path.join(tmp, 'candidate'), []);
    const outcome = await runRecoveryTransaction({
      candidateId: 'artifact:test',
      candidatePath: candidate,
      adapter: adapterOver(),
      context: NEUTRAL_CONTEXT,
    });
    expect(outcome).toMatchObject({ ok: false, code: 'candidate_empty', failedStep: 'verify' });
    expect(sessionIdsIn(livePath)).toEqual(['live-1', 'live-2', 'live-3']);
  });

  it('refuses a candidate whose integrity check fails', async () => {
    const candidate = await makeSqliteDatabase(path.join(tmp, 'candidate'), ['c1', 'c2']);
    // Corrupt a page in the middle of the file: it still opens, and
    // integrity_check is what catches it.
    const handle = fs.openSync(candidate, 'r+');
    fs.writeSync(handle, Buffer.alloc(2048, 0x7f), 0, 2048, 4096);
    fs.closeSync(handle);

    const outcome = await runRecoveryTransaction({
      candidateId: 'artifact:test',
      candidatePath: candidate,
      adapter: adapterOver(),
      context: NEUTRAL_CONTEXT,
    });
    expect(outcome.ok).toBe(false);
    expect(sessionIdsIn(livePath)).toEqual(['live-1', 'live-2', 'live-3']);
  });

  it('aborts before touching anything when the database cannot be closed', async () => {
    const candidate = await makeSqliteDatabase(path.join(tmp, 'candidate'), ['c1', 'c2']);
    const adapter = adapterOver();
    let closeAttempts = 0;
    const outcome = await runRecoveryTransaction({
      candidateId: 'artifact:test',
      candidatePath: candidate,
      adapter: {
        ...adapter,
        quiesce: async () => {
          closeAttempts++;
          throw new Error('database is still serving queries');
        },
      },
      context: NEUTRAL_CONTEXT,
    });
    expect(outcome).toMatchObject({ ok: false, code: 'quiesce_failed' });
    // Retried once before giving up, and never worked around.
    expect(closeAttempts).toBe(2);
    expect(sessionIdsIn(livePath)).toEqual(['live-1', 'live-2', 'live-3']);
  });

  it('keeps the source artifact, the snapshot and the displaced database on success', async () => {
    const candidate = await makeSqliteDatabase(path.join(tmp, 'candidate'), ['c1', 'c2', 'c3']);
    const outcome = await runRecoveryTransaction({
      candidateId: 'artifact:test',
      candidatePath: candidate,
      adapter: adapterOver(),
      context: NEUTRAL_CONTEXT,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(sessionIdsIn(livePath)).toEqual(['c1', 'c2', 'c3']);
    expect(sessionIdsIn(outcome.artifacts.sourceArtifactPath)).toEqual(['c1', 'c2', 'c3']);
    expect(sessionIdsIn(outcome.artifacts.displacedLivePath!)).toEqual([
      'live-1',
      'live-2',
      'live-3',
    ]);
    expect(sessionIdsIn(outcome.artifacts.preRestoreSnapshotPath!)).toEqual([
      'live-1',
      'live-2',
      'live-3',
    ]);
  });
});

// ---------------------------------------------------------------------------

/**
 * The one window that turns recoverable into permanent: the live database
 * renamed aside and the replacement not yet in its place. Before the journal,
 * a process killed there left no live path and nothing on disk saying where
 * the data went, so the next launch created an empty database on top of a
 * perfectly good `.displaced-*` copy (#1347).
 *
 * The transaction cannot be SIGKILLed from inside the same process, so this
 * reproduces the identical on-disk-plus-journal state the way production can
 * reach it without dying: the promote rename fails and the compensating
 * rollback rename fails too. What is on disk afterwards -- no live database, a
 * displaced copy, a journal at `live_displaced` -- is exactly what a kill
 * between the two renames leaves, and the second launch below is the real
 * startup entry point reading it.
 */
describe('an interrupted swap, and the launch that follows it', () => {
  async function interruptBetweenTheRenames(): Promise<void> {
    const candidate = await makeSqliteDatabase(path.join(tmp, 'candidate'), ['c1', 'c2', 'c3']);
    const base = adapterOver();
    const outcome = await runRecoveryTransaction({
      candidateId: 'artifact:test',
      candidatePath: candidate,
      adapter: {
        ...base,
        // Anything moving *into* the live path fails: the promote, and then the
        // rollback that tries to undo it.
        move: async (from, to) => {
          if (to === livePath) throw new Error('EPERM: rename blocked');
          return base.move(from, to);
        },
      },
      context: NEUTRAL_CONTEXT,
      journal: createRecoveryJournalPort(tmp),
      operationId: 'test-interrupted',
    });
    expect(outcome).toMatchObject({ ok: false, failedStep: 'swap-promote', rolledBack: false });
  }

  it('leaves a journal naming both copies, and the next launch puts the database back', async () => {
    await interruptBetweenTheRenames();

    // The state a kill in the window leaves behind.
    expect(fs.existsSync(livePath)).toBe(false);
    const journal = readRecoveryJournal(tmp);
    expect(journal).toMatchObject({ phase: 'live_displaced', backend: 'sqlite', liveExisted: true });
    expect(fs.existsSync(journal!.paths.displacedPath)).toBe(true);

    // Second launch. This is the function `index.ts` calls before anything can
    // open -- and therefore create -- a database at the live path.
    const result = reconcileRecoveryOnStartup({ userDataPath: tmp });

    expect(result).toMatchObject({ applied: true, error: null });
    expect(result.plan.action).toBe('restore_displaced');
    expect(result.plan.blockDatabaseOpen).toBe(false);
    expect(sessionIdsIn(livePath)).toEqual(['live-1', 'live-2', 'live-3']);
    // Resolved: a third launch must not try again.
    expect(fs.existsSync(getRecoveryJournalPath(tmp))).toBe(false);
  });

  it('is idempotent: a third launch finds nothing left to do', async () => {
    await interruptBetweenTheRenames();
    reconcileRecoveryOnStartup({ userDataPath: tmp });
    const again = reconcileRecoveryOnStartup({ userDataPath: tmp });
    expect(again.plan.action).toBe('nothing_to_do');
    expect(sessionIdsIn(livePath)).toEqual(['live-1', 'live-2', 'live-3']);
  });

  it('refuses to let startup open a database when no copy can be put back', async () => {
    await interruptBetweenTheRenames();
    // The displaced copy is gone as well -- a disk failure, or a user who
    // tidied up. There is nothing to restore, and creating an empty database
    // here is the failure mode this whole plan exists to prevent.
    const journal = readRecoveryJournal(tmp)!;
    fs.rmSync(journal.paths.displacedPath, { force: true });

    const result = reconcileRecoveryOnStartup({ userDataPath: tmp });
    expect(result.plan.blockDatabaseOpen).toBe(true);
    expect(fs.existsSync(livePath)).toBe(false);
    expect(result.plan.message).toContain('will not create an empty one');
  });

  // Every crash point, without needing to reach any of them.
  it.each([
    // [phase, live, displaced, staging, expected action]
    ['staged_verified', true, false, true, 'clear_journal'],
    ['staged_verified', false, true, true, 'restore_displaced'],
    ['staged_verified', false, false, true, 'block_database_open'],
    ['live_displaced', false, true, true, 'restore_displaced'],
    ['live_displaced', false, false, true, 'block_database_open'],
    ['live_displaced', true, false, false, 'clear_journal'],
    ['live_displaced', true, false, true, 'hold_live_occupied'],
    ['promoted', true, false, false, 'clear_journal'],
    ['promoted', false, true, false, 'restore_displaced'],
    ['reopened_verified', true, false, false, 'clear_journal'],
  ] as const)(
    'plans %s (live=%s displaced=%s staging=%s) as %s',
    (phase, livePresent, displacedPresent, stagingPresent, expected) => {
      const plan = planRecoveryReconcile(
        {
          version: 1,
          operationId: 'op',
          candidateId: 'artifact:x',
          backend: 'sqlite',
          startedAt: '2026-09-02T00:00:00.000Z',
          updatedAt: '2026-09-02T00:00:00.000Z',
          phase,
          reconcileAttempts: 0,
          liveExisted: true,
          paths: {
            livePath: '/u/sqlite-db/nimbalyst.sqlite',
            stagingPath: '/u/sqlite-db/nimbalyst.recovery-staging-t.sqlite',
            displacedPath: '/u/sqlite-db/nimbalyst.displaced-t.sqlite',
            preRestoreSnapshotPath: null,
            sourceArtifactPath: '/u/pglite-db.backup-t',
          },
        },
        { livePresent, displacedPresent, stagingPresent },
      );
      expect(plan.action).toBe(expected);
      // Whatever the plan is, it never names a path the journal did not record.
      if (plan.moveFrom) expect(plan.moveFrom).toBe('/u/sqlite-db/nimbalyst.displaced-t.sqlite');
    },
  );

  it('stops retrying after three launches rather than looping forever', async () => {
    await interruptBetweenTheRenames();
    const journal = readRecoveryJournal(tmp)!;
    fs.rmSync(journal.paths.displacedPath, { force: true });
    for (let i = 0; i < 3; i++) reconcileRecoveryOnStartup({ userDataPath: tmp });
    const final = reconcileRecoveryOnStartup({ userDataPath: tmp });
    expect(final.plan.reason).toBe('attempts_exhausted');
    expect(final.plan.blockDatabaseOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------------

/**
 * A journal we cannot read is not a journal that says nothing happened.
 *
 * `readRecoveryJournal` returned `null` for missing, malformed, unknown-version
 * and unreadable alike, so `planRecoveryReconcile` answered `nothing_to_do` for
 * all four and startup opened -- and therefore created -- a database at the live
 * path. For a recovery interrupted at `live_displaced` there is nothing at that
 * path and the user's only copy is one name over, so a truncated JSON file was
 * enough to reach #1347's ending a second way. `cutoverJournal.ts` has drawn
 * this distinction since it was written; the comment here claimed it as
 * precedent for doing the opposite.
 */
describe('reading the recovery journal', () => {
  const write = (contents: string) => fs.writeFileSync(getRecoveryJournalPath(tmp), contents, 'utf-8');

  const validJournal = () => ({
    version: 1,
    operationId: 'op-1',
    candidateId: 'artifact:x',
    backend: 'sqlite' as const,
    startedAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    phase: 'live_displaced' as const,
    reconcileAttempts: 0,
    liveExisted: true,
    paths: {
      livePath,
      stagingPath: path.join(sqliteDir, 'nimbalyst.recovery-staging-t.sqlite'),
      displacedPath: path.join(sqliteDir, 'nimbalyst.displaced-t.sqlite'),
      preRestoreSnapshotPath: null,
      sourceArtifactPath: path.join(tmp, 'pglite-db.backup-t'),
    },
  });

  it('reports an absent journal as absent, not as unreadable', () => {
    expect(readRecoveryJournalStatus(tmp)).toEqual({ status: 'absent' });
  });

  it('reports a readable journal', () => {
    write(JSON.stringify(validJournal()));
    const read = readRecoveryJournalStatus(tmp);
    expect(read.status).toBe('ok');
  });

  it.each([
    ['truncated mid-write', '{"version":1,"phase":"live_disp'],
    ['not JSON at all', 'nothing here'],
    ['empty, as an interrupted atomic replace can leave it', ''],
    ['a version this build predates', JSON.stringify({ ...{}, version: 2, phase: 'live_displaced' })],
    ['a phase this build does not know', JSON.stringify({ version: 1, phase: 'teleported', paths: {} })],
  ])('reports a journal that is %s as unreadable, never as absent', (_case, contents) => {
    write(contents);
    const read = readRecoveryJournalStatus(tmp);
    expect(read.status).toBe('unreadable');
  });

  it('reports a journal that names none of its paths as unreadable', () => {
    const journal = validJournal();
    write(JSON.stringify({ ...journal, paths: { ...journal.paths, displacedPath: '' } }));
    expect(readRecoveryJournalStatus(tmp).status).toBe('unreadable');
  });

  /**
   * The E2E for this ("an interrupted recovery whose journal cannot be read
   * does not become an empty install") launches the real app; these are the
   * same claims at unit speed, so a regression does not have to wait for a
   * 5-minute Playwright run to surface.
   *
   * The `live_displaced` window, reconstructed on disk: nothing at the live
   * path and the user's database renamed to a displaced name. Without the
   * journal, startup used to read that as "no interrupted recovery" and open
   * the live path -- which CREATES an empty database on top of the only copy.
   */
  async function displaceTheLiveDatabase(name = 'nimbalyst.displaced-t.sqlite'): Promise<string> {
    await live.close();
    const displaced = path.join(sqliteDir, name);
    await moveSqliteDatabase(livePath, displaced);
    return displaced;
  }

  it('puts the one displaced copy back rather than starting empty or refusing to start', async () => {
    const displaced = await displaceTheLiveDatabase();
    write('{"version":1,"phase":"live_disp');

    const result = reconcileRecoveryOnStartup({ userDataPath: tmp });

    // The move lands in an empty slot, so nothing is overwritten -- and the
    // user's rows are back where the app looks for them.
    expect(result.plan.blockDatabaseOpen).toBe(false);
    expect(result.plan.action).toBe('restore_displaced');
    expect(sessionIdsIn(livePath)).toEqual(['live-1', 'live-2', 'live-3']);
    expect(fs.existsSync(displaced)).toBe(false);
    // The damaged journal is kept, under a name that stops the next launch
    // re-running this. It is unreadable to us and still the only artifact
    // saying a recovery ran.
    expect(fs.existsSync(getRecoveryJournalPath(tmp))).toBe(false);
    expect(fs.readdirSync(tmp).some((n) => n.includes('database-recovery.json.unreadable-'))).toBe(true);
  });

  it('refuses to choose when two displaced copies are sitting there', async () => {
    const displaced = await displaceTheLiveDatabase();
    fs.copyFileSync(displaced, path.join(sqliteDir, 'nimbalyst.displaced-u.sqlite'));
    write('{"version":1,"phase":"live_disp');

    const result = reconcileRecoveryOnStartup({ userDataPath: tmp });

    expect(result.plan.blockDatabaseOpen).toBe(true);
    expect(result.plan.reason).toBe('journal_unreadable');
    // Nothing moved. Picking between two databases is not ours to do, and
    // startup is stopped rather than allowed to create a third, empty one.
    expect(fs.existsSync(livePath)).toBe(false);
    expect(sessionIdsIn(displaced)).toEqual(['live-1', 'live-2', 'live-3']);
    expect(fs.existsSync(getRecoveryJournalPath(tmp))).toBe(true);
  });

  /**
   * A staged copy is the *replacement*, and it has not been verified since the
   * interruption. Promoting it without a journal saying it passed would be
   * acting on an unchecked database -- which is what the readable-journal
   * planner refuses to do at `live_displaced` for the same reason.
   */
  it('refuses to promote an unverified staged copy', async () => {
    const displaced = await displaceTheLiveDatabase('nimbalyst.recovery-staging-t.sqlite');
    write('{"version":1,"phase":"live_disp');

    const result = reconcileRecoveryOnStartup({ userDataPath: tmp });

    expect(result.plan.blockDatabaseOpen).toBe(true);
    expect(fs.existsSync(livePath)).toBe(false);
    expect(sessionIdsIn(displaced)).toEqual(['live-1', 'live-2', 'live-3']);
  });

  it('does not wedge a healthy install whose journal happens to be damaged', () => {
    // Live database present, no stranded copy: there is nothing to protect and
    // blocking would be a boot failure invented out of a corrupt scratch file.
    write('{"version":1,"phase":"live_disp');

    const result = reconcileRecoveryOnStartup({ userDataPath: tmp });

    expect(result.plan.blockDatabaseOpen).toBe(false);
    expect(result.plan.reason).toBe('journal_unreadable');
    expect(sessionIdsIn(livePath)).toEqual(['live-1', 'live-2', 'live-3']);
  });
});

// ---------------------------------------------------------------------------

/**
 * The journal is the only record of where a displaced database went.
 *
 * `begin()` wrote unconditionally, and both backup services swept every rolling
 * copy in turn. So a persistent promote failure went: attempt one displaces the
 * live database and fails, attempt two calls `begin()` and overwrites attempt
 * one's journal, attempt two sees `liveExisted === false`, fails, and clears its
 * own journal on the way out. End state: the user's database under a
 * `.displaced-*` name, and nothing on disk pointing at it.
 */
describe('a second recovery attempt while one is unresolved', () => {
  async function leaveAnUnresolvedJournal(): Promise<string> {
    const candidate = await makeSqliteDatabase(path.join(tmp, 'candidate-1'), ['c1', 'c2']);
    const outcome = await runRecoveryTransaction({
      candidateId: 'rolling:current',
      candidatePath: candidate,
      adapter: adapterOver(),
      context: NEUTRAL_CONTEXT,
      journal: createRecoveryJournalPort(tmp),
      operationId: 'attempt-one',
      // Fail the displace itself, which is the boundary that keeps a journal.
      beforeStep: (step) => {
        if (step === 'swap-displace') throw new Error('EPERM: rename blocked');
      },
    });
    expect(outcome).toMatchObject({ ok: false, failedStep: 'swap-displace' });
    expect(readRecoveryJournal(tmp)).not.toBeNull();
    return candidate;
  }

  it('refuses, and leaves the first attempt\'s journal exactly as it was', async () => {
    await leaveAnUnresolvedJournal();
    const before = fs.readFileSync(getRecoveryJournalPath(tmp), 'utf-8');

    const second = await makeSqliteDatabase(path.join(tmp, 'candidate-2'), ['d1', 'd2']);
    const outcome = await runRecoveryTransaction({
      candidateId: 'rolling:previous',
      candidatePath: second,
      adapter: adapterOver(),
      context: NEUTRAL_CONTEXT,
      journal: createRecoveryJournalPort(tmp),
      operationId: 'attempt-two',
    });

    expect(outcome).toMatchObject({ ok: false, code: 'recovery_in_progress' });
    expect(fs.readFileSync(getRecoveryJournalPath(tmp), 'utf-8')).toBe(before);
    expect(JSON.parse(before).operationId).toBe('attempt-one');
    // And nothing was touched on the way to refusing.
    expect(sessionIdsIn(livePath)).toEqual(['live-1', 'live-2', 'live-3']);
  });

  it('refuses on top of a journal it cannot even read', async () => {
    fs.writeFileSync(getRecoveryJournalPath(tmp), '{"version":1,"phase":"live_disp', 'utf-8');
    const candidate = await makeSqliteDatabase(path.join(tmp, 'candidate-3'), ['e1']);

    const outcome = await runRecoveryTransaction({
      candidateId: 'rolling:current',
      candidatePath: candidate,
      adapter: adapterOver(),
      context: NEUTRAL_CONTEXT,
      journal: createRecoveryJournalPort(tmp),
      operationId: 'attempt-three',
    });

    expect(outcome).toMatchObject({ ok: false, code: 'recovery_in_progress' });
    expect(fs.readFileSync(getRecoveryJournalPath(tmp), 'utf-8')).toBe('{"version":1,"phase":"live_disp');
  });

  it('tells a sweeping caller to stop after any outcome past the swap', async () => {
    await leaveAnUnresolvedJournal();
    const outcome = await runRecoveryTransaction({
      candidateId: 'rolling:previous',
      candidatePath: await makeSqliteDatabase(path.join(tmp, 'candidate-4'), ['f1']),
      adapter: adapterOver(),
      context: NEUTRAL_CONTEXT,
      journal: createRecoveryJournalPort(tmp),
      operationId: 'attempt-four',
    });
    expect(mayTryAnotherCandidate(outcome)).toBe(false);
  });

  it('lets a sweeping caller try the next copy after a pre-swap refusal', async () => {
    // An empty candidate is rejected at `verify`, before anything has moved,
    // and clears its journal on the way out. That is the case falling through
    // to the next backup exists for.
    const empty = await makeSqliteDatabase(path.join(tmp, 'candidate-empty'), []);
    const outcome = await runRecoveryTransaction({
      candidateId: 'rolling:current',
      candidatePath: empty,
      adapter: adapterOver(),
      context: NEUTRAL_CONTEXT,
      journal: createRecoveryJournalPort(tmp),
      operationId: 'attempt-empty',
    });

    expect(outcome).toMatchObject({ ok: false, code: 'candidate_empty' });
    expect(mayTryAnotherCandidate(outcome)).toBe(true);
    expect(fs.existsSync(getRecoveryJournalPath(tmp))).toBe(false);
    expect(sessionIdsIn(livePath)).toEqual(['live-1', 'live-2', 'live-3']);
  });
});

// ---------------------------------------------------------------------------

describe('moveSqliteDatabase', () => {
  /**
   * The main file used to be renamed first and the sidecars after, with no
   * compensation. A sidecar rename that failed reported "the move failed"
   * while the main file was already at the destination -- so the caller put
   * nothing back and reopened against a path with no database, and the WAL
   * holding the newest writes was left orphaned at the source.
   */
  it('undoes the main-file rename when a sidecar rename fails', async () => {
    const from = path.join(tmp, 'move-src.sqlite');
    const to = path.join(tmp, 'move-dst.sqlite');
    fs.writeFileSync(from, 'main');
    fs.writeFileSync(`${from}-wal`, 'journal-with-the-newest-writes');
    // A non-empty directory already sitting where the WAL must land: a real
    // ENOTEMPTY from a real rename, no mocked fs anywhere.
    fs.mkdirSync(`${to}-wal`);
    fs.writeFileSync(path.join(`${to}-wal`, 'occupant'), 'x');

    await expect(moveSqliteDatabase(from, to)).rejects.toThrow();

    // Both halves of the database are back where they started, together.
    expect(fs.existsSync(from)).toBe(true);
    expect(fs.readFileSync(`${from}-wal`, 'utf-8')).toBe('journal-with-the-newest-writes');
    expect(fs.existsSync(to)).toBe(false);
  });

  it('moves the database and its sidecars together on success', async () => {
    const from = path.join(tmp, 'ok-src.sqlite');
    const to = path.join(tmp, 'ok-dst.sqlite');
    fs.writeFileSync(from, 'main');
    fs.writeFileSync(`${from}-wal`, 'wal');

    await moveSqliteDatabase(from, to);

    expect(fs.existsSync(from)).toBe(false);
    expect(fs.existsSync(`${from}-wal`)).toBe(false);
    expect(fs.readFileSync(`${to}-wal`, 'utf-8')).toBe('wal');
  });
});

// ---------------------------------------------------------------------------

describe('RecoveryService', () => {
  const ARTIFACT = 'pglite-db.backup-2026-08-21T10-13-22-000Z';
  let artifactPath: string;

  /** A PGLite store, stood in for by a directory whose counts live in markers. */
  function writeArtifact(sessions: number, projects = 0): void {
    artifactPath = path.join(tmp, ARTIFACT);
    fs.mkdirSync(artifactPath, { recursive: true });
    fs.writeFileSync(path.join(artifactPath, 'PG_VERSION'), '15\n');
    fs.writeFileSync(path.join(artifactPath, 'sessions.marker'), String(sessions));
    fs.writeFileSync(path.join(artifactPath, 'projects.marker'), String(projects));
  }

  /** Put the install in the recommendation shape: a live database with nothing in it. */
  async function emptyTheLiveDatabase(): Promise<void> {
    await live.close();
    fs.rmSync(sqliteDir, { recursive: true, force: true });
    livePath = await makeSqliteDatabase(sqliteDir, []);
    live = new SQLiteDatabase({ dbDir: sqliteDir, schemaDir: SCHEMA_DIR });
    await live.initialize();
  }

  function markerCount(dbPath: string, marker: string): number {
    try {
      return Number(fs.readFileSync(path.join(dbPath, marker), 'utf-8'));
    } catch {
      return 0;
    }
  }

  function markerProbe(dbPath: string): Promise<RecoveryVerification> {
    return Promise.resolve({
      valid: true,
      integrity: 'not-applicable',
      requiredSchemaPresent: true,
      indicators: {
        sessionCount: markerCount(dbPath, 'sessions.marker'),
        documentHistoryCount: 0,
        projectCount: markerCount(dbPath, 'projects.marker'),
      },
    });
  }

  /**
   * Stands in for the PGLite-to-SQLite migration: reads the artifact's markers
   * and writes a real SQLite database holding that many sessions and projects.
   * The point being tested is that the staged target is SQLite, not that the
   * migration itself is correct.
   */
  const migratingMaterializer: CandidateMaterializer = async (candidatePath, destPath) => {
    const sessions = markerCount(candidatePath, 'sessions.marker');
    const projects = markerCount(candidatePath, 'projects.marker');
    const staging = path.join(tmp, `migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const built = await makeSqliteDatabase(
      staging,
      Array.from({ length: sessions }, (_, i) => `migrated-${i}`),
      Array.from({ length: projects }, (_, i) => `migrated-project-${i}`),
    );
    fs.renameSync(built, destPath);
  };

  function service(materialize?: CandidateMaterializer) {
    return new RecoveryService({
      userDataPath: tmp,
      activeBackend: 'sqlite',
      adapter: adapterOver(materialize),
      probeCandidate: markerProbe,
      // Read through the live database rather than asserted: a fixture that
      // hardcodes the live counts cannot notice which of them the assessment
      // actually reads.
      readLiveIndicators: async () => {
        const count = async (table: string) =>
          (await live.queryReadOnly<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)).rows[0].c;
        return {
          sessionCount: await count('ai_sessions'),
          documentHistoryCount: await count('document_history'),
          projectCount: await count('projects'),
        };
      },
      journal: createRecoveryJournalPort(tmp),
    });
  }

  beforeEach(() => {
    // An install that has been used: the fact from outside both databases.
    fs.writeFileSync(
      path.join(tmp, 'workspace-settings.json'),
      JSON.stringify({ '/a': {}, '/b': {} }),
    );
  });

  it('refuses an identifier that is not a discovered artifact', async () => {
    writeArtifact(9);
    const svc = service();
    for (const id of [artifactPath, ARTIFACT, '/etc/passwd', 'artifact:../../elsewhere']) {
      const outcome = await svc.recover({ candidateId: id, expectedFingerprint: 'anything' });
      expect(outcome).toMatchObject({ ok: false, code: 'unknown_candidate', failedStep: null });
    }
    expect(sessionIdsIn(livePath)).toEqual(['live-1', 'live-2', 'live-3']);
  });

  it('refuses when the facts changed since the user was shown them', async () => {
    writeArtifact(9);
    const svc = service(migratingMaterializer);
    const [candidate] = await svc.listCandidates();

    // The artifact grows between the assessment and the click.
    writeArtifact(40);

    const outcome = await svc.recover({
      candidateId: candidate.id,
      expectedFingerprint: candidate.assessment.factsFingerprint,
    });
    expect(outcome).toMatchObject({ ok: false, code: 'facts_changed', failedStep: 'reassess' });
    expect(sessionIdsIn(livePath)).toEqual(['live-1', 'live-2', 'live-3']);
  });

  it('refuses a fingerprint that never matched anything', async () => {
    writeArtifact(9);
    const svc = service(migratingMaterializer);
    const [candidate] = await svc.listCandidates();
    const outcome = await svc.recover({
      candidateId: candidate.id,
      expectedFingerprint: 'not-a-fingerprint',
    });
    expect(outcome).toMatchObject({ ok: false, code: 'facts_changed' });
  });

  it('refuses an empty artifact even though it is a valid database', async () => {
    writeArtifact(0);
    const svc = service(migratingMaterializer);
    const [candidate] = await svc.listCandidates();
    expect(candidate.assessment.verdict).toBe('not_actionable');
    const outcome = await svc.recover({
      candidateId: candidate.id,
      expectedFingerprint: candidate.assessment.factsFingerprint,
    });
    expect(outcome).toMatchObject({ ok: false, code: 'candidate_empty' });
    expect(sessionIdsIn(livePath)).toEqual(['live-1', 'live-2', 'live-3']);
  });

  /**
   * The assessment has no "is this artifact moving?" check any more, and this
   * pins that it stays gone.
   *
   * It used to sample the artifact's size on both sides of `probeCandidate`.
   * The probe OPENS the store to count rows, and opening a PGLite store writes
   * to it, so the two samples bracketed our own write and a mismatch was
   * guaranteed. Every artifact came back `assessment_blocked` on the first
   * look, and `proactiveOffer()` only ever gets a first look -- so the
   * launch-time offer could never fire for anyone. Moving both samples ahead of
   * the probe did not fix it either: verification workers are terminated rather
   * than closed, so an earlier probe's writes land asynchronously.
   *
   * The property it was reaching for is enforced in the transaction instead --
   * see the next test.
   */
  it('does not block an artifact because our own probe wrote to it', async () => {
    writeArtifact(9);
    await emptyTheLiveDatabase();

    const svc = new RecoveryService({
      userDataPath: tmp,
      activeBackend: 'sqlite',
      adapter: adapterOver(migratingMaterializer),
      // A probe that mutates the store it looks at, exactly as the real one
      // does, and by more than a trivial amount.
      probeCandidate: async (dbPath) => {
        fs.writeFileSync(path.join(dbPath, 'postmaster.pid'), `${process.pid}\n`);
        fs.writeFileSync(path.join(dbPath, 'pg_wal_stub'), 'x'.repeat(64 * 1024));
        return markerProbe(dbPath);
      },
      readLiveIndicators: async () => ({
        sessionCount: 0,
        documentHistoryCount: 0,
        projectCount: 0,
      }),
      journal: createRecoveryJournalPort(tmp),
    });

    const [candidate] = await svc.listCandidates();
    expect(candidate.assessment.verdict).toBe('recovery_recommended');
  });

  /**
   * ...and the property itself, which must survive the removal above: an
   * artifact something ELSE is writing to is still refused, before anything
   * moves.
   *
   * The guard is the transaction's re-gather -- facts are collected again
   * immediately before the first destructive step and compared against the
   * fingerprint the user's decision was made against. Delete that comparison
   * in `recoveryTransaction.ts` and this test fails.
   */
  it('refuses to act on an artifact that changed after the user saw it', async () => {
    writeArtifact(9);
    await emptyTheLiveDatabase();
    const svc = service(migratingMaterializer);

    const offer = await svc.proactiveOffer();
    expect(offer).not.toBeNull();

    // A third party appends to the artifact between the assessment the user saw
    // and the recovery they asked for. Our own probe is settled by now; this is
    // somebody else.
    fs.writeFileSync(path.join(artifactPath, 'appended-by-someone-else'), 'x'.repeat(128 * 1024));

    const outcome = await svc.recover({
      candidateId: offer!.id,
      expectedFingerprint: offer!.assessment.factsFingerprint,
    });

    expect(outcome).toMatchObject({ ok: false, code: 'facts_changed', failedStep: 'reassess' });
    // Nothing moved: the live database is exactly as it was.
    expect(sessionIdsIn(livePath)).toEqual([]);
  });

  // The plan's requirement, and the one that stops recovery from undoing the
  // migration: a PGLite artifact on a SQLite install is migrated into a fresh
  // SQLite target and swapped there.
  it('recovers a PGLite artifact into SQLite without changing the active backend', async () => {
    writeArtifact(9);
    // Live is empty on an install with projects: the recommendation case.
    await live.close();
    fs.rmSync(sqliteDir, { recursive: true, force: true });
    livePath = await makeSqliteDatabase(sqliteDir, []);
    live = new SQLiteDatabase({ dbDir: sqliteDir, schemaDir: SCHEMA_DIR });
    await live.initialize();

    const svc = service(migratingMaterializer);
    const offer = await svc.proactiveOffer();
    expect(offer?.assessment.reasonCode).toBe('live_empty_on_established_install');

    const outcome = await svc.recover({
      candidateId: offer!.id,
      expectedFingerprint: offer!.assessment.factsFingerprint,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.backend).toBe('sqlite');
    // The live database is still the SQLite file, and now holds the artifact's
    // sessions. Nothing put a PGLite directory back in front of the app.
    expect(fs.statSync(livePath).isFile()).toBe(true);
    expect(sessionIdsIn(livePath)).toHaveLength(9);
    expect(fs.existsSync(path.join(tmp, 'pglite-db'))).toBe(false);
    // The artifact survives its own recovery.
    expect(fs.existsSync(path.join(artifactPath, 'sessions.marker'))).toBe(true);
  });

  /**
   * Eligibility and the final verification summed sessions and document
   * history only, so an artifact whose content is projects -- someone on a
   * team whose data is shared projects rather than AI sessions -- was
   * classified `candidate_empty` and refused. `projectCount` was gathered all
   * the way through and then dropped on the floor at both gates.
   */
  it('recovers an artifact whose only content is projects', async () => {
    writeArtifact(0, 4);
    await live.close();
    fs.rmSync(sqliteDir, { recursive: true, force: true });
    livePath = await makeSqliteDatabase(sqliteDir, []);
    live = new SQLiteDatabase({ dbDir: sqliteDir, schemaDir: SCHEMA_DIR });
    await live.initialize();

    const svc = service(migratingMaterializer);
    const [candidate] = await svc.listCandidates();
    expect(candidate.assessment.reasonCode).not.toBe('candidate_empty');
    expect(candidate.assessment.verdict).toBe('recovery_recommended');

    const outcome = await svc.recover({
      candidateId: candidate.id,
      expectedFingerprint: candidate.assessment.factsFingerprint,
    });

    expect(outcome.ok).toBe(true);
    expect(projectSlugsIn(livePath)).toHaveLength(4);
  });

  it('still refuses an artifact with no sessions, no history and no projects', async () => {
    writeArtifact(0, 0);
    const svc = service(migratingMaterializer);
    const [candidate] = await svc.listCandidates();
    expect(candidate.assessment.reasonCode).toBe('candidate_empty');
    expect(sessionIdsIn(livePath)).toEqual(['live-1', 'live-2', 'live-3']);
  });

  it('does not offer the same artifact again once it has been recovered from', async () => {
    writeArtifact(9);
    await live.close();
    fs.rmSync(sqliteDir, { recursive: true, force: true });
    livePath = await makeSqliteDatabase(sqliteDir, []);
    live = new SQLiteDatabase({ dbDir: sqliteDir, schemaDir: SCHEMA_DIR });
    await live.initialize();

    const svc = service(migratingMaterializer);
    const offer = await svc.proactiveOffer();
    await svc.recover({
      candidateId: offer!.id,
      expectedFingerprint: offer!.assessment.factsFingerprint,
    });

    expect(await svc.proactiveOffer()).toBeNull();
    // Recorded as resolved, not deleted: the artifact is still on disk.
    expect(fs.existsSync(artifactPath)).toBe(true);
  });
});
