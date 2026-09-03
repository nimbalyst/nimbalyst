/**
 * Typed domain results for the PGLite -> SQLite migration and adoption paths.
 *
 * The migration pipeline runs inside the SQLite worker, but analytics is a
 * main-process concern. Before this module the worker held `sendEvent`
 * callbacks that took a free-form event name and an arbitrary property bag,
 * and three separate layers each shaped their own overlapping completion and
 * failure events. That is how the same migration ended up describable three
 * different ways, and how an exact byte count could reach PostHog by accident.
 *
 * So the worker returns a *result*, not an event: a closed union with a fixed
 * reason vocabulary and pre-bucketed sizes. `migrationEventMapper.ts` on main
 * is the only thing that turns one of these into an analytics event, and it
 * emits at most one terminal event per `operationId`.
 *
 * Exact bytes and counts still exist -- they belong in the local log and in
 * the sentence shown to the user, both of which stay on the machine.
 */

import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Bounded fact vocabulary. Everything that reaches analytics is one of these.
// ---------------------------------------------------------------------------

/** Binary-unit ceilings, matching the ramp cohorts in the migration plan. */
export type SizeBucket =
  | 'none'
  | 'lt_32mib'
  | 'lt_256mib'
  | 'lt_1gib'
  | 'lt_3gib'
  | 'lt_8gib'
  | 'gte_8gib';

export type CountBucket = 'unknown' | 'zero' | '1_9' | '10_99' | '100_999' | '1000_plus';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export function sizeBucket(bytes: number): SizeBucket {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'none';
  if (bytes < 32 * MIB) return 'lt_32mib';
  if (bytes < 256 * MIB) return 'lt_256mib';
  if (bytes < GIB) return 'lt_1gib';
  if (bytes < 3 * GIB) return 'lt_3gib';
  if (bytes < 8 * GIB) return 'lt_8gib';
  return 'gte_8gib';
}

export function countBucket(count: number | null | undefined): CountBucket {
  if (count === null || count === undefined || !Number.isFinite(count)) return 'unknown';
  if (count <= 0) return 'zero';
  if (count < 10) return '1_9';
  if (count < 100) return '10_99';
  if (count < 1000) return '100_999';
  return '1000_plus';
}

// ---------------------------------------------------------------------------
// Refusal
// ---------------------------------------------------------------------------

/**
 * Why automatic migration will not proceed. Deliberately small and closed:
 * every value here is something the product can explain to a user and act on,
 * and adding a case means deciding what the user does about it.
 */
export type MigrationRefusalReason =
  | 'backup_dwarfs_live'
  | 'projects_without_sessions'
  | 'source_unreadable'
  | 'source_missing'
  | 'insufficient_disk';

/** Bucketed facts. This is the entire payload analytics is allowed to see. */
export interface MigrationRefusalFacts {
  liveBytes: SizeBucket;
  largestBackupBytes: SizeBucket;
  configuredProjects: CountBucket;
  sourceSessions: CountBucket;
  /** Only present for `insufficient_disk`. */
  freeDiskBytes?: SizeBucket;
}

export interface MigrationRefusal {
  reasonCode: MigrationRefusalReason;
  facts: MigrationRefusalFacts;
  /**
   * Stable digest of `reasonCode` + `facts`. Two launches that measure the
   * same install the same way produce the same fingerprint, which is what
   * lets a durable block distinguish "nothing has changed, stay blocked" from
   * "the situation moved, ask again".
   */
  factsFingerprint: string;
  /**
   * Human-readable sentence for the UI and the local log. Carries exact sizes
   * and counts, and therefore never reaches analytics.
   */
  reason: string;
}

/**
 * Bump when the assessment logic changes shape -- a new reason, a changed
 * threshold, a new fact. An install blocked by an older version is re-assessed
 * rather than left sitting behind a verdict this build would not have reached.
 */
export const MIGRATION_ASSESSMENT_VERSION = 1;

export function migrationFactsFingerprint(
  reasonCode: MigrationRefusalReason,
  facts: MigrationRefusalFacts,
): string {
  const canonical = [
    reasonCode,
    facts.liveBytes,
    facts.largestBackupBytes,
    facts.configuredProjects,
    facts.sourceSessions,
    facts.freeDiskBytes ?? '-',
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Error code carried across the worker boundary so main can tell a refusal
 * ("we looked and decided not to") from a failure ("we tried and it broke").
 * The distinction is load-bearing: only the second consumes a retry attempt.
 */
export const MIGRATION_REFUSED_CODE = 'MIGRATION_REFUSED';

export class MigrationRefusedError extends Error {
  readonly name = 'MigrationRefusedError';
  readonly code = MIGRATION_REFUSED_CODE;
  /**
   * Rides the `data` field of the worker's serialized error, so the structured
   * refusal survives the postMessage hop intact instead of being reduced to a
   * message string main would have to parse.
   */
  readonly data: MigrationRefusal;

  constructor(refusal: MigrationRefusal) {
    super(refusal.reason);
    this.data = refusal;
  }
}

/** The refusal carried by `err`, or null if this is an ordinary failure. */
export function asMigrationRefusal(err: unknown): MigrationRefusal | null {
  if (!err || typeof err !== 'object') return null;
  const candidate = err as { code?: string; data?: unknown };
  if (candidate.code !== MIGRATION_REFUSED_CODE) return null;
  const data = candidate.data as MigrationRefusal | undefined;
  if (!data || typeof data.reasonCode !== 'string' || typeof data.factsFingerprint !== 'string') {
    return null;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type MigrationOperation = 'migrate' | 'adopt';
/** Boot-time forced migration versus the Settings button. */
export type MigrationTrigger = 'auto' | 'manual';

export interface MigrationOutcomeBase {
  /**
   * Generated by the main-process caller and passed down, so the mapper can
   * recognise a repeat of the same operation no matter which layer reports it.
   */
  operationId: string;
  operation: MigrationOperation;
  trigger: MigrationTrigger;
  /** Auto back-off bookkeeping; absent for `trigger: 'manual'`. */
  attempt?: number;
  gaveUp?: boolean;
}

export interface MigrationCompletedOutcome extends MigrationOutcomeBase {
  kind: 'completed';
  rowCount: number;
  tableCount: number;
  durationMs: number;
  spotCheckCount: number;
  foreignKeyViolations: number;
  integrityCheck: string;
  /** Measured; the mapper buckets it before it leaves the machine. */
  sourceBytes: number;
}

export interface MigrationRefusedOutcome extends MigrationOutcomeBase {
  kind: 'refused';
  refusal: MigrationRefusal;
}

export interface MigrationFailedOutcome extends MigrationOutcomeBase {
  kind: 'failed';
  phase?: string;
  errorCategory?: string;
  errorCode?: string;
  sqlState?: string;
}

export type MigrationOutcome =
  | MigrationCompletedOutcome
  | MigrationRefusedOutcome
  | MigrationFailedOutcome;

/** Worker -> main event name carrying a `MigrationOutcome`. */
export const MIGRATION_OUTCOME_EVENT = 'db:migration:outcome';

/** Identity and provenance of one migration or adoption run. */
export interface MigrationOperationContext {
  operationId: string;
  trigger: MigrationTrigger;
  attempt?: number;
  gaveUp?: boolean;
}

type WithoutBase<T> = Omit<T, keyof MigrationOutcomeBase>;

/** The part of an outcome the pipeline knows; identity is stamped on below. */
export type MigrationOutcomeBody =
  | WithoutBase<MigrationCompletedOutcome>
  | WithoutBase<MigrationRefusedOutcome>
  | WithoutBase<MigrationFailedOutcome>;

/**
 * Stamp identity onto a result body. Shared by the orchestrator and the
 * adopter so the two cutover paths cannot drift into describing themselves
 * differently, which is how they ended up with four event shapes between them.
 */
export function buildMigrationOutcome(
  operation: MigrationOperation,
  context: MigrationOperationContext | undefined,
  body: MigrationOutcomeBody,
): MigrationOutcome {
  return {
    operationId: context?.operationId ?? `${operation}-${Date.now()}`,
    operation,
    trigger: context?.trigger ?? 'manual',
    ...(context?.attempt !== undefined ? { attempt: context.attempt } : {}),
    ...(context?.gaveUp !== undefined ? { gaveUp: context.gaveUp } : {}),
    ...body,
  } as MigrationOutcome;
}
