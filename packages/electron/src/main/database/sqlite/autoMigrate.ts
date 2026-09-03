/**
 * Boot-time forced migration from PGLite to SQLite.
 *
 * This is a second caller of the existing migration pipeline, not a new one.
 * `MigrationOrchestrator` does all the work; this module owns only the
 * question "should we run it on this launch, and what happens if it fails".
 *
 * The governing constraint is that a blocked boot is worse than a slow one.
 * Every path out of here that isn't a successful cutover must leave the caller
 * able to open PGLite and carry on. The orchestrator already guarantees the
 * source store is untouched on every pre-cutover failure; this module must not
 * add a way to lose that.
 *
 * Three outcomes are distinct and must stay distinct:
 *   - `failed`   — the machinery broke. Counts against the three attempts.
 *   - `blocked`  — we looked at the data and refused. Durable, visible, and
 *                  does NOT count against the attempts. See
 *                  `MigrationBlockedState` in `BackendSelector.ts` for the
 *                  precedence rules.
 *   - `skipped`  — we never got as far as looking.
 *
 * Every launch that reaches this function is an *eligible* install by the
 * ramp-gate definition, so every launch produces exactly one categorical
 * `RolloutDecision` — including the ones that decline. Decisions that vanish
 * instead of being recorded are how a cohort's denominator quietly stops
 * matching its numerator, and a rate computed against a denominator that has
 * been silently pruned is worse than no rate at all.
 */

import { randomUUID } from 'crypto';

import {
  blockedStateFromRefusal,
  clearMigrationBlocked,
  commitMigrationToSqlite,
  hasEmittedRolloutDecision,
  hasExhaustedAutoMigration,
  isMigrationStillBlocked,
  readBackendState,
  recordAutoMigrationFailure,
  recordMigrationBlocked,
  recordRolloutDecisionEmitted,
  updateBackendState,
  MAX_AUTO_MIGRATION_ATTEMPTS,
  type ResolvedBackend,
} from './BackendSelector';
import { asCutoverAbort } from './cutoverMachine';
import type { PreflightResult } from './MigrationOrchestrator';
import type { MigrationSummary } from './PGLiteToSQLiteMigrator';
import {
  asMigrationRefusal,
  sizeBucket,
  type MigrationOutcome,
  type MigrationRefusal,
  type MigrationRefusalReason,
} from './migrationOutcome';
import {
  assessCohort,
  type RolloutAuthorization,
  type RolloutDecision,
  type RolloutDecisionKind,
  type RolloutSkipReason,
} from './rolloutAuthorization';
import type { ReleaseChannel } from '../../utils/store';
import { classifyDatabaseError } from '../DatabaseErrorTelemetry';

/** The slice of `MigrationOrchestrator` this module depends on. */
export interface OrchestratorLike {
  preflight(): Promise<PreflightResult>;
  run(context: AutoMigrationRunContext): Promise<MigrationSummary>;
}

/**
 * Bookkeeping the worker echoes back into the terminal domain result, so the
 * event mapper can report which attempt this was without a second channel.
 */
export interface AutoMigrationRunContext {
  operationId: string;
  trigger: 'auto';
  attempt: number;
  gaveUp: boolean;
}

export type AutoMigrateSkipReason =
  | 'not-due'
  | 'unauthorized'
  | 'source-above-ceiling'
  | 'backed-off'
  | 'preflight-failed';

export type AutoMigrateOutcome =
  | {
      action: 'skipped';
      reason: AutoMigrateSkipReason;
      detail?: string;
      /** Absent only for `not-due`, which is not an eligible install. */
      decision?: RolloutDecision;
    }
  | {
      action: 'blocked';
      reasonCode: MigrationRefusalReason;
      refusal: MigrationRefusal;
      decision: RolloutDecision;
    }
  | { action: 'migrated'; summary: MigrationSummary; decision: RolloutDecision }
  | {
      action: 'failed';
      errorCode: string;
      decision: RolloutDecision;
      /**
       * The cutover got as far as closing PGLite. The caller has no database
       * left to serve from, so "carry on with the old backend" is not one of
       * its options -- see `abortRequiresRelaunch`.
       */
      requiresRelaunch: boolean;
    };

export interface AutoMigrateInput {
  userDataPath: string;
  /** The already-computed resolution for this launch. */
  resolved: ResolvedBackend;
  /**
   * Resolve rollout authorization for *this* launch. Async and live by design:
   * a cached yes cannot authorize a destructive operation, so there is no
   * synchronous "last known value" to read. See `rolloutAuthorization.ts`.
   */
  authorize: () => Promise<RolloutAuthorization>;
  orchestrator: OrchestratorLike;
  /** Restart the app so the new backend is picked up. */
  relaunch: () => void;
  /**
   * Report the exposure decision. Production routes this to the main-owned
   * analytics mapper. Return `false` (or throw) when the event could not be
   * accepted for delivery: the local dedupe marker is written only on success,
   * so an undelivered decision is retried on a later launch instead of being
   * lost. Called at most once per install per `configVersion`.
   */
  onDecision?: (decision: RolloutDecision) => boolean | void;
  /** The channel this build runs on, stamped onto the decision. */
  buildChannel?: ReleaseChannel;
  /**
   * Report a terminal domain result. Production hands this to the main-owned
   * mapper (`migrationEventMapper.ts`); the successful and failed cases are
   * reported by the worker through the same mapper, so this is only used for
   * outcomes the worker never sees.
   */
  onOutcome?: (outcome: MigrationOutcome) => void;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: unknown) => void;
}

/**
 * Which categorical skip reason describes a refusal?
 *
 * Three refusal codes have a matching skip category and keep it; the other two
 * report `durably_blocked`. Nothing is lost by the collapse -- `migration_refused`
 * carries the precise `reason_code`, and the two events reconcile per install.
 */
function skipReasonForRefusal(code: MigrationRefusalReason): RolloutSkipReason {
  switch (code) {
    case 'source_missing':
    case 'source_unreadable':
    case 'insufficient_disk':
      return code;
    case 'backup_dwarfs_live':
    case 'projects_without_sessions':
      return 'durably_blocked';
  }
}

export async function maybeAutoMigrate(input: AutoMigrateInput): Promise<AutoMigrateOutcome> {
  const { userDataPath, resolved, orchestrator, relaunch } = input;
  const log = input.log ?? (() => {});
  const report = input.onOutcome ?? (() => {});
  const operationId = randomUUID();

  // Facts the exposure decision is stamped with, filled in as they are learned.
  // `configVersion` stays `'none'` until an authorization validates, so an
  // unvalidated remote string can never reach an event property.
  //
  // `'none'` is a real bucket for dedupe too: an install that never obtains an
  // authorization reports once and then goes quiet, and only starts reporting
  // again once a version it accepts arrives. Ongoing visibility for those
  // installs comes from the per-launch `database_backend_active` heartbeat,
  // not from re-reporting the same decision every launch.
  let configVersion = 'none';
  let sourceBytesBucket = sizeBucket(0);
  const evaluatedChannel: ReleaseChannel = input.buildChannel ?? 'stable';

  /**
   * Record the exposure decision exactly once per install per configuration
   * version. Every eligible install emits one, whatever it decides -- the
   * denominator is the point.
   *
   * The dedupe marker is written only when the consumer accepted the event.
   * Writing it first would turn a delivery failure into permanent silence for
   * that install, which reads downstream as a healthy cohort rather than a
   * missing one.
   */
  let emittedThisLaunch: RolloutDecision | null = null;
  const emitDecision = (
    decision: RolloutDecisionKind,
    skipReason: RolloutSkipReason,
  ): RolloutDecision => {
    // One decision per launch. A migration that starts and is then refused
    // mid-run has already reported `attempt_auto`; re-reporting it as
    // `stay_pglite` would be a second decision for the same exposure, which
    // the ramp gates treat as an observability failure. The refusal itself is
    // carried by `migration_refused`. Returning the record that was actually
    // transmitted keeps the caller's view and the event stream identical.
    if (emittedThisLaunch) return emittedThisLaunch;
    const record: RolloutDecision = {
      configVersion,
      evaluatedChannel,
      sourceBytesBucket,
      decision,
      skipReason,
    };
    emittedThisLaunch = record;
    log('info', `[autoMigrate] rollout decision: ${decision} (${skipReason})`, record);
    if (!input.onDecision) return record;
    // Already reported on an earlier launch under this same configuration
    // version. A new ceiling or channel policy ships a new version, which is a
    // new exposure and reports again.
    if (hasEmittedRolloutDecision(readBackendState(userDataPath), configVersion)) return record;
    try {
      if (input.onDecision(record) === false) return record;
      recordRolloutDecisionEmitted(userDataPath, configVersion);
    } catch (err) {
      log('warn', '[autoMigrate] exposure decision was not accepted; will retry next launch', err);
    }
    return record;
  };

  const skip = (
    reason: AutoMigrateSkipReason,
    skipReason: RolloutSkipReason,
    detail?: string,
    kind: RolloutDecisionKind = 'stay_pglite',
  ): AutoMigrateOutcome => {
    log('info', `[autoMigrate] skipping (${reason})`, detail);
    const decision = emitDecision(kind, skipReason);
    return detail
      ? { action: 'skipped', reason, detail, decision }
      : { action: 'skipped', reason, decision };
  };

  /**
   * Persist the verdict and stop. Never touches `migrationAttempts`: a refusal
   * is a conclusion about the data, and burning a transient retry on it would
   * retire the install after three launches with nothing to show for it.
   */
  const block = (refusal: MigrationRefusal, alreadyRecorded: boolean): AutoMigrateOutcome => {
    if (!alreadyRecorded) {
      recordMigrationBlocked(userDataPath, blockedStateFromRefusal(refusal));
      report({ kind: 'refused', operationId, operation: 'migrate', trigger: 'auto', refusal });
    }
    log('warn', `[autoMigrate] automatic migration blocked (${refusal.reasonCode})`, refusal.reason);
    const decision = emitDecision('stay_pglite', skipReasonForRefusal(refusal.reasonCode));
    return { action: 'blocked', reasonCode: refusal.reasonCode, refusal, decision };
  };

  // Not an eligible install: already on SQLite, or a rollback the user chose.
  // No decision is emitted, because counting it would put installs that are
  // not in the ramp into the ramp's denominator.
  if (!resolved.migrationDue) {
    log('info', '[autoMigrate] skipping (not-due)');
    return { action: 'skipped', reason: 'not-due' };
  }

  const state = resolved.state ?? readBackendState(userDataPath);

  // Back-off before authorization: an install that has already failed three
  // times should stop even if the rollout is on.
  if (hasExhaustedAutoMigration(state)) {
    return skip('backed-off', 'attempts_exhausted');
  }

  // The kill switch. A live answer or nothing -- see `rolloutAuthorization.ts`
  // for why a cached yes is not an answer.
  const authorization = await input.authorize();
  if (!authorization.authorized) {
    if (authorization.configVersion) configVersion = authorization.configVersion;
    return skip('unauthorized', authorization.reason);
  }
  configVersion = authorization.snapshot.configVersion;

  // Pre-flight is about the environment (disk space, a readable source), not
  // about the migration being broken, so a failure here deliberately does not
  // consume one of the three attempts -- freeing up disk should be enough to
  // let the next launch try again. It is also where this launch's facts are
  // measured, which is what decides whether an existing block still stands,
  // and where the source size the cohort ceiling is applied to comes from.
  let preflight: PreflightResult;
  try {
    preflight = await orchestrator.preflight();
  } catch (err) {
    log('warn', '[autoMigrate] pre-flight threw; booting on PGLite', err);
    return skip(
      'preflight-failed',
      'preflight_unavailable',
      err instanceof Error ? err.message : String(err),
    );
  }

  sourceBytesBucket = sizeBucket(preflight.pgliteDirBytes);

  // The cohort ceiling, checked before any verdict about the data.
  //
  // An install outside the active cohort is outside the ramp, so the ramp must
  // not record conclusions about it -- a durable `insufficient_disk` block on a
  // 2 GiB install that was never going to be migrated automatically is a
  // warning about a decision nobody made. It boots normally on PGLite and the
  // product may offer a consented migration, which substitutes for the ceiling
  // and for nothing else: plausibility, integrity, disk space, quiescence, and
  // the cutover journal all still apply on that path.
  const cohort = assessCohort(preflight.pgliteDirBytes, authorization.snapshot);
  if (!cohort.withinCohort) {
    return skip('source-above-ceiling', cohort.reason, undefined, 'offer_consent');
  }

  const priorBlock = state?.migrationBlocked ?? null;
  if (!preflight.ok) {
    if (!preflight.refusal) {
      // Pre-flight said no without a reason code. Treat it as an environment
      // problem rather than inventing a durable verdict from a bare string.
      log('warn', `[autoMigrate] pre-flight failed: ${preflight.reason}`);
      return skip('preflight-failed', 'preflight_unavailable', preflight.reason);
    }
    const unchanged = isMigrationStillBlocked(priorBlock, preflight.refusal.factsFingerprint);
    return block(preflight.refusal, unchanged);
  }

  // Pre-flight passed while a block was on file: the facts moved. Clear it so
  // the install is not held behind a verdict that no longer describes it.
  if (priorBlock) {
    log('info', '[autoMigrate] measured facts changed; clearing the migration block', {
      was: priorBlock.reasonCode,
    });
    clearMigrationBlocked(userDataPath);
  }

  log('info', '[autoMigrate] starting forced migration', {
    pgliteDirBytes: preflight.pgliteDirBytes,
  });

  // Emitted before the first destructive step, not after it. A decision that
  // only exists once the migration finished would make every crashed cutover
  // invisible -- the exposure and its terminal outcome have to be reconcilable
  // even when there is no terminal outcome.
  const decision = emitDecision('attempt_auto', 'none');

  const attempt = (state?.migrationAttempts?.count ?? 0) + 1;
  try {
    const summary = await orchestrator.run({
      operationId,
      trigger: 'auto',
      attempt,
      gaveUp: attempt >= MAX_AUTO_MIGRATION_ATTEMPTS,
    });
    // The orchestrator writes the flag itself on a successful cutover, but it
    // records `user-migration`. Re-stamp it so telemetry can tell a forced
    // migration from one somebody chose, and clear the attempt counter.
    const after = readBackendState(userDataPath);
    if (after?.backend === 'sqlite') {
      updateBackendState(userDataPath, {
        setBy: 'auto-migration',
        migrationAttempts: undefined,
      });
    } else {
      commitMigrationToSqlite(userDataPath, after?.pgliteMigratedDir ?? '', 'auto-migration');
    }

    log('info', '[autoMigrate] migration complete; relaunching');
    relaunch();
    return { action: 'migrated', summary, decision };
  } catch (err) {
    // A refusal raised mid-run (the facts moved between pre-flight and the
    // last check before cutover) is still a refusal, not a failed attempt.
    const refusal = asMigrationRefusal(err);
    if (refusal) {
      return block(refusal, isMigrationStillBlocked(priorBlock, refusal.factsFingerprint));
    }

    const classified = classifyDatabaseError(err);
    const attempts = recordAutoMigrationFailure(userDataPath, classified.errorCode);
    log('error', `[autoMigrate] migration failed (attempt ${attempts}); booting on PGLite`, err);
    // Backstop only. The worker reports the failure with its phase and wins the
    // dedupe race under the same `operationId`; this covers the case where the
    // worker died or never received the request, which would otherwise be the
    // one failure mode with no telemetry at all.
    report({
      kind: 'failed',
      operationId,
      operation: 'migrate',
      trigger: 'auto',
      attempt: attempts,
      gaveUp: attempts >= MAX_AUTO_MIGRATION_ATTEMPTS,
      ...classified,
    });
    return {
      action: 'failed',
      errorCode: classified.errorCode,
      decision,
      requiresRelaunch: asCutoverAbort(err)?.requiresRelaunch ?? false,
    };
  }
}
