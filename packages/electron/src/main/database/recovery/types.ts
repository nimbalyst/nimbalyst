/**
 * Types for selected-artifact database recovery.
 *
 * This is the whole public vocabulary: what a recovery candidate is, what we
 * are willing to say about it, and what a recovery attempt can return. It is
 * the surface Settings and the failure dialog consume — nothing here carries a
 * free-form prose string into a decision or into analytics.
 *
 * Every verdict, reason and refusal is a closed union. `.claude/rules/
 * destructive-data-paths.md` asks for the decision to be a pure function over
 * facts; a categorical vocabulary is what makes that decision testable and what
 * keeps unbounded strings out of telemetry.
 */

export type ActiveBackend = 'pglite' | 'sqlite';

/**
 * Coarse size classes. Buckets rather than bytes because these travel to
 * analytics; exact byte counts stay in local logs and in `DatabaseFacts`.
 */
export type SizeBucket =
  | 'empty'
  | 'under-32mb'
  | 'under-256mb'
  | 'under-1gb'
  | 'under-3gb'
  | 'over-3gb';

/** Below this, size ratios are noise: an empty PGLite store is already a few MB. */
export const SIZE_SIGNIFICANCE_FLOOR_BYTES = 32 * 1024 * 1024;

export function sizeBucketFor(bytes: number): SizeBucket {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'empty';
  if (bytes < SIZE_SIGNIFICANCE_FLOOR_BYTES) return 'under-32mb';
  if (bytes < 256 * 1024 * 1024) return 'under-256mb';
  if (bytes < 1024 * 1024 * 1024) return 'under-1gb';
  if (bytes < 3 * 1024 * 1024 * 1024) return 'under-3gb';
  return 'over-3gb';
}

export type IntegrityCode =
  /** A full check ran and passed. */
  | 'ok'
  /** A full check ran and found damage. */
  | 'failed'
  /** The database could not be opened or checked at all. */
  | 'unreadable'
  /** No integrity primitive exists for this backend (PGLite has no `integrity_check`). */
  | 'not-applicable'
  /** Nothing was checked, because there was nothing there. */
  | 'not-checked';

export type DatabasePathKind =
  | 'pglite-directory'
  | 'sqlite-file'
  | 'missing'
  | 'unrecognized';

/**
 * Stable content indicators. `null` means "could not be read", which is never
 * the same thing as zero — conflating those is how an unreadable source got
 * treated as an empty one in #1347.
 */
export interface ContentIndicators {
  sessionCount: number | null;
  documentHistoryCount: number | null;
  projectCount: number | null;
}

export interface DatabaseFacts {
  pathKind: DatabasePathKind;
  sizeBytes: number;
  sizeBucket: SizeBucket;
  /** `null` when the database could not be opened to look. */
  requiredSchemaPresent: boolean | null;
  integrity: IntegrityCode;
  indicators: ContentIndicators;
}

export type AssessmentVerdict =
  | 'not_actionable'
  | 'needs_review'
  | 'recovery_recommended'
  | 'assessment_blocked';

export type AssessmentReasonCode =
  // not_actionable
  | 'candidate_missing'
  | 'already_resolved'
  | 'candidate_empty'
  | 'candidate_invalid'
  | 'candidate_not_materially_richer'
  // assessment_blocked
  | 'candidate_unreadable'
  | 'live_unreadable'
  // needs_review
  | 'both_databases_have_content'
  | 'live_empty_but_install_looks_new'
  // recovery_recommended
  | 'live_empty_on_established_install';

export interface CandidateAssessmentFacts {
  activeBackend: ActiveBackend;
  live: DatabaseFacts;
  candidate: DatabaseFacts;
  /**
   * Projects this install has settings for, read from electron-store. The only
   * signal in here that comes from outside either database — which is exactly
   * why it is the one that authorizes a recommendation. See
   * `migrationSourcePlausibility.ts` for the same reasoning.
   */
  configuredProjectCount: number;
  /**
   * Rows in `ai_agent_messages` in the LIVE database, or `null` when it could
   * not be read.
   *
   * Only the live side, and deliberately asymmetric with `live.indicators`.
   * "Is there anything worth restoring?" and "did this install lose the user's
   * work?" are different questions and the same count cannot answer both.
   *
   * `ai_sessions` cannot answer the second one: the app writes a session row
   * when a window opens, so an install that came up on an empty database has a
   * session in it before the user has done anything. Requiring `ai_sessions`
   * to be zero made `recovery_recommended` reachable only in a window that
   * closes before the user can see it -- observed directly in
   * `e2e/core/database-recovery.spec.ts`, where the live store the app created
   * over the hole reports one session, no history and no projects.
   *
   * Messages do answer it. A row here means somebody talked to an agent.
   * `null` is never read as zero: an unreadable count falls back to counting
   * sessions, which is the stricter answer.
   */
  liveAgentMessageCount: number | null;
  /** The user has already restored, kept, or dismissed this artifact. */
  alreadyResolved: boolean;
}

export interface CandidateAssessment {
  verdict: AssessmentVerdict;
  reasonCode: AssessmentReasonCode;
  /**
   * Only ever true for `recovery_recommended`. Everything else is visible in
   * Settings without the product asserting that anything was lost.
   */
  mayOfferProactively: boolean;
  activeBackend: ActiveBackend;
  candidateSizeBucket: SizeBucket;
  liveSizeBucket: SizeBucket;
  /**
   * Digest of the facts this verdict was computed from. Recovery re-gathers
   * facts immediately before acting and refuses if this changed.
   */
  factsFingerprint: string;
}

/** A discovered artifact, addressed by identifier rather than by path. */
export interface RecoveryCandidate {
  /** Opaque, allowlisted identifier. The only thing a caller may pass back in. */
  id: string;
  /** Bare directory name at the userData root, for display. */
  name: string;
  /** Absolute path, for a reveal-in-finder action only. */
  path: string;
  sizeBytes: number;
  sizeBucket: SizeBucket;
  /** Parsed from the artifact name when it carries a timestamp. */
  createdAt: string | null;
  assessment: CandidateAssessment;
}

/**
 * Ordered steps of the recovery transaction. Doubles as the fault-injection
 * vocabulary: `swap-displace` and `swap-promote` are separate entries because
 * the interesting failure is the gap between the two renames.
 */
export type RecoveryStep =
  | 'reassess'
  | 'quiesce'
  | 'snapshot'
  | 'stage'
  | 'verify'
  | 'swap-displace'
  | 'swap-promote'
  | 'reopen'
  | 'final-verify';

export type RecoveryRefusalCode =
  | 'unknown_candidate'
  | 'not_eligible'
  | 'facts_changed'
  /**
   * An earlier recovery left a journal behind and startup has not resolved it.
   * Overwriting that journal would erase the only record of where the earlier
   * attempt put the user's database, so this refuses before anything moves.
   */
  | 'recovery_in_progress'
  | 'quiesce_failed'
  | 'snapshot_failed'
  | 'stage_failed'
  | 'verification_failed'
  | 'candidate_empty'
  | 'swap_failed'
  | 'reopen_failed'
  | 'final_verify_failed';

/**
 * Every copy of a database this transaction left on disk. None of these is
 * ever deleted by a timer; the user resolves them explicitly.
 */
export interface RecoveryArtifactPaths {
  /** The artifact that was recovered from. Never modified. */
  sourceArtifactPath: string;
  /** Verified copy of the live database taken before anything was touched. */
  preRestoreSnapshotPath: string | null;
  /** The database that used to be live, moved aside by the swap. */
  displacedLivePath: string | null;
}

export type RecoveryOutcome =
  | {
      ok: true;
      candidateId: string;
      backend: ActiveBackend;
      artifacts: RecoveryArtifactPaths;
      /** Read back through the production proxy after reopening. */
      indicators: ContentIndicators;
    }
  | {
      ok: false;
      candidateId: string;
      backend: ActiveBackend;
      code: RecoveryRefusalCode;
      /** `null` when the refusal happened before any step ran. */
      failedStep: RecoveryStep | null;
      /** True when the swap had happened and was undone. */
      rolledBack: boolean;
      artifacts: Partial<RecoveryArtifactPaths>;
      /** For the local log and the dialog. Never a telemetry field. */
      message: string;
    };

/**
 * Typed domain results. The main process maps these to analytics exactly once;
 * nothing below main invents an event name. `recovery_started` is emitted
 * before the first destructive operation, so a process that dies mid-recovery
 * has still reported that it began — the gap that made nine months of #1347
 * invisible.
 */
export type RecoveryDomainEvent =
  | {
      type: 'recovery_started';
      backend: ActiveBackend;
      candidateSizeBucket: SizeBucket;
      liveSizeBucket: SizeBucket;
      /** `null` on the rolling-backup restore path, which has no assessment. */
      reasonCode: AssessmentReasonCode | null;
    }
  | {
      type: 'recovery_succeeded';
      backend: ActiveBackend;
      candidateSizeBucket: SizeBucket;
    }
  | {
      type: 'recovery_failed';
      backend: ActiveBackend;
      code: RecoveryRefusalCode;
      failedStep: RecoveryStep | null;
      rolledBack: boolean;
    };

export type RecoveryLogFn = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  meta?: unknown,
) => void;

/** Result of validating a staged recovery target. */
export interface RecoveryVerification {
  valid: boolean;
  integrity: IntegrityCode;
  requiredSchemaPresent: boolean;
  indicators: ContentIndicators;
  error?: string;
}
