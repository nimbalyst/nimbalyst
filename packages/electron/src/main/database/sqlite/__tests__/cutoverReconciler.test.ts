// @vitest-environment node
/**
 * Startup reconciliation of an interrupted cutover.
 *
 * Real temp directories and real renames throughout: this is filesystem
 * atomicity code, and a test that stubs `fs` would assert only that the plan
 * object has the shape the planner gave it. The one thing injected is an
 * `EPERM` on a single rename, because Windows holds directory handles in a way
 * macOS does not and we cannot reproduce that here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CUTOVER_PHASES,
  MAX_RECONCILE_ATTEMPTS,
  fingerprintSource,
  readCutoverJournal,
  writeCutoverJournal,
  type CutoverFs,
  type CutoverJournal,
  type CutoverPhase,
} from '../cutoverJournal';
import { reconcileCutoverOnStartup } from '../cutoverReconciler';
import { runCutover } from '../cutoverMachine';
import { readBackendState, writeBackendState } from '../BackendSelector';

/** The user's data. If this file is not readable at the end, the test failed. */
const MARKER = 'PG_VERSION';

/**
 * How far the *disk* actually got, independent of how far the journal says it
 * got. The gap between the two is the whole point: a process killed between a
 * rename and the journal write leaves them one apart.
 */
type DiskProgress = 'source_live' | 'source_preserved' | 'backend_committed';

describe('cutover reconciliation', () => {
  let tmp: string;
  let live: string;
  let preserved: string;
  let target: string;
  let staging: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-recon-'));
    live = path.join(tmp, 'pglite-db');
    preserved = path.join(tmp, 'pglite-db.migrated-2026-09-02T00-00-00-000Z');
    target = path.join(tmp, 'sqlite-db');
    staging = path.join(tmp, 'sqlite-db.dry-run-2026-09-01T00-00-00-000Z');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeSource(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MARKER), 'the user data');
  }

  function makeSqliteStore(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'nimbalyst.sqlite'), Buffer.alloc(128 * 1024, 1));
  }

  /** Fingerprint of whichever copy of the source this scene actually holds. */
  function sceneFingerprint() {
    const from = [preserved, live].find(
      (d) => fs.existsSync(d) && fs.readdirSync(d).length > 0,
    );
    return from ? fingerprintSource(from) : { entryCount: 1, totalBytes: 13, newestMtimeMs: 0 };
  }

  function journalAt(
    phase: CutoverPhase,
    opts: { operation?: 'migrate' | 'adopt'; attempts?: number } = {},
  ): CutoverJournal {
    return {
      version: 1,
      operationId: `op-${phase}`,
      operation: opts.operation ?? 'migrate',
      startedAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
      phase,
      reconcileAttempts: opts.attempts ?? 0,
      commitSetBy: 'auto-migration',
      source: {
        livePath: live,
        preservedPath: preserved,
        // Taken from whichever copy currently holds the data, the way a real
        // run takes it from the source before it moves it. A hardcoded
        // fingerprint would make every one of these scenes look like a source
        // that had been replaced since the journal was written.
        fingerprint: sceneFingerprint(),
      },
      target: {
        livePath: target,
        ...(opts.operation === 'adopt' ? { stagingPath: staging } : {}),
      },
      rollback: { backendBefore: 'pglite', stateBefore: null },
    };
  }

  /** Lay down the disk state a cutover would have left at `progress`. */
  function layOutDisk(progress: DiskProgress, operation: 'migrate' | 'adopt'): void {
    makeSource(progress === 'source_live' ? live : preserved);
    if (operation === 'adopt' && progress !== 'backend_committed') makeSqliteStore(staging);
    else makeSqliteStore(target);
    if (progress === 'backend_committed') {
      writeBackendState(tmp, {
        backend: 'sqlite',
        setAt: '2026-09-02T00:00:00.000Z',
        setBy: 'auto-migration',
        pgliteMigratedDir: preserved,
      });
    }
  }

  /** The invariants that must hold no matter which row of the table ran. */
  function assertNothingLost(): void {
    const copies = [live, preserved].filter((d) => fs.existsSync(path.join(d, MARKER)));
    expect(copies.length).toBeGreaterThanOrEqual(1);
  }

  // -------------------------------------------------------------------------
  // Every phase, with the disk exactly where the journal says it is, and one
  // step ahead of it (process killed between the move and the journal write).
  // -------------------------------------------------------------------------

  const EXPECTED: Record<CutoverPhase, Record<DiskProgress, 'completed' | 'rolled_back'>> = {
    prepared: {
      source_live: 'rolled_back',
      // The journal never claimed the target was verified, so the copy is not
      // trustworthy and the source goes back even though it has been moved.
      source_preserved: 'rolled_back',
      backend_committed: 'rolled_back',
    },
    target_verified: {
      source_live: 'rolled_back',
      source_preserved: 'completed',
      backend_committed: 'completed',
    },
    source_quiesced: {
      source_live: 'rolled_back',
      source_preserved: 'completed',
      backend_committed: 'completed',
    },
    source_preserved: {
      // The rename never landed. Nothing to undo but the flag.
      source_live: 'rolled_back',
      source_preserved: 'completed',
      backend_committed: 'completed',
    },
    backend_committed: {
      source_live: 'rolled_back',
      source_preserved: 'completed',
      backend_committed: 'completed',
    },
    reopened_verified: {
      // Unreachable in a real run -- `reopened_verified` implies the rename
      // landed -- but the rule is uniform: a source at its live path means the
      // preservation did not happen, so there is nothing to finish.
      source_live: 'rolled_back',
      source_preserved: 'completed',
      backend_committed: 'completed',
    },
  };

  for (const operation of ['migrate', 'adopt'] as const) {
    it(`${operation}: reconciles every phase against every disk state, idempotently`, () => {
      for (const phase of CUTOVER_PHASES) {
        for (const progress of ['source_live', 'source_preserved', 'backend_committed'] as const) {
          // Fresh scene per row; the outer temp dir is shared, the scene is not.
          for (const dir of [live, preserved, target, staging]) {
            fs.rmSync(dir, { recursive: true, force: true });
          }
          fs.rmSync(path.join(tmp, 'database-backend.json'), { force: true });

          layOutDisk(progress, operation);
          writeCutoverJournal(tmp, journalAt(phase, { operation }));

          const first = reconcileCutoverOnStartup({ userDataPath: tmp });
          const label = `${operation}/${phase}/${progress}`;
          expect(first.outcome, label).toBe(EXPECTED[phase][progress]);
          assertNothingLost();

          if (first.outcome === 'completed') {
            expect(readBackendState(tmp)?.backend, label).toBe('sqlite');
            expect(first.authoritativeBackend, label).toBe('sqlite');
            // The preserved source is the rollback copy. Nothing deletes it.
            expect(fs.existsSync(path.join(preserved, MARKER)), label).toBe(true);
            expect(fs.existsSync(path.join(target, 'nimbalyst.sqlite')), label).toBe(true);
          } else {
            expect(readBackendState(tmp)?.backend, label).toBe('pglite');
            expect(first.authoritativeBackend, label).toBe('pglite');
            // The source is back where the app looks for it, by the journaled
            // path -- not by a directory-name convention.
            expect(fs.existsSync(path.join(live, MARKER)), label).toBe(true);
            expect(fs.existsSync(preserved), label).toBe(false);
          }
          expect(first.pgliteCreationBlocked, label).toBe(false);

          // Idempotence: the journal is gone, so a second launch does nothing
          // and leaves the disk exactly as the first one left it.
          const before = fs.readdirSync(tmp).sort();
          expect(readCutoverJournal(tmp), label).toBeNull();
          const second = reconcileCutoverOnStartup({ userDataPath: tmp });
          expect(second.outcome, label).toBe('none');
          expect(fs.readdirSync(tmp).sort(), label).toEqual(before);
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // The specific regressions
  // -------------------------------------------------------------------------

  it('restores the real source rather than leaving an empty pglite-db behind', () => {
    // #1347's exact shape: a launch opened PGLite while the store was parked
    // aside, so PGLite created its data directory and the app came up empty.
    makeSource(preserved);
    fs.mkdirSync(live, { recursive: true });
    writeCutoverJournal(tmp, journalAt('source_preserved'));

    const result = reconcileCutoverOnStartup({ userDataPath: tmp });

    expect(result.outcome).toBe('rolled_back');
    expect(fs.readFileSync(path.join(live, MARKER), 'utf-8')).toBe('the user data');
    expect(fs.existsSync(preserved)).toBe(false);
  });

  it('holds rather than renaming the preserved source over a live one', () => {
    makeSource(preserved);
    makeSource(live);
    fs.writeFileSync(path.join(live, 'newer'), 'written since');
    writeCutoverJournal(tmp, journalAt('backend_committed'));

    const result = reconcileCutoverOnStartup({ userDataPath: tmp });

    expect(result.outcome).toBe('rolled_back');
    // Both copies survive; the live one was not overwritten.
    expect(fs.existsSync(path.join(live, 'newer'))).toBe(true);
    expect(fs.existsSync(path.join(preserved, MARKER))).toBe(true);
  });

  it('a rename the OS refuses holds, keeps the journal, and blocks opening PGLite', () => {
    makeSource(preserved);
    writeCutoverJournal(tmp, journalAt('source_preserved'));

    const eperm: CutoverFs = {
      exists: (p) => fs.existsSync(p),
      isNonEmptyDir: (p) => {
        try {
          return fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0;
        } catch {
          return false;
        }
      },
      rename: (from) => {
        const err = new Error(`EPERM: operation not permitted, rename '${from}'`) as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      },
    };

    const result = reconcileCutoverOnStartup({ userDataPath: tmp, cutoverFs: eperm });

    expect(result.outcome).toBe('held');
    expect(result.error).toMatch(/EPERM/);
    // The only real copy is still at the journaled preserved path, so opening
    // PGLite now would create an empty store on top of it.
    expect(result.pgliteCreationBlocked).toBe(true);
    expect(fs.existsSync(path.join(preserved, MARKER))).toBe(true);
    // The journal survives so the next launch can try again.
    expect(readCutoverJournal(tmp)?.phase).toBe('source_preserved');
  });

  it('stops moving anything once the attempts are exhausted', () => {
    makeSource(preserved);
    writeCutoverJournal(tmp, journalAt('source_preserved', { attempts: MAX_RECONCILE_ATTEMPTS }));

    const result = reconcileCutoverOnStartup({ userDataPath: tmp });

    expect(result.outcome).toBe('held');
    expect(result.reasonCode).toBe('reconcile_attempts_exhausted');
    expect(result.pgliteCreationBlocked).toBe(true);
    expect(fs.existsSync(path.join(preserved, MARKER))).toBe(true);
    expect(fs.existsSync(live)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Fault injection through the real machine, then reconcile what it left.
  // -------------------------------------------------------------------------

  /** Everything in userData except the snapshots we are collecting. */
  function snapshotUserData(into: string): void {
    fs.mkdirSync(into, { recursive: true });
    for (const entry of fs.readdirSync(tmp)) {
      if (entry === 'snapshots') continue;
      fs.cpSync(path.join(tmp, entry), path.join(into, entry), { recursive: true });
    }
  }

  function restoreUserData(from: string): void {
    for (const entry of fs.readdirSync(tmp)) {
      if (entry === 'snapshots') continue;
      fs.rmSync(path.join(tmp, entry), { recursive: true, force: true });
    }
    for (const entry of fs.readdirSync(from)) {
      fs.cpSync(path.join(from, entry), path.join(tmp, entry), { recursive: true });
    }
  }

  async function runFaultedCutover(
    failAt: 'verifyTarget' | 'quiesceSource' | 'finalizeTarget' | 'renameSource' | 'reopenAndVerify' | 'none',
  ): Promise<string[]> {
    const snapDir = path.join(tmp, 'snapshots');
    fs.rmSync(snapDir, { recursive: true, force: true });
    const labels: string[] = [];
    let n = 0;
    // A snapshot is what a SIGKILL at this instant would have left on disk.
    const kill = (label: string) => {
      const dir = path.join(snapDir, `${String(n++).padStart(2, '0')}-${label}`);
      snapshotUserData(dir);
      labels.push(dir);
    };
    const boom = (where: string) => {
      throw new Error(`injected failure in ${where}`);
    };

    const trackingFs: CutoverFs = {
      exists: (p) => fs.existsSync(p),
      isNonEmptyDir: (p) => {
        try {
          return fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0;
        } catch {
          return false;
        }
      },
      rename: (from, to) => {
        if (failAt === 'renameSource' && from === live) boom('renameSource');
        fs.renameSync(from, to);
        // The window the journal exists to survive: the source has moved but
        // the phase write has not landed yet.
        kill(`after-rename-${path.basename(from)}`);
      },
    };

    await runCutover({
      userDataPath: tmp,
      operationId: 'faulted',
      operation: 'migrate',
      sourceLiveDir: live,
      sourcePreservedDir: preserved,
      targetLiveDir: target,
      commitSetBy: 'auto-migration',
      cutoverFs: trackingFs,
      verifyTarget: async () => {
        kill('at-prepared');
        if (failAt === 'verifyTarget') boom('verifyTarget');
      },
      quiesceSource: async () => {
        kill('at-target_verified');
        if (failAt === 'quiesceSource') boom('quiesceSource');
      },
      finalizeTarget: async () => {
        kill('after-quiesce-before-phase-write');
        if (failAt === 'finalizeTarget') boom('finalizeTarget');
      },
      reopenAndVerify: async () => {
        kill('at-backend_committed');
        if (failAt === 'reopenAndVerify') boom('reopenAndVerify');
      },
    }).catch((err) => {
      if (failAt === 'none') throw err;
    });

    return labels;
  }

  it('survives a fault or a kill at every point in the cutover', async () => {
    const points = [
      'none',
      'verifyTarget',
      'quiesceSource',
      'finalizeTarget',
      'renameSource',
      'reopenAndVerify',
    ] as const;

    for (const failAt of points) {
      for (const dir of [live, preserved, target]) fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(path.join(tmp, 'database-backend.json'), { force: true });
      fs.rmSync(path.join(tmp, 'database-cutover.json'), { force: true });
      makeSource(live);
      makeSqliteStore(target);

      const kills = await runFaultedCutover(failAt);

      // Whatever the ordinary error did, the live process must not have lost
      // anything: the marker is readable from at least one location.
      assertNothingLost();

      expect(kills.length, failAt).toBeGreaterThan(0);

      // Replay every kill point through startup reconciliation, twice over:
      // once with the SQLite target intact (startup should finish the cutover
      // where it can) and once with it gone (startup must put the source back).
      for (const snapshot of kills) {
        for (const targetSurvives of [true, false]) {
          restoreUserData(snapshot);
          if (!targetSurvives) fs.rmSync(target, { recursive: true, force: true });
          const label = `${failAt} @ ${path.basename(snapshot)} target=${targetSurvives}`;

          const result = reconcileCutoverOnStartup({ userDataPath: tmp });
          const sources = [live, preserved].filter((d) => fs.existsSync(path.join(d, MARKER)));
          expect(sources.length, label).toBeGreaterThanOrEqual(1);

          if (result.outcome === 'completed') {
            expect(readBackendState(tmp)?.backend, label).toBe('sqlite');
            // The rollback copy is retained, never deleted.
            expect(fs.existsSync(path.join(preserved, MARKER)), label).toBe(true);
          } else if (result.outcome === 'rolled_back') {
            expect(readBackendState(tmp)?.backend, label).toBe('pglite');
            // The old authoritative database is back at the path the app opens,
            // and the preserved copy has been consumed by that move rather than
            // left as a second candidate.
            expect(fs.existsSync(path.join(live, MARKER)), label).toBe(true);
            expect(fs.existsSync(preserved), label).toBe(false);
          }
          // Never "an empty PGLite directory while the real store sits at the
          // preserved path": either the source is where the app looks for it,
          // or startup has told the caller not to open PGLite at all.
          const liveIsReal = fs.existsSync(path.join(live, MARKER));
          const strandedAtPreserved = !liveIsReal && fs.existsSync(path.join(preserved, MARKER));
          if (strandedAtPreserved) {
            expect(result.authoritativeBackend, label).not.toBe('pglite');
          }

          // Second launch changes nothing.
          const after = fs.readdirSync(tmp).filter((e) => e !== 'snapshots').sort();
          reconcileCutoverOnStartup({ userDataPath: tmp });
          expect(fs.readdirSync(tmp).filter((e) => e !== 'snapshots').sort(), label).toEqual(after);
        }
      }
    }
  });

  it('does nothing when there is no journal, however the directories look', () => {
    makeSource(live);
    makeSqliteStore(target);
    expect(reconcileCutoverOnStartup({ userDataPath: tmp }).outcome).toBe('none');
    expect(fs.existsSync(path.join(live, MARKER))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // A journal that cannot be understood is not the same as no journal.
  // -------------------------------------------------------------------------

  describe('a journal it cannot understand', () => {
    /** The #1347 shape: the only real store is parked aside, pglite-db is gone. */
    function strandedSource(): void {
      makeSource(preserved);
      makeSqliteStore(target);
    }

    function assertFailsClosed(detailMatch: RegExp): void {
      const result = reconcileCutoverOnStartup({ userDataPath: tmp });
      expect(result.outcome).toBe('held');
      expect(result.reasonCode).toBe('journal_unreadable');
      expect(result.error).toMatch(detailMatch);
      // The caller must not open PGLite: doing so creates an empty store on
      // top of the one sitting at `preserved`.
      expect(result.pgliteCreationBlocked).toBe(true);
      // And nothing was moved, because we do not know where anything belongs.
      expect(fs.existsSync(path.join(preserved, MARKER))).toBe(true);
      expect(fs.existsSync(live)).toBe(false);
    }

    it('a half-written journal blocks the open instead of reading as "no cutover"', () => {
      strandedSource();
      fs.writeFileSync(
        path.join(tmp, 'database-cutover.json'),
        '{"version":1,"operationId":"op-1","phase":"source_pre',
        'utf-8',
      );
      assertFailsClosed(/not valid JSON/);
    });

    it('a journal from a future build blocks the open rather than being ignored', () => {
      strandedSource();
      fs.writeFileSync(
        path.join(tmp, 'database-cutover.json'),
        JSON.stringify({ ...journalAt('source_preserved'), version: 2 }),
        'utf-8',
      );
      assertFailsClosed(/version 2/);
    });

    it('lets the app boot when the live store is where it belongs', () => {
      // Same unreadable journal, but nothing is stranded -- there is no empty
      // database to create, so failing closed here would wedge a healthy
      // install over a stray file.
      makeSource(live);
      fs.writeFileSync(path.join(tmp, 'database-cutover.json'), 'not json at all', 'utf-8');
      const result = reconcileCutoverOnStartup({ userDataPath: tmp });
      expect(result.outcome).toBe('held');
      expect(result.pgliteCreationBlocked).toBe(false);
      expect(result.sqliteCreationBlocked).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // The fingerprint recorded before the move has to mean something.
  // -------------------------------------------------------------------------

  it('refuses to restore a preserved source that is not the one it recorded', () => {
    // A cutover got as far as preserving the source, then died. Between then
    // and this launch something replaced the preserved directory -- a restore
    // from elsewhere, a user copying a folder, a partially-deleted store.
    makeSource(preserved);
    // Journal the source as it was, then change it underneath.
    const journal = journalAt('source_preserved');
    fs.writeFileSync(path.join(preserved, 'A-SECOND-FILE'), 'not what we journaled');
    // No trusted target, so without the fingerprint check this plans a
    // rollback and renames that directory over the live path.
    writeCutoverJournal(tmp, journal);

    const result = reconcileCutoverOnStartup({ userDataPath: tmp });

    expect(result.outcome).toBe('held');
    expect(result.reasonCode).toBe('source_fingerprint_mismatch');
    expect(result.pgliteCreationBlocked).toBe(true);
    // Held means held: both copies are exactly where they were.
    expect(fs.existsSync(path.join(preserved, MARKER))).toBe(true);
    expect(fs.existsSync(live)).toBe(false);
  });

  it('restores a preserved source whose fingerprint still matches', () => {
    makeSource(preserved);
    writeCutoverJournal(tmp, journalAt('source_preserved'));

    const result = reconcileCutoverOnStartup({ userDataPath: tmp });

    expect(result.outcome).toBe('rolled_back');
    expect(fs.existsSync(path.join(live, MARKER))).toBe(true);
  });
});
