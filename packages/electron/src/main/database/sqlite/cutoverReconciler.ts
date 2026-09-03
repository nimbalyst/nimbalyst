/**
 * Deciding what to do about a cutover that did not finish.
 *
 * Split deliberately into a pure planner and a thin applier, because
 * `.claude/rules/destructive-data-paths.md` says the decision has to be
 * testable outside the environment that triggers it. The branch that renamed
 * `pglite-db/` aside in #1347 could only fire inside a real PGLite WASM abort,
 * so in nine months it never once ran under observation. `planCutover` takes
 * the journal and a bag of observed facts and returns a plan; every phase,
 * every crash point and the Windows rename-lock case are ordinary unit tests.
 *
 * The rule the planner exists to enforce: decide from the journal, never from
 * which directories happen to exist. Directory presence is an *input* here --
 * it tells us how far the last process actually got -- but the paths always
 * come from what was written down before the first move, so a rollback puts
 * the source back where the journal says it came from rather than where a
 * naming convention suggests it should go.
 *
 * Nothing in this file deletes a `pglite-db.migrated-*` directory. Rolling
 * back renames it back into place; completing leaves it where it is. It stays
 * the rollback source until the user explicitly resolves it.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  MAX_RECONCILE_ATTEMPTS,
  clearCutoverJournal,
  fingerprintSource,
  fingerprintsMatch,
  phaseAtLeast,
  readCutoverJournalStatus,
  realCutoverFs,
  writeCutoverJournal,
  type CutoverFs,
  type CutoverJournal,
} from './cutoverJournal';
import {
  commitMigrationToSqlite,
  commitRollbackToPglite,
  writeBackendState,
  type BackendState,
  type DatabaseBackend,
} from './BackendSelector';

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface CutoverObservedFacts {
  /** The journaled live source path exists and holds something. */
  liveSourcePresent: boolean;
  /**
   * The journaled live source path exists but is an empty directory. This is
   * the #1347 shape exactly: PGLite creates its data dir on open, so a launch
   * that opened PGLite while the real store was parked in `pglite-db.migrated-*`
   * left an empty directory sitting where the store belongs.
   */
  liveSourceEmptyDir: boolean;
  /** The journaled preserved path exists. */
  preservedSourcePresent: boolean;
  /** The journaled target path holds a usable SQLite store. */
  targetPresent: boolean;
  /** The journaled staging path (adoption only) exists. */
  stagingPresent: boolean;
  /** Fingerprint of whichever copy of the source we found, for the log. */
  observedSourceFingerprintMatches: boolean;
  /**
   * Does the *preserved* copy still look like the directory we journaled?
   * Null when there is no preserved copy to compare.
   *
   * This is the one the planner acts on, and it is deliberately not the same
   * question as `observedSourceFingerprintMatches`. The live source keeps
   * taking writes right up until the quiesce, so its fingerprint legitimately
   * drifts and gating on it would wedge ordinary aborted migrations. The
   * preserved copy is frozen the moment it is renamed, so a mismatch there
   * means something replaced it -- and renaming that something over the live
   * path is exactly the class of move this module exists to refuse.
   */
  preservedSourceFingerprintMatches: boolean | null;
}

export type CutoverReconcileReason =
  | 'no_journal'
  | 'journal_unreadable'
  | 'source_fingerprint_mismatch'
  | 'nothing_moved_yet'
  | 'source_preserved_target_ready'
  | 'source_preserved_no_target'
  | 'source_preserved_live_source_intact'
  | 'backend_committed_target_ready'
  | 'backend_committed_target_missing'
  | 'already_finished'
  | 'source_missing_everywhere'
  | 'live_source_would_be_clobbered'
  | 'reconcile_attempts_exhausted';

export type CutoverPlanStep =
  | { action: 'restore_source'; from: string; to: string }
  | { action: 'promote_staging'; from: string; to: string }
  | {
      action: 'commit_backend';
      /** Which engine the flag ends up naming. `pglite` is a rollback. */
      backend: DatabaseBackend;
      pgliteMigratedDir: string;
      setBy: 'user-migration' | 'auto-migration';
    }
  | { action: 'restore_backend'; state: BackendState | null }
  | { action: 'clear_journal' };

export interface CutoverPlan {
  disposition: 'none' | 'complete' | 'roll_back' | 'hold';
  reasonCode: CutoverReconcileReason;
  steps: CutoverPlanStep[];
  /**
   * Which backend the app must open after these steps run. `null` means the
   * reconciler could not name one, and the caller must not open either -- see
   * `pgliteCreationBlocked`.
   */
  authoritativeBackend: DatabaseBackend | null;
  /**
   * Opening PGLite right now would create an empty store while the real one
   * sits at the journaled preserved path. This is the single most important
   * output of this module; a caller that ignores it reproduces #1347.
   */
  pgliteCreationBlocked: boolean;
  /**
   * The same rule for the other engine. A forward cutover never strands the
   * SQLite store -- it builds it -- but a rollback moves it aside, so an
   * interrupted rollback leaves `sqlite-db/` absent with the real one under
   * `sqlite-db.rolledback-*`. Opening SQLite there creates an empty database
   * just as surely.
   */
  sqliteCreationBlocked: boolean;
}

// ---------------------------------------------------------------------------
// The pure decision
// ---------------------------------------------------------------------------

/** Which engine's store `journal.source` describes. */
export function cutoverSourceBackend(journal: CutoverJournal): DatabaseBackend {
  return (journal.commitBackend ?? 'sqlite') === 'pglite' ? 'sqlite' : 'pglite';
}

/** Which engine's store `journal.target` describes. */
export function cutoverTargetBackend(journal: CutoverJournal): DatabaseBackend {
  return journal.commitBackend ?? 'sqlite';
}

export function planCutover(
  journal: CutoverJournal | null,
  facts: CutoverObservedFacts,
): CutoverPlan {
  if (!journal) {
    return {
      disposition: 'none',
      reasonCode: 'no_journal',
      steps: [],
      authoritativeBackend: null,
      pgliteCreationBlocked: false,
      sqliteCreationBlocked: false,
    };
  }

  const sourceStranded = !facts.liveSourcePresent && facts.preservedSourcePresent;

  if (journal.reconcileAttempts >= MAX_RECONCILE_ATTEMPTS) {
    // Three launches have tried and not got anywhere. Stop moving things.
    // Every copy is still on disk and the journal still names all of them.
    return {
      disposition: 'hold',
      reasonCode: 'reconcile_attempts_exhausted',
      steps: [],
      authoritativeBackend: null,
      ...blockedBackends(journal, sourceStranded),
    };
  }

  // The target is only trustworthy once the journal says it was verified. A
  // half-built sqlite-db from a run that died in the copy is a directory, not a
  // database, and "a directory exists" is exactly the kind of evidence this
  // module refuses to act on.
  const targetTrusted =
    phaseAtLeast(journal.phase, 'target_verified') && (facts.targetPresent || facts.stagingPresent);

  // The source is still where the app looks for it, so the preservation never
  // landed no matter what the journal claims. There is nothing to finish: the
  // only correct end state is the one the install was already in. The target,
  // half-built or verified, is left alone -- it is a recoverable copy, and
  // deleting copies is not this module's job.
  if (facts.liveSourcePresent) {
    return rollBack(
      journal,
      facts,
      phaseAtLeast(journal.phase, 'source_preserved')
        ? 'source_preserved_live_source_intact'
        : 'nothing_moved_yet',
    );
  }

  if (journal.phase === 'reopened_verified') {
    return complete(journal, facts, 'already_finished');
  }

  // Where is the source, really? The journal records the intent to move it
  // before the move happens, so a process that died between `rename()` and the
  // phase write leaves a journal one phase behind the disk. Both cases land
  // here identically because both are answered from the journaled paths.
  const sourceIsPreserved = sourceStranded || journal.phase === 'source_preserved';

  if (journal.phase === 'backend_committed') {
    if (targetTrusted) return complete(journal, facts, 'backend_committed_target_ready');
    if (facts.preservedSourcePresent) {
      return rollBack(journal, facts, 'backend_committed_target_missing');
    }
    return hold(journal, facts, 'source_missing_everywhere');
  }

  if (sourceIsPreserved) {
    if (targetTrusted) return complete(journal, facts, 'source_preserved_target_ready');
    if (facts.preservedSourcePresent) {
      return rollBack(journal, facts, 'source_preserved_no_target');
    }
    return hold(journal, facts, 'source_missing_everywhere');
  }

  // `prepared`, `target_verified` or `source_quiesced` with the source at
  // neither path. Nothing here can name an authoritative store.
  return hold(journal, facts, 'source_missing_everywhere');
}

function complete(
  journal: CutoverJournal,
  facts: CutoverObservedFacts,
  reasonCode: CutoverReconcileReason,
): CutoverPlan {
  const steps: CutoverPlanStep[] = [];
  const staging = journal.target.stagingPath;
  if (staging && facts.stagingPresent && !facts.targetPresent) {
    steps.push({ action: 'promote_staging', from: staging, to: journal.target.livePath });
  }
  // Emitted even when the journal says the flag was already committed. The
  // write is idempotent, and a journal that outlived its own commit is exactly
  // the case where the flag on disk cannot be taken on trust.
  steps.push({
    action: 'commit_backend',
    backend: cutoverTargetBackend(journal),
    pgliteMigratedDir: journal.source.preservedPath,
    setBy: journal.commitSetBy ?? 'auto-migration',
  });
  steps.push({ action: 'clear_journal' });
  return {
    disposition: 'complete',
    reasonCode,
    steps,
    authoritativeBackend: cutoverTargetBackend(journal),
    pgliteCreationBlocked: false,
    sqliteCreationBlocked: false,
  };
}

function rollBack(
  journal: CutoverJournal,
  facts: CutoverObservedFacts,
  reasonCode: CutoverReconcileReason,
): CutoverPlan {
  const steps: CutoverPlanStep[] = [];
  if (!facts.liveSourcePresent && facts.preservedSourcePresent) {
    // The preserved copy is frozen once it is renamed, so its fingerprint has
    // to still be the one we wrote down. When it is not, the directory we are
    // about to move back is not the directory we moved aside, and putting it
    // where the app looks for its database is a guess about the user's data.
    if (facts.preservedSourceFingerprintMatches === false) {
      return hold(journal, facts, 'source_fingerprint_mismatch');
    }
    if (facts.liveSourceEmptyDir || !directoryOccupied(facts)) {
      steps.push({
        action: 'restore_source',
        from: journal.source.preservedPath,
        to: journal.source.livePath,
      });
    } else {
      // Something real is sitting where the source belongs and it is not the
      // source we moved. Renaming over it would destroy it. Hold instead.
      return hold(journal, facts, 'live_source_would_be_clobbered');
    }
  }
  steps.push({ action: 'restore_backend', state: journal.rollback.stateBefore });
  steps.push({ action: 'clear_journal' });
  return {
    disposition: 'roll_back',
    reasonCode,
    steps,
    authoritativeBackend: journal.rollback.backendBefore,
    pgliteCreationBlocked: false,
    sqliteCreationBlocked: false,
  };
}

/**
 * Which engine must not be opened, given that the source store is stranded at
 * its preserved path. Only ever one of the two: the source belongs to exactly
 * one engine, and the other one's store is untouched by this operation.
 */
function blockedBackends(
  journal: CutoverJournal,
  sourceStranded: boolean,
): { pgliteCreationBlocked: boolean; sqliteCreationBlocked: boolean } {
  const backend = cutoverSourceBackend(journal);
  return {
    pgliteCreationBlocked: sourceStranded && backend === 'pglite',
    sqliteCreationBlocked: sourceStranded && backend === 'sqlite',
  };
}

/** True when the live source path holds something that is not ours to move. */
function directoryOccupied(facts: CutoverObservedFacts): boolean {
  return facts.liveSourcePresent && !facts.liveSourceEmptyDir;
}

function hold(
  journal: CutoverJournal,
  facts: CutoverObservedFacts,
  reasonCode: CutoverReconcileReason,
): CutoverPlan {
  return {
    disposition: 'hold',
    reasonCode,
    steps: [],
    authoritativeBackend: null,
    ...blockedBackends(journal, !facts.liveSourcePresent && facts.preservedSourcePresent),
  };
}

// ---------------------------------------------------------------------------
// Observing
// ---------------------------------------------------------------------------

/** Below this a `nimbalyst.sqlite` is a stub, not a store. Matches BackendSelector. */
const SQLITE_PLAUSIBLE_MIN_BYTES = 64 * 1024;

function sqliteStorePresent(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'nimbalyst.sqlite')).size >= SQLITE_PLAUSIBLE_MIN_BYTES;
  } catch {
    return false;
  }
}

export function observeCutoverFacts(
  journal: CutoverJournal,
  cutoverFs: CutoverFs = realCutoverFs,
): CutoverObservedFacts {
  const liveExists = cutoverFs.exists(journal.source.livePath);
  const liveOccupied = liveExists && cutoverFs.isNonEmptyDir(journal.source.livePath);
  const preservedSourcePresent = cutoverFs.exists(journal.source.preservedPath);
  const observedPath = liveOccupied
    ? journal.source.livePath
    : preservedSourcePresent
      ? journal.source.preservedPath
      : null;
  // A rollback's target is a PGLite store, so "is there a store here?" is not
  // the same question in both directions.
  const storePresent = (dir: string): boolean =>
    cutoverTargetBackend(journal) === 'pglite'
      ? cutoverFs.isNonEmptyDir(dir)
      : sqliteStorePresent(dir);
  return {
    liveSourcePresent: liveOccupied,
    liveSourceEmptyDir: liveExists && !liveOccupied,
    preservedSourcePresent,
    targetPresent: storePresent(journal.target.livePath),
    stagingPresent: journal.target.stagingPath
      ? storePresent(journal.target.stagingPath)
      : false,
    observedSourceFingerprintMatches: observedPath
      ? fingerprintsMatch(fingerprintSource(observedPath), journal.source.fingerprint)
      : false,
    preservedSourceFingerprintMatches: preservedSourcePresent
      ? fingerprintsMatch(
          fingerprintSource(journal.source.preservedPath),
          journal.source.fingerprint,
        )
      : null,
  };
}

/**
 * Which engines have their live store missing while a sibling copy of it sits
 * next to it. Read from the conventional directory names, and used for exactly
 * one thing: deciding what must *not* be opened when there is no journal to
 * name paths from. It never authorizes a move -- a directory listing is not
 * evidence of where data belongs, only of where it is not.
 */
export function observeStrandedStores(
  userDataPath: string,
  cutoverFs: CutoverFs = realCutoverFs,
): { pglite: boolean; sqlite: boolean } {
  let entries: string[];
  try {
    entries = fs.readdirSync(userDataPath);
  } catch {
    return { pglite: false, sqlite: false };
  }
  const hasSibling = (prefix: string): boolean =>
    entries.some(
      (e) => e.startsWith(prefix) && cutoverFs.isNonEmptyDir(path.join(userDataPath, e)),
    );
  const pgliteLive = path.join(userDataPath, 'pglite-db');
  const sqliteLive = path.join(userDataPath, 'sqlite-db');
  return {
    pglite: !cutoverFs.isNonEmptyDir(pgliteLive) && hasSibling('pglite-db.migrated-'),
    sqlite: !sqliteStorePresent(sqliteLive) && hasSibling('sqlite-db.rolledback-'),
  };
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

export interface CutoverReconcileResult {
  outcome: 'none' | 'completed' | 'rolled_back' | 'held';
  reasonCode: CutoverReconcileReason;
  authoritativeBackend: DatabaseBackend | null;
  /** The caller must not open PGLite when this is true. See `CutoverPlan`. */
  pgliteCreationBlocked: boolean;
  /** The caller must not open SQLite when this is true. See `CutoverPlan`. */
  sqliteCreationBlocked: boolean;
  /** Present when a step threw. The journal is left in place for next launch. */
  error?: string;
}

export interface ReconcileOptions {
  userDataPath: string;
  cutoverFs?: CutoverFs;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
}

/**
 * Read the journal, plan, and carry the plan out. Idempotent: a successful run
 * clears the journal, so a second call finds nothing to do. A run that throws
 * part-way leaves the journal in place with its attempt count incremented, so
 * the next launch re-plans against whatever actually happened.
 */
export function reconcileCutoverOnStartup(opts: ReconcileOptions): CutoverReconcileResult {
  const log = opts.log ?? (() => {});
  const cutoverFs = opts.cutoverFs ?? realCutoverFs;
  const read = readCutoverJournalStatus(opts.userDataPath);
  if (read.status === 'absent') {
    return {
      outcome: 'none',
      reasonCode: 'no_journal',
      authoritativeBackend: null,
      pgliteCreationBlocked: false,
      sqliteCreationBlocked: false,
    };
  }
  if (read.status === 'unreadable') {
    // A cutover was running and we cannot tell what it was doing. There is
    // nothing safe to move -- every path this module acts on comes from the
    // journal, and this one names none. What we can still do is refuse to let
    // startup create a database on top of a store that a cutover may already
    // have parked aside, which is the failure mode that made #1347 permanent.
    //
    // The scan below is deliberately not a decision about where data belongs;
    // it only answers "would opening this engine create an empty store while
    // a sibling copy exists". A healthy install trips none of it and boots.
    const stranded = observeStrandedStores(opts.userDataPath, cutoverFs);
    log('error', '[cutover] journal present but unreadable; refusing to infer a backend', {
      detail: read.detail,
      strandedPglite: stranded.pglite,
      strandedSqlite: stranded.sqlite,
    });
    return {
      outcome: 'held',
      reasonCode: 'journal_unreadable',
      authoritativeBackend: null,
      pgliteCreationBlocked: stranded.pglite,
      sqliteCreationBlocked: stranded.sqlite,
      error: read.detail,
    };
  }
  const journal = read.journal;

  // Count the attempt before acting. A launch that dies inside the plan must
  // still burn an attempt, otherwise a crashing step relaunches forever.
  writeCutoverJournal(opts.userDataPath, {
    ...journal,
    reconcileAttempts: journal.reconcileAttempts + 1,
  });

  const facts = observeCutoverFacts(journal, cutoverFs);
  const plan = planCutover({ ...journal, reconcileAttempts: journal.reconcileAttempts }, facts);
  log('info', '[cutover] reconciling interrupted cutover', {
    operationId: journal.operationId,
    operation: journal.operation,
    phase: journal.phase,
    attempt: journal.reconcileAttempts + 1,
    disposition: plan.disposition,
    reasonCode: plan.reasonCode,
    fingerprintMatches: facts.observedSourceFingerprintMatches,
  });

  if (plan.disposition === 'hold' || plan.disposition === 'none') {
    return {
      outcome: plan.disposition === 'hold' ? 'held' : 'none',
      reasonCode: plan.reasonCode,
      authoritativeBackend: plan.authoritativeBackend,
      pgliteCreationBlocked: plan.pgliteCreationBlocked,
      sqliteCreationBlocked: plan.sqliteCreationBlocked,
    };
  }

  try {
    applyCutoverPlan(opts.userDataPath, plan, cutoverFs);
  } catch (err) {
    // Nothing was deleted; whichever copies existed still exist. The journal is
    // deliberately left behind so the next launch re-plans from the real disk
    // state rather than from this half-applied one.
    const message = (err as Error).message;
    log('error', '[cutover] reconciliation step failed; leaving journal in place', {
      reasonCode: plan.reasonCode,
      err: message,
    });
    const after = observeCutoverFacts(journal, cutoverFs);
    return {
      outcome: 'held',
      reasonCode: plan.reasonCode,
      authoritativeBackend: null,
      ...blockedBackends(journal, !after.liveSourcePresent && after.preservedSourcePresent),
      error: message,
    };
  }

  return {
    outcome: plan.disposition === 'complete' ? 'completed' : 'rolled_back',
    reasonCode: plan.reasonCode,
    authoritativeBackend: plan.authoritativeBackend,
    pgliteCreationBlocked: false,
    sqliteCreationBlocked: false,
  };
}

export function applyCutoverPlan(
  userDataPath: string,
  plan: CutoverPlan,
  cutoverFs: CutoverFs = realCutoverFs,
): void {
  for (const step of plan.steps) {
    switch (step.action) {
      case 'restore_source': {
        if (!cutoverFs.exists(step.from)) break; // already restored
        if (cutoverFs.exists(step.to)) {
          if (cutoverFs.isNonEmptyDir(step.to)) {
            throw new Error(
              `refusing to restore ${step.from} over a non-empty ${step.to}`,
            );
          }
          // An empty directory here is the artifact of a launch that opened
          // PGLite while the real store was parked aside. Removing an empty
          // directory destroys nothing; leaving it makes the rename fail and
          // strands the only real copy.
          fs.rmdirSync(step.to);
        }
        cutoverFs.rename(step.from, step.to);
        break;
      }
      case 'promote_staging': {
        if (!cutoverFs.exists(step.from)) break;
        if (cutoverFs.exists(step.to)) break;
        cutoverFs.rename(step.from, step.to);
        break;
      }
      case 'commit_backend':
        if (step.backend === 'pglite') {
          // Finishing an interrupted rollback. `setBy: 'rollback'` is what
          // stops a later launch offering the migration the user just undid.
          commitRollbackToPglite(userDataPath);
        } else {
          commitMigrationToSqlite(userDataPath, step.pgliteMigratedDir, step.setBy);
        }
        break;
      case 'restore_backend':
        writeBackendState(
          userDataPath,
          step.state ?? {
            backend: 'pglite',
            setAt: new Date().toISOString(),
            // Not `rollback`: that value means the user chose PGLite, and
            // claiming they did would permanently opt them out of a migration
            // they never saw. This install simply has one deferred.
            setBy: 'auto-migration-deferred',
          },
        );
        break;
      case 'clear_journal':
        clearCutoverJournal(userDataPath);
        break;
    }
  }
}
