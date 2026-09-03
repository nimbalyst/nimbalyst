/**
 * The one cutover both migration and adoption run.
 *
 * `MigrationOrchestrator` and `MigrationAdopter` differ entirely in how they
 * fill the SQLite target -- a full copy versus catching up a dry run. Once the
 * target is full they were doing the same five filesystem-and-flag steps, in
 * two hand-written copies that had already drifted: the orchestrator renamed
 * `pglite-db/` and swallowed the failure, the adopter swallowed it and then did
 * a second rename that could not be undone. Both then wrote the backend flag
 * regardless. That is safety invariant 4 (`source close, rename, copy,
 * verification, and state-commit failures are never suppressed`) violated in
 * two places at once, and it is why this module exists.
 *
 * Every transition is journaled before the next one starts, so a process that
 * dies anywhere in here leaves `cutoverReconciler.ts` enough to finish or roll
 * back deterministically. Nothing here suppresses a failure and nothing here
 * deletes anything.
 */

import {
  advanceCutoverPhase,
  clearCutoverJournal,
  fingerprintSource,
  phaseAtLeast,
  realCutoverFs,
  writeCutoverJournal,
  type CutoverFs,
  type CutoverJournal,
  type CutoverPhase,
} from './cutoverJournal';
import {
  commitMigrationToSqlite,
  commitRollbackToPglite,
  readBackendState,
  type DatabaseBackend,
} from './BackendSelector';

export interface CutoverRequest {
  userDataPath: string;
  operationId: string;
  operation: 'migrate' | 'adopt' | 'rollback';
  /**
   * Which backend the commit step names. Defaults to `sqlite`; a rollback
   * passes `pglite`. See `rollbackTransaction.ts` for why the reverse
   * direction is the same five steps.
   */
  commitBackend?: DatabaseBackend;
  /** Directory the engine being retired is live at. */
  sourceLiveDir: string;
  /** Where the source is moved to. Never deleted, by this or any other code. */
  sourcePreservedDir: string;
  /** Directory the app will open SQLite from. */
  targetLiveDir: string;
  /** Adoption only: the populated directory renamed into `targetLiveDir`. */
  targetStagingDir?: string;
  /** How the backend flag records this cutover. */
  commitSetBy?: 'user-migration' | 'auto-migration';
  /**
   * Prove the target is a complete, correct store. Runs while the source is
   * still live and authoritative, so throwing here costs nothing.
   */
  verifyTarget: () => Promise<void>;
  /**
   * Close the live PGLite worker. If this rejects the cutover stops here and
   * the source is never renamed -- a source we cannot prove is closed is a
   * source that may still be being written to.
   */
  quiesceSource: () => Promise<void>;
  /**
   * Optional last pass over the now-frozen source (the exact catch-up) plus
   * closing the target handle. Runs after the quiesce and before the rename.
   */
  finalizeTarget?: () => Promise<void>;
  /** Open the committed backend and read back what we expect. */
  reopenAndVerify?: () => Promise<void>;
  cutoverFs?: CutoverFs;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
}

export interface CutoverResult {
  preservedDir: string;
  targetDir: string;
}

/**
 * A cutover that stopped. The flags matter more than the message:
 *
 *   `targetCleanupSafe`  the caller may remove its SQLite target, because the
 *                        target never passed verification and so proves nothing.
 *                        False from `source_quiesced` onward: a verified target
 *                        is a complete copy of the user's data, and the failure
 *                        that stopped the cutover (a rename the OS refused, say)
 *                        is exactly the one likely to repeat, so throwing the
 *                        copy away costs the next attempt the whole migration.
 *   `sourcePreserved`    the source is no longer at its live path. The caller
 *                        must not carry on as though the database is open.
 *   `requiresRelaunch`   PGLite was closed. Whatever the caller does next, it
 *                        is not "keep serving the app from the old backend".
 */
export const CUTOVER_ABORTED_CODE = 'CUTOVER_ABORTED';

export interface CutoverAbortDetail {
  phase: CutoverPhase;
  targetCleanupSafe: boolean;
  sourcePreserved: boolean;
  requiresRelaunch: boolean;
}

export class CutoverAbortedError extends Error {
  readonly name = 'CutoverAbortedError';
  readonly code = CUTOVER_ABORTED_CODE;
  /**
   * Rides the `data` field the worker's error serializer copies, so the flags
   * survive the postMessage hop to main intact -- the same arrangement
   * `MigrationRefusedError` uses, and for the same reason: main has to act on
   * the distinction, not parse it back out of a message string.
   */
  readonly data: CutoverAbortDetail;
  readonly phase: CutoverPhase;
  readonly targetCleanupSafe: boolean;
  readonly sourcePreserved: boolean;
  readonly requiresRelaunch: boolean;

  constructor(phase: CutoverPhase, flags: Omit<CutoverAbortDetail, 'phase'>, cause: unknown) {
    super(`cutover aborted before ${phase}: ${(cause as Error)?.message ?? String(cause)}`);
    this.phase = phase;
    this.targetCleanupSafe = flags.targetCleanupSafe;
    this.sourcePreserved = flags.sourcePreserved;
    this.requiresRelaunch = flags.requiresRelaunch;
    this.data = { phase, ...flags };
  }
}

/** The abort detail carried by `err`, or null if this is an ordinary failure. */
export function asCutoverAbort(err: unknown): CutoverAbortDetail | null {
  if (!err || typeof err !== 'object') return null;
  const candidate = err as { code?: string; data?: unknown };
  if (candidate.code !== CUTOVER_ABORTED_CODE) return null;
  const data = candidate.data as CutoverAbortDetail | undefined;
  return data && typeof data.phase === 'string' ? data : null;
}

/**
 * Must the caller relaunch rather than carry on?
 *
 * True once PGLite has been closed, whatever happened afterwards. Callers used
 * to answer this from the journal phase alone, which meant a failure between
 * the close and the phase write read as "PGLite is still open" -- so this takes
 * both signals and needs only one of them. The abort flag is the primary one:
 * it comes from the same stack frame that did the closing.
 */
export function abortRequiresRelaunch(
  abort: CutoverAbortDetail | null,
  journalPhase: CutoverPhase | null,
): boolean {
  if (abort?.requiresRelaunch) return true;
  return journalPhase !== null && phaseAtLeast(journalPhase, 'source_quiesced');
}

export async function runCutover(req: CutoverRequest): Promise<CutoverResult> {
  const log = req.log ?? (() => {});
  const cutoverFs = req.cutoverFs ?? realCutoverFs;
  const { userDataPath } = req;

  const stateBefore = readBackendState(userDataPath);
  let journal: CutoverJournal = {
    version: 1,
    operationId: req.operationId,
    operation: req.operation,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: 'prepared',
    reconcileAttempts: 0,
    commitSetBy: req.commitSetBy ?? 'user-migration',
    commitBackend: req.commitBackend ?? 'sqlite',
    source: {
      livePath: req.sourceLiveDir,
      preservedPath: req.sourcePreservedDir,
      fingerprint: fingerprintSource(req.sourceLiveDir),
    },
    target: {
      livePath: req.targetLiveDir,
      ...(req.targetStagingDir ? { stagingPath: req.targetStagingDir } : {}),
    },
    rollback: {
      backendBefore: stateBefore?.backend ?? 'pglite',
      stateBefore: stateBefore ?? null,
    },
  };
  // Written before the first destructive step, not after it. #1347's recovery
  // event was computed at the end of a function that a mid-recovery death never
  // reached, so nine months of data loss reported nothing.
  writeCutoverJournal(userDataPath, journal);
  log('info', '[cutover] journal opened', {
    operationId: req.operationId,
    operation: req.operation,
    preservedPath: req.sourcePreservedDir,
  });

  // --- target_verified ------------------------------------------------------
  try {
    await req.verifyTarget();
  } catch (err) {
    // Nothing has moved and PGLite is still serving the app. Drop the journal
    // rather than making the next launch reconcile a cutover that never began.
    clearCutoverJournal(userDataPath);
    throw new CutoverAbortedError(
      'target_verified',
      { targetCleanupSafe: true, sourcePreserved: false, requiresRelaunch: false },
      err,
    );
  }
  journal = advanceCutoverPhase(userDataPath, journal, 'target_verified');

  // --- source_quiesced ------------------------------------------------------
  // The defect this replaces: both cutover paths renamed `pglite-db/` and
  // logged a warning if it failed. A source that will not close is a source
  // that may still be taking writes, and moving it is how those writes end up
  // in a directory nothing opens.
  try {
    await req.quiesceSource();
  } catch (err) {
    clearCutoverJournal(userDataPath);
    throw new CutoverAbortedError(
      'source_quiesced',
      { targetCleanupSafe: false, sourcePreserved: false, requiresRelaunch: false },
      err,
    );
  }
  // Recorded here, before the final catch-up, because the phase's meaning is
  // "PGLite is closed; the source directory is still in place" and that is
  // true the moment `quiesceSource` resolves. Writing it after `finalizeTarget`
  // instead left a catch-up failure looking, to every reader of the journal,
  // like a launch that still had PGLite open.
  journal = advanceCutoverPhase(userDataPath, journal, 'source_quiesced');

  try {
    await req.finalizeTarget?.();
  } catch (err) {
    // PGLite is closed but the source directory is untouched, so the next
    // launch opens it exactly as before. The journal stays: the reconciler
    // restores the flag and clears it.
    throw new CutoverAbortedError(
      'source_quiesced',
      { targetCleanupSafe: false, sourcePreserved: false, requiresRelaunch: true },
      err,
    );
  }

  // --- source_preserved -----------------------------------------------------
  try {
    cutoverFs.rename(req.sourceLiveDir, req.sourcePreservedDir);
  } catch (err) {
    // Windows holds directory handles open longer than POSIX does, so this is
    // an `EPERM`/`EBUSY` we expect to see in the field. The source is still
    // where it was and the flag still points at it; stopping here is correct
    // and is the whole difference from the behaviour this replaces.
    log('error', '[cutover] source preservation failed; backend flag NOT committed', {
      from: req.sourceLiveDir,
      to: req.sourcePreservedDir,
      err: (err as Error).message,
    });
    throw new CutoverAbortedError(
      'source_preserved',
      { targetCleanupSafe: false, sourcePreserved: false, requiresRelaunch: true },
      err,
    );
  }
  journal = advanceCutoverPhase(userDataPath, journal, 'source_preserved');

  // --- backend_committed ----------------------------------------------------
  try {
    if (req.targetStagingDir && !cutoverFs.exists(req.targetLiveDir)) {
      cutoverFs.rename(req.targetStagingDir, req.targetLiveDir);
    }
    if (journal.commitBackend === 'pglite') {
      // A rollback. `setBy: 'rollback'` is what stops a later launch offering
      // the user the migration they just undid.
      commitRollbackToPglite(userDataPath);
    } else {
      commitMigrationToSqlite(userDataPath, req.sourcePreservedDir, journal.commitSetBy);
    }
  } catch (err) {
    // The source is preserved and the target is verified. Rolling back from
    // here would mean a second rename that can fail the same way this one just
    // did, so we stop and let startup decide from the journal: it sees
    // `source_preserved` plus a verified target and finishes the commit.
    log('error', '[cutover] backend commit failed after source was preserved', {
      preservedPath: req.sourcePreservedDir,
      err: (err as Error).message,
    });
    throw new CutoverAbortedError(
      'backend_committed',
      { targetCleanupSafe: false, sourcePreserved: true, requiresRelaunch: true },
      err,
    );
  }
  journal = advanceCutoverPhase(userDataPath, journal, 'backend_committed');

  // --- reopened_verified ----------------------------------------------------
  try {
    await req.reopenAndVerify?.();
  } catch (err) {
    throw new CutoverAbortedError(
      'reopened_verified',
      { targetCleanupSafe: false, sourcePreserved: true, requiresRelaunch: true },
      err,
    );
  }
  advanceCutoverPhase(userDataPath, journal, 'reopened_verified');
  clearCutoverJournal(userDataPath);

  return { preservedDir: req.sourcePreservedDir, targetDir: req.targetLiveDir };
}
