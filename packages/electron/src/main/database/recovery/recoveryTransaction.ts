/**
 * The backend-independent recovery transaction.
 *
 * One implementation serves PGLite-active and SQLite-active installs, and it is
 * also what both backup services now restore through, so the ordering below
 * exists in exactly one place.
 *
 * The ordering is the entire safety argument. What shipped before this was:
 *
 *     close the database -> fs.rm the live copy -> copy the candidate in
 *
 * which loses everything if the process dies during the copy, and cheerfully
 * replaces two months of history with a structurally-valid empty file (#1347).
 * The replacement never removes anything until a verified replacement is
 * already sitting on disk next to it, and the removal is a rename:
 *
 *     reassess -> quiesce -> snapshot -> stage -> verify -> swap -> reopen -> verify
 *
 * Rules this encodes, from `.claude/rules/destructive-data-paths.md`:
 *
 *   - Retry before you destroy: quiesce gets a second attempt, and a close that
 *     still cannot be confirmed aborts the transaction rather than proceeding.
 *   - Verify the damage is real: the staged target passes a full integrity and
 *     content check before the live database moves anywhere.
 *   - Emit before you act: `recovery_started` goes out ahead of the first
 *     destructive operation, so a process that dies mid-recovery still reported
 *     that it began.
 *   - Leave a recoverable artifact: the source artifact, the pre-restore
 *     snapshot, and the displaced live database all survive success and
 *     failure alike. Nothing here is deleted on a timer.
 *
 * `beforeStep` is a fault-injection seam rather than a mock: every other step
 * runs its real filesystem work against real files. Injecting at
 * `swap-promote` reproduces the one boundary that actually loses data -- the
 * live database renamed aside and the replacement not yet in place.
 */

import { assertCandidateStillPresent } from './recoveryFs';
import type { RecoveryJournalPort } from './recoveryJournal';
import type {
  ActiveBackend,
  AssessmentReasonCode,
  AssessmentVerdict,
  CandidateAssessment,
  ContentIndicators,
  SizeBucket,
  RecoveryArtifactPaths,
  RecoveryDomainEvent,
  RecoveryLogFn,
  RecoveryOutcome,
  RecoveryRefusalCode,
  RecoveryStep,
  RecoveryVerification,
} from './types';

/**
 * What genuinely differs between backends: how to quiesce, what a "database"
 * is on disk, how to check one, and what to call the copies left behind.
 * Everything else is in `runRecoveryTransaction`.
 */
export interface RecoveryBackendAdapter {
  readonly backend: ActiveBackend;
  /** The live database: a directory for PGLite, a file for SQLite. */
  readonly livePath: string;
  /**
   * Where recovery copies are placed. Must be the same filesystem as
   * `livePath` so the swap is a rename rather than a copy.
   */
  recoveryPathFor(label: string, timestamp: string): string;
  /** Close the live database. Must reject if the close cannot be confirmed. */
  quiesce(): Promise<void>;
  /** Reopen after the swap, through the same path production uses. */
  reopen(): Promise<void>;
  /** Copy the live database aside. No-op when there is no live database. */
  snapshot(destPath: string): Promise<void>;
  /**
   * Produce a database in THIS backend's on-disk format at `destPath` from the
   * candidate. For a PGLite artifact on a SQLite-active install this is a
   * migration into a fresh SQLite target — which is what keeps recovery from
   * flipping the install back to PGLite.
   */
  stage(candidatePath: string, destPath: string): Promise<void>;
  /**
   * Full validation of a staged target: integrity, required schema, content
   * indicators. Must not run on the main thread or on the query-serving
   * worker — a `PRAGMA integrity_check` over a 6.3 GB database blocked that
   * thread for 66 seconds and killed 221 queued requests.
   */
  verify(targetPath: string): Promise<RecoveryVerification>;
  /** Content indicators read back through the production proxy after reopen. */
  readLiveIndicators(): Promise<ContentIndicators>;
  /** Move a database, including any sidecar files the backend keeps. */
  move(from: string, to: string): Promise<void>;
  /** True when a database exists at this path. */
  exists(dbPath: string): Promise<boolean>;
  /**
   * Remove scratch this transaction created. Only ever called on the staging
   * copy, and only after the source artifact is confirmed still on disk.
   */
  discardScratch(scratchPath: string): Promise<void>;
}

export interface RecoveryTransactionArgs {
  candidateId: string;
  /** Resolved from the allowlist by the caller; never user-supplied. */
  candidatePath: string;
  adapter: RecoveryBackendAdapter;
  /**
   * Re-gathered assessment, run immediately before acting, together with the
   * fingerprint the user's decision was made against.
   *
   * Omitted by the rolling-backup restore path, where there is no artifact to
   * assess and the user named the backup explicitly. That path still gets
   * every other guarantee — verified staging, atomic swap, a preserved
   * displaced database, and the empty-candidate refusal at step 6, which is
   * where the protection against restoring nothing over something actually
   * lives.
   */
  eligibility?: {
    reassess: () => Promise<CandidateAssessment>;
    expectedFingerprint: string;
    /**
     * Verdicts that authorize acting. Defaults to both actionable ones:
     * `recovery_recommended` is offered proactively, `needs_review` only ever
     * reaches here behind an explicit choice in Settings.
     */
    allowedVerdicts?: AssessmentVerdict[];
  };
  /** Bounded facts for the lifecycle events. Never free-form. */
  context: {
    candidateSizeBucket: SizeBucket;
    liveSizeBucket: SizeBucket;
    reasonCode: AssessmentReasonCode | null;
  };
  emit?: (event: RecoveryDomainEvent) => void;
  /**
   * Durable record of the swap, so a process killed between the two renames
   * leaves the next launch something to read instead of an absent database and
   * a guess. Production always supplies one; see `recoveryJournal.ts`. Omitted
   * only by unit tests that assert on a single step's filesystem behaviour.
   */
  journal?: RecoveryJournalPort;
  /** Identifies this run in the journal and the log. */
  operationId?: string;
  log?: RecoveryLogFn;
  now?: () => Date;
  /** Fault-injection seam. Called at the start of each step; throwing aborts it. */
  beforeStep?: (step: RecoveryStep) => void | Promise<void>;
}

const DEFAULT_ALLOWED: AssessmentVerdict[] = ['recovery_recommended', 'needs_review'];

/**
 * Steps that run before the live database has moved anywhere. A failure at any
 * of them leaves the install exactly as it was found and clears the journal on
 * the way out.
 */
const PRE_SWAP_STEPS: readonly RecoveryStep[] = [
  'reassess',
  'quiesce',
  'snapshot',
  'stage',
  'verify',
];

/**
 * May a caller sweeping several candidates try the next one after this outcome?
 *
 * Only after a pre-swap refusal. Once the swap has been attempted the install
 * may be carrying an unresolved journal, a displaced database, or both, and the
 * next attempt's `begin()` would be writing over the only record of where that
 * database went. `DatabaseBackupService` and `SQLiteBackupService` both swept
 * unconditionally, which is how a persistent promote failure ended with the
 * user's database under a `.displaced-*` name that nothing pointed at.
 */
export function mayTryAnotherCandidate(outcome: RecoveryOutcome): boolean {
  if (outcome.ok) return false;
  // The journal from an earlier attempt is still on disk and unresolved. This
  // is the exact state a further attempt would erase.
  if (outcome.code === 'recovery_in_progress') return false;
  if (outcome.failedStep === null) return true;
  return PRE_SWAP_STEPS.includes(outcome.failedStep);
}

/** One extra attempt. A close that fails twice is not a close we may work around. */
const QUIESCE_ATTEMPTS = 2;

export async function runRecoveryTransaction(
  args: RecoveryTransactionArgs,
): Promise<RecoveryOutcome> {
  const { candidateId, candidatePath, adapter, eligibility, context, emit, beforeStep } = args;
  const log: RecoveryLogFn = args.log ?? (() => {});
  const now = args.now ?? (() => new Date());
  const backend = adapter.backend;
  const journal = args.journal;

  const artifacts: Partial<RecoveryArtifactPaths> = { sourceArtifactPath: candidatePath };

  const fail = (
    code: RecoveryRefusalCode,
    failedStep: RecoveryStep | null,
    message: string,
    rolledBack = false,
    /**
     * Whether the journal may be dropped. False whenever we are not certain the
     * live database is back where the app looks for it -- that is precisely the
     * state the next launch has to be told about.
     */
    keepJournal = false,
  ): RecoveryOutcome => {
    log('error', '[Recovery] Refused or failed', { candidateId, code, failedStep, rolledBack });
    if (!keepJournal) journal?.clear();
    emit?.({ type: 'recovery_failed', backend, code, failedStep, rolledBack });
    return { ok: false, candidateId, backend, code, failedStep, rolledBack, artifacts, message };
  };

  // --- 1. Re-resolve and re-check, immediately before acting -----------------
  if (eligibility) {
    const allowed = eligibility.allowedVerdicts ?? DEFAULT_ALLOWED;
    let assessment: CandidateAssessment;
    try {
      await beforeStep?.('reassess');
      assessment = await eligibility.reassess();
    } catch (err) {
      return fail('facts_changed', 'reassess', describe(err));
    }
    if (assessment.factsFingerprint !== eligibility.expectedFingerprint) {
      return fail(
        'facts_changed',
        'reassess',
        'The database or the artifact changed since it was assessed. Nothing was modified.',
      );
    }
    if (!allowed.includes(assessment.verdict)) {
      return fail(
        assessment.reasonCode === 'candidate_empty' ? 'candidate_empty' : 'not_eligible',
        'reassess',
        `Candidate is ${assessment.verdict} (${assessment.reasonCode}). Nothing was modified.`,
      );
    }
  }

  // --- 2. Announce and journal before the first destructive operation --------
  const timestamp = now().toISOString().replace(/[:.]/g, '-');
  const stagingPath = adapter.recoveryPathFor('recovery-staging', timestamp);
  const displacedPath = adapter.recoveryPathFor('displaced', timestamp);
  const snapshotPath = adapter.recoveryPathFor('pre-restore', timestamp);
  const liveExisted = await adapter.exists(adapter.livePath);

  emit?.({
    type: 'recovery_started',
    backend,
    candidateSizeBucket: context.candidateSizeBucket,
    liveSizeBucket: context.liveSizeBucket,
    reasonCode: context.reasonCode,
  });
  // Written down before anything moves, and naming every path this run will
  // use. A process killed after the displace rename leaves a journal saying so;
  // without one the next launch sees an absent database and creates an empty
  // one on top of a perfectly good `.displaced-*` copy (#1347).
  //
  // It also refuses to write over an unresolved journal from an earlier
  // attempt, which is why this is inside a try: that refusal has to become a
  // typed outcome rather than an exception thrown through every caller. The
  // journal is left exactly as it was, so `keepJournal` is true here.
  try {
    journal?.begin({
      operationId: args.operationId ?? `recovery-${timestamp}`,
      candidateId,
      backend,
      liveExisted,
      paths: {
        livePath: adapter.livePath,
        stagingPath,
        displacedPath,
        preRestoreSnapshotPath: null,
        sourceArtifactPath: candidatePath,
      },
    });
  } catch (err) {
    return fail('recovery_in_progress', null, describe(err), false, true);
  }
  log('info', '[Recovery] Starting', { candidateId, backend, reasonCode: context.reasonCode });

  // --- 3. Quiesce, with one retry, and abort if it cannot be confirmed -------
  try {
    await beforeStep?.('quiesce');
    await withRetry(() => adapter.quiesce(), QUIESCE_ATTEMPTS);
  } catch (err) {
    // Nothing has moved. A close we cannot confirm is never worked around:
    // renaming a directory a live process still holds open is how you get two
    // writers and one surviving copy.
    return fail('quiesce_failed', 'quiesce', describe(err));
  }

  // --- 4. Verified pre-restore snapshot of the live database -----------------
  if (liveExisted) {
    try {
      await beforeStep?.('snapshot');
      await adapter.snapshot(snapshotPath);
      const check = await adapter.verify(snapshotPath);
      if (!check.valid) {
        throw new Error(`snapshot did not verify: ${check.error ?? check.integrity}`);
      }
      artifacts.preRestoreSnapshotPath = snapshotPath;
      journal?.advance('snapshot_taken', { preRestoreSnapshotPath: snapshotPath });
      log('info', '[Recovery] Pre-restore snapshot verified', { snapshotPath });
    } catch (err) {
      await reopenQuietly(adapter, liveExisted, log);
      return fail('snapshot_failed', 'snapshot', describe(err));
    }
  }

  // --- 5. Stage the candidate beside the live database ----------------------
  try {
    await beforeStep?.('stage');
    await adapter.stage(candidatePath, stagingPath);
  } catch (err) {
    await discardStaging(adapter, stagingPath, candidatePath, log);
    await reopenQuietly(adapter, liveExisted, log);
    return fail('stage_failed', 'stage', describe(err));
  }

  // --- 6. Full off-thread validation of the staged target -------------------
  let staged: RecoveryVerification;
  try {
    await beforeStep?.('verify');
    staged = await adapter.verify(stagingPath);
  } catch (err) {
    await discardStaging(adapter, stagingPath, candidatePath, log);
    await reopenQuietly(adapter, liveExisted, log);
    return fail('verification_failed', 'verify', describe(err));
  }
  if (!staged.valid || !staged.requiredSchemaPresent || staged.integrity === 'failed') {
    await discardStaging(adapter, stagingPath, candidatePath, log);
    await reopenQuietly(adapter, liveExisted, log);
    return fail(
      'verification_failed',
      'verify',
      `Recovered copy did not verify (${staged.integrity}${staged.error ? `: ${staged.error}` : ''}).`,
    );
  }
  // Restoring an empty database over a live one is the exact conversion of
  // "recoverable" into "gone" that this whole plan exists to prevent, so it is
  // rejected here on its own merits and not only via the assessment.
  if (rowsOf(staged.indicators) === 0) {
    await discardStaging(adapter, stagingPath, candidatePath, log);
    await reopenQuietly(adapter, liveExisted, log);
    return fail('candidate_empty', 'verify', 'The recovered copy contains no sessions or history.');
  }
  // What we are about to make authoritative, recorded before we act on it.
  // A successful recovery used to log nothing between "Starting" and
  // "Succeeded", so when a recovery finished with fewer rows than the
  // candidate had, there was no way to tell whether the copy, the
  // verification, the swap or the reopen lost them.
  log('info', '[Recovery] Staged copy verified', {
    stagingPath,
    integrity: staged.integrity,
    indicators: staged.indicators,
  });
  journal?.advance('staged_verified');

  // --- 7. Atomic swap: displace the live database, promote the staged one ----
  if (liveExisted) {
    try {
      await beforeStep?.('swap-displace');
      await adapter.move(adapter.livePath, displacedPath);
      artifacts.displacedLivePath = displacedPath;
      journal?.advance('live_displaced');
    } catch (err) {
      await discardStaging(adapter, stagingPath, candidatePath, log);
      await reopenQuietly(adapter, liveExisted, log);
      // The journal stays at `staged_verified`. `moveSqliteDatabase` undoes a
      // partial move, but a compensation that itself fails would leave the live
      // path empty with the displaced copy present, and only the journal lets
      // the next launch tell that apart from a fresh install.
      return fail('swap_failed', 'swap-displace', describe(err), false, true);
    }
  }
  try {
    await beforeStep?.('swap-promote');
    await adapter.move(stagingPath, adapter.livePath);
    journal?.advance('promoted');
  } catch (err) {
    // The window that used to lose everything. The displaced database is still
    // on disk under a name we recorded; put it straight back.
    const rolledBack = await rollback(adapter, displacedPath, liveExisted, log);
    await discardStaging(adapter, stagingPath, candidatePath, log);
    await reopenQuietly(adapter, liveExisted, log);
    // Only drop the journal if the live database is demonstrably back.
    return fail('swap_failed', 'swap-promote', describe(err), rolledBack, !rolledBack && liveExisted);
  }
  log('info', '[Recovery] Swap complete', { displacedPath, live: adapter.livePath });

  // --- 8. Reopen and verify the expected content through the proxy ----------
  try {
    await beforeStep?.('reopen');
    await adapter.reopen();
  } catch (err) {
    const rolledBack = await rollbackAfterOpen(adapter, displacedPath, liveExisted, timestamp, log);
    return fail('reopen_failed', 'reopen', describe(err), rolledBack, !rolledBack && liveExisted);
  }

  let indicators: ContentIndicators;
  try {
    await beforeStep?.('final-verify');
    indicators = await adapter.readLiveIndicators();
    if (rowsOf(indicators) === 0) {
      throw new Error('restored database reports no sessions, history or projects through the proxy');
    }
    // Against what staging verified, not against zero.
    //
    // `> 0` accepts any database with a single row in it, which is not the
    // claim this step exists to make. It was observed accepting one: a
    // recovery whose staged copy verified with a session, a history snapshot
    // and its rows intact reopened reporting a single session, and the
    // transaction reported success and cleared the journal. The user was told
    // their data was back while the copy that actually held it sat under a
    // `.displaced-*` name, which is the entire failure this module exists to
    // prevent, reached from inside it.
    //
    // Only a SHORTFALL fails. The app writes its own rows the moment it
    // reopens -- a session for the new window -- so the live count is
    // routinely higher than the staged one, and requiring equality would fail
    // every healthy recovery.
    const stagedRows = rowsOf(staged.indicators);
    if (rowsOf(indicators) < stagedRows) {
      throw new Error(
        `restored database holds fewer rows than the copy that was verified `
        + `(${rowsOf(indicators)} < ${stagedRows}); it did not come back intact`,
      );
    }
  } catch (err) {
    const rolledBack = await rollbackAfterOpen(adapter, displacedPath, liveExisted, timestamp, log);
    return fail(
      'final_verify_failed',
      'final-verify',
      describe(err),
      rolledBack,
      !rolledBack && liveExisted,
    );
  }

  journal?.advance('reopened_verified');
  journal?.clear();
  log('info', '[Recovery] Succeeded', { candidateId, indicators });
  emit?.({
    type: 'recovery_succeeded',
    backend,
    candidateSizeBucket: context.candidateSizeBucket,
  });
  return {
    ok: true,
    candidateId,
    backend,
    indicators,
    artifacts: {
      sourceArtifactPath: candidatePath,
      preRestoreSnapshotPath: artifacts.preRestoreSnapshotPath ?? null,
      displacedLivePath: liveExisted ? displacedPath : null,
    },
  };
}

// ---------------------------------------------------------------------------

async function withRetry(fn: () => Promise<void>, attempts: number): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Put the displaced database back where it was. Called with the live path
 * empty (the promote never landed).
 */
async function rollback(
  adapter: RecoveryBackendAdapter,
  displacedPath: string,
  liveExisted: boolean,
  log: RecoveryLogFn,
): Promise<boolean> {
  if (!liveExisted) return false;
  try {
    if (await adapter.exists(adapter.livePath)) {
      // Something is already there; do not overwrite it, leave both copies.
      log('warn', '[Recovery] Live path occupied during rollback; leaving both copies in place');
      return false;
    }
    await adapter.move(displacedPath, adapter.livePath);
    log('info', '[Recovery] Rolled back to the previous database', { from: displacedPath });
    return true;
  } catch (err) {
    log('error', '[Recovery] Rollback failed; both copies remain on disk', err);
    return false;
  }
}

/**
 * Roll back after the restored database is already in place: move it aside
 * under its own recovery name first, then restore the displaced one and
 * reopen. Nothing is deleted in either direction.
 *
 * The close is a hard gate, not a warning. This used to log the failure and
 * rename anyway, which is the plan's invariant 4 ("source close, rename, copy,
 * verification and state-commit failures are never suppressed") broken in the
 * most direct way available: renaming a database a live handle still holds
 * open gives you two writers and, on Windows, a rename that reports success
 * and a file that did not move. Refusing to roll back leaves a database the
 * app can read at the live path and every other copy on disk, which is a worse
 * outcome for the user and a much better one for their data.
 */
async function rollbackAfterOpen(
  adapter: RecoveryBackendAdapter,
  displacedPath: string,
  liveExisted: boolean,
  timestamp: string,
  log: RecoveryLogFn,
): Promise<boolean> {
  try {
    await withRetry(() => adapter.quiesce(), QUIESCE_ATTEMPTS);
  } catch (err) {
    log(
      'error',
      '[Recovery] Could not close the restored database; refusing to rename it. '
        + 'The restored database is at the live path and the previous one is preserved.',
      err,
    );
    return false;
  }
  try {
    if (await adapter.exists(adapter.livePath)) {
      await adapter.move(adapter.livePath, adapter.recoveryPathFor('recovery-abandoned', timestamp));
    }
  } catch (err) {
    log('error', '[Recovery] Could not move the restored database aside; not rolling back', err);
    return false;
  }
  const rolledBack = await rollback(adapter, displacedPath, liveExisted, log);
  // `liveExisted` matters here for the same reason it does in `rollback`: with
  // nothing at the live path, reopening CREATES an empty database on top of the
  // hole the failed swap left, which is the #1347 shape. Omitting it passed
  // `log` into the guard slot, where it was always truthy.
  await reopenQuietly(adapter, liveExisted, log);
  return rolledBack;
}

/**
 * Reopen after aborting -- but only when there is something at the live path to
 * reopen.
 *
 * Opening a database at a path where none exists CREATES one, empty. On a
 * failed swap whose rollback also failed, that fresh empty database lands
 * exactly on top of the hole the displaced copy came out of, and the next
 * launch finds a valid, empty, live database and no reason to think anything
 * is wrong. That is #1347's ending, reached from inside the code meant to
 * prevent it. When the live path is empty, leaving the engine closed is the
 * honest state: the caller gets a failed outcome saying so, and startup's
 * journal reconciliation puts the real database back.
 */
async function reopenQuietly(
  adapter: RecoveryBackendAdapter,
  liveExisted: boolean,
  log: RecoveryLogFn,
): Promise<void> {
  if (liveExisted && !(await adapter.exists(adapter.livePath))) {
    log(
      'error',
      '[Recovery] Not reopening: there is no database at the live path and opening one would '
        + 'create an empty database over the displaced copy. Every copy is still on disk and the '
        + 'recovery journal names them.',
      { livePath: adapter.livePath },
    );
    return;
  }
  try {
    await adapter.reopen();
  } catch (err) {
    log('error', '[Recovery] Could not reopen the database after aborting recovery', err);
  }
}

/**
 * Remove the staging copy -- and only ever the staging copy, and only once the
 * artifact it was made from is confirmed to still be on disk. If the source
 * has gone, the partial copy is suddenly the only thing left and is kept.
 */
async function discardStaging(
  adapter: RecoveryBackendAdapter,
  stagingPath: string,
  candidatePath: string,
  log: RecoveryLogFn,
): Promise<void> {
  if (!(await assertCandidateStillPresent(candidatePath))) {
    log('warn', '[Recovery] Source artifact is gone; keeping the partial staging copy', {
      stagingPath,
      candidatePath,
    });
    return;
  }
  try {
    await adapter.discardScratch(stagingPath);
  } catch (err) {
    log('warn', '[Recovery] Could not remove the staging copy', err);
  }
}

/**
 * How much user data a database holds, for the "is this empty?" gate.
 *
 * Projects count. They were gathered and then dropped on the floor here, which
 * meant an install whose data is projects -- a user who joined a team and has
 * shared projects but has not started an AI session or edited a document --
 * was classified as an empty candidate and refused recovery. Including them can
 * only ever turn a refusal into a restore; a database with no sessions, no
 * history and no projects is still zero.
 */
function rowsOf(indicators: ContentIndicators): number {
  return (
    (indicators.sessionCount ?? 0)
    + (indicators.documentHistoryCount ?? 0)
    + (indicators.projectCount ?? 0)
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

