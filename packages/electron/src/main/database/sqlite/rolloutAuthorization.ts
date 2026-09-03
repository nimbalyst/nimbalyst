/**
 * Rollout authorization for the forced PGLite -> SQLite migration.
 *
 * This module answers one question: *is this launch, on this build, permitted
 * to start a destructive migration right now?* It replaces the indefinitely
 * cached boolean that used to live in `migrationFlag.ts`.
 *
 * The boolean was not a kill switch. It was written to disk the first time it
 * resolved and read from disk forever after, so an install that had once seen
 * `true` would keep migrating no matter what the remote value became. Turning
 * the flag off stopped *new* exposures and nothing else. For an operation that
 * renames the user's only copy of their data, "we asked once, months ago" is
 * not authorization.
 *
 * ## The rules, and why each one exists
 *
 * 1. **The cache never authorizes.** `resolveRolloutAuthorization` requires a
 *    live answer on the launch that would migrate. The cached snapshot exists
 *    for Settings and for diagnostics; nothing reads it to decide. An offline
 *    launch is `authorization_unavailable`, not "whatever we last heard".
 *    This is the entire kill switch: the operator disables the flag, and the
 *    next launch of every online install stops. Installs that cannot reach us
 *    stop too, because absence of an answer is never a yes.
 *
 * 2. **Parse atomically or not at all.** `parseRolloutSnapshot` returns a whole
 *    snapshot or `null`. There is no path that half-applies a payload -- a
 *    payload with a good `enabled` and a garbage `maxSourceBytes` authorizes
 *    nothing.
 *
 * 3. **The build bounds the remote, not the other way round.**
 *    `maxSourceBytes` above `MAX_REMOTE_SOURCE_BYTES` is rejected as invalid,
 *    and `configVersion` must appear in this build's `ACCEPTED_CONFIG_VERSIONS`.
 *    A remote payload can only ever narrow what the build already allows.
 *
 *    That second bound is load-bearing for a specific reason. The ramp gates
 *    (`nimbalyst-local/plans/sqlite-ramp-gates.md`) show that the above-3-GiB
 *    tail is roughly 32 telemetry-visible installs, where the smallest failure
 *    rate detectable at 95% confidence is about 8.94%. That cohort *cannot*
 *    validate the 1% bound the rollout is gated on -- its gate cannot fail.
 *    So the tail must not be reachable by editing a remote value. Capping
 *    `maxSourceBytes` at 3 GiB means enabling the measured tail requires
 *    shipping a build, which is a reviewable act with a changelog and a
 *    version number, rather than a text field in a dashboard.
 *
 * 4. **Channel separation is transport-level *and* payload-level.** Alpha and
 *    stable read different flag keys (`ROLLOUT_FLAG_KEYS`), and the payload
 *    additionally declares its own channel, which must match the running
 *    build. See `ROLLOUT_FLAG_KEYS` for why both.
 *
 * The decision is a pure function of delivered bytes plus a clock, so every
 * failure mode above is testable without a network, a PostHog project, or a
 * real install. Only `resolveRolloutAuthorization` touches the world.
 */

import type { ReleaseChannel } from '../../utils/store';
import { sizeBucket, type SizeBucket } from './migrationOutcome';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * Per-channel flag keys.
 *
 * Separate keys rather than one channel-aware flag. This was an open question
 * in the plan and it is settled here so the transport contract does not have
 * to be invented during a ramp:
 *
 *   - Two keys are two switches. Enabling stable is a deliberate act against a
 *     differently-named flag, not a widened targeting rule on the flag that is
 *     already on for alpha. The failure mode we are guarding against is an
 *     operator broadening a cohort and reaching stable by accident.
 *   - A single flag with per-variant payloads would depend on PostHog
 *     evaluating a `release_channel` person property correctly at flag time.
 *     A misconfigured cohort rule would then be indistinguishable from a
 *     correct one until stable installs started migrating.
 *   - The payload's own `releaseChannel` is checked anyway, so the two
 *     mechanisms are independent. Transport separation prevents the misroute;
 *     payload validation catches the case transport cannot see -- a user who
 *     switches their build channel in Settings, where a snapshot fetched
 *     moments ago under the old channel is now wrong-channel and fails closed.
 *
 * The cost is that a ramp is two flag edits instead of one. That is the point.
 */
export const ROLLOUT_FLAG_KEYS: Readonly<Record<ReleaseChannel, string>> = {
  alpha: 'sqlite-rollout-alpha',
  stable: 'sqlite-rollout-stable',
};

/**
 * Configuration versions this build will honour.
 *
 * **Empty on purpose.** Phase B ships the authorization mechanism with
 * automatic migration still off, and an empty allowlist means no remote
 * payload of any shape can start a migration -- not a disabled flag that
 * someone might enable, but a build that structurally cannot act on one.
 *
 * At ramp time, add the exact version string the rollout owner has published
 * (for example `sqlite-ramp-1`) in the same commit that updates the ceiling
 * and the changelog. The ramp gates require a new version for every material
 * change to the ceiling or channel policy, so a payload can never silently
 * reuse a version whose meaning has moved.
 */
export const ACCEPTED_CONFIG_VERSIONS: readonly string[] = [];

/**
 * The largest `maxSourceBytes` any remote payload may request. See rule 3
 * above: 3 GiB is the last cohort the ramp gates can actually measure, and
 * the tail beyond it needs a build, not a dashboard edit.
 */
export const MAX_REMOTE_SOURCE_BYTES = 3 * GIB;

/** The first cohort's ceiling: 256 MiB. Configuration is bytes; docs are MiB. */
export const FIRST_COHORT_MAX_SOURCE_BYTES = 256 * MIB;

/**
 * Longest window a delivered payload may claim. A payload that grants itself
 * a month of validity is a cached boolean wearing a timestamp, which is the
 * thing this module exists to remove.
 */
export const MAX_AUTHORIZATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How far the local clock may sit *behind* `fetchedAt` before we stop trusting
 * our own expiry arithmetic. Small on purpose: this is slack for ordinary
 * clock drift and for the round trip, not for a machine whose clock is wrong.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** Hard ceiling on the live fetch, so a hung request cannot stall the boot. */
export const AUTHORIZATION_FETCH_TIMEOUT_MS = 4000;

/** The validated rollout configuration. Every field is required. */
export interface RolloutSnapshot {
  enabled: boolean;
  /** Bytes. Documentation and UI use binary units; this is 268435456 = 256 MiB. */
  maxSourceBytes: number;
  releaseChannel: ReleaseChannel;
  configVersion: string;
  /** ISO-8601. */
  fetchedAt: string;
  /** ISO-8601, strictly after `fetchedAt`. */
  expiresAt: string;
}

/** Why authorization was withheld. Every value here fails closed. */
export type RolloutAuthorizationRefusal =
  | 'rollout_disabled'
  | 'authorization_unavailable'
  | 'authorization_expired'
  | 'authorization_invalid'
  | 'channel_mismatch'
  | 'unsupported_config_version';

export type RolloutAuthorization =
  | { authorized: true; snapshot: RolloutSnapshot }
  | {
      authorized: false;
      reason: RolloutAuthorizationRefusal;
      /**
       * The version the rejected payload claimed, when it claimed one we could
       * read. Bounded by `ACCEPTED_CONFIG_VERSIONS` before it is reported to
       * analytics -- an arbitrary remote string must not become an event
       * property.
       */
      configVersion?: string;
    };

/**
 * Every categorical reason a launch can decline to migrate, including the
 * local ones this module does not itself produce.
 *
 * Matches the vocabulary in `sqlite-ramp-gates.md`, plus two the gates document
 * did not enumerate but which the boot path can genuinely reach:
 * `attempts_exhausted` (three consecutive transient failures) and
 * `preflight_unavailable` (pre-flight could not complete, so no verdict about
 * the data was reached). Both were previously invisible.
 */
export type RolloutSkipReason =
  | 'none'
  | RolloutAuthorizationRefusal
  | 'source_above_ceiling'
  | 'source_missing'
  | 'source_unreadable'
  | 'durably_blocked'
  | 'insufficient_disk'
  | 'recovery_recommended'
  | 'rollback_selected'
  | 'migration_in_progress'
  | 'attempts_exhausted'
  | 'preflight_unavailable';

export type RolloutDecisionKind =
  | 'attempt_auto'
  | 'stay_pglite'
  | 'offer_consent'
  | 'offer_recovery';

/**
 * The exposure record for one eligible install on one configuration version.
 *
 * Every field is a bounded category. There are deliberately no byte values,
 * counts, durations, paths, operation ids, or free-form strings here: this is
 * emitted by every eligible install, so a single high-cardinality property
 * would be a fleet-wide identifier.
 */
export interface RolloutDecision {
  /** An accepted version, or `'none'` when no valid payload was in hand. */
  configVersion: string;
  evaluatedChannel: ReleaseChannel;
  sourceBytesBucket: SizeBucket;
  decision: RolloutDecisionKind;
  skipReason: RolloutSkipReason;
}

// ---------------------------------------------------------------------------
// Parsing and evaluation. Pure.
// ---------------------------------------------------------------------------

function isReleaseChannel(value: unknown): value is ReleaseChannel {
  return value === 'alpha' || value === 'stable';
}

/** Milliseconds for an ISO-8601 string, or `null` if it is not one. */
function isoToMillis(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A whole snapshot, or `null`.
 *
 * Structural only -- it does not look at the clock, the running channel, or
 * the accepted-version list, because those are the caller's facts and mixing
 * them in here is how a "parse" quietly becomes a policy decision.
 */
export function parseRolloutSnapshot(raw: unknown): RolloutSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;

  if (typeof candidate.enabled !== 'boolean') return null;
  if (typeof candidate.configVersion !== 'string' || candidate.configVersion.length === 0) {
    return null;
  }
  if (!isReleaseChannel(candidate.releaseChannel)) return null;

  const maxSourceBytes = candidate.maxSourceBytes;
  if (
    typeof maxSourceBytes !== 'number' ||
    !Number.isSafeInteger(maxSourceBytes) ||
    maxSourceBytes <= 0 ||
    maxSourceBytes > MAX_REMOTE_SOURCE_BYTES
  ) {
    return null;
  }

  const fetchedAt = isoToMillis(candidate.fetchedAt);
  const expiresAt = isoToMillis(candidate.expiresAt);
  if (fetchedAt === null || expiresAt === null) return null;
  // A window that ends before it starts, or one long enough to be a cached
  // boolean in disguise, is not a window.
  if (expiresAt <= fetchedAt) return null;
  if (expiresAt - fetchedAt > MAX_AUTHORIZATION_TTL_MS) return null;

  return {
    enabled: candidate.enabled,
    maxSourceBytes,
    releaseChannel: candidate.releaseChannel,
    configVersion: candidate.configVersion,
    fetchedAt: candidate.fetchedAt as string,
    expiresAt: candidate.expiresAt as string,
  };
}

export interface EvaluateRolloutInput {
  /** Exactly what the transport delivered. `null` when it delivered nothing. */
  raw: unknown;
  nowMs: number;
  /** The channel this build is actually running on. */
  buildChannel: ReleaseChannel;
  /** Injectable so tests can exercise the authorized path against an empty ship default. */
  acceptedConfigVersions?: readonly string[];
}

/**
 * Turn delivered bytes into an authorization.
 *
 * Check order, and why:
 *   1. Nothing delivered -> `authorization_unavailable`. Offline, opted out,
 *      client not up, request timed out; they are the same operational fact.
 *   2. Unparseable -> `authorization_invalid`.
 *   3. Wrong channel -> `channel_mismatch`. Ahead of the version check because
 *      a payload aimed at another channel says nothing about this one, whatever
 *      version it names.
 *   4. Unknown version -> `unsupported_config_version`.
 *   5. `enabled: false` -> `rollout_disabled`. Ahead of expiry deliberately:
 *      an operator's explicit disable is the most actionable label, and a
 *      disabled payload authorizes nothing either way.
 *   6. Stale or unusable clock -> `authorization_expired`.
 */
export function evaluateRolloutAuthorization(input: EvaluateRolloutInput): RolloutAuthorization {
  const accepted = input.acceptedConfigVersions ?? ACCEPTED_CONFIG_VERSIONS;

  if (input.raw === null || input.raw === undefined) {
    return { authorized: false, reason: 'authorization_unavailable' };
  }

  const snapshot = parseRolloutSnapshot(input.raw);
  if (!snapshot) {
    return { authorized: false, reason: 'authorization_invalid' };
  }

  if (snapshot.releaseChannel !== input.buildChannel) {
    return { authorized: false, reason: 'channel_mismatch' };
  }

  if (!accepted.includes(snapshot.configVersion)) {
    // No `configVersion` on the result: the string is remote-controlled and
    // has not been matched against the allowlist, so it must not reach an
    // event property.
    return { authorized: false, reason: 'unsupported_config_version' };
  }

  if (!snapshot.enabled) {
    return { authorized: false, reason: 'rollout_disabled', configVersion: snapshot.configVersion };
  }

  const fetchedAt = Date.parse(snapshot.fetchedAt);
  const expiresAt = Date.parse(snapshot.expiresAt);

  // The local clock sits meaningfully before the payload was minted. Either
  // the clock is wrong or the payload is, and in both cases the expiry
  // comparison below means nothing -- so we have no established freshness.
  if (input.nowMs < fetchedAt - CLOCK_SKEW_TOLERANCE_MS) {
    return { authorized: false, reason: 'authorization_expired', configVersion: snapshot.configVersion };
  }

  // Strict: an authorization is dead at the instant it expires.
  if (input.nowMs >= expiresAt) {
    return { authorized: false, reason: 'authorization_expired', configVersion: snapshot.configVersion };
  }

  return { authorized: true, snapshot };
}

// ---------------------------------------------------------------------------
// Cohort gating
// ---------------------------------------------------------------------------

export type CohortVerdict =
  | { withinCohort: true }
  | { withinCohort: false; reason: 'source_above_ceiling' };

/**
 * Is this install's source inside the authorized cohort?
 *
 * An install above the ceiling is not blocked, deferred, or walled -- it boots
 * normally on PGLite and may be offered a consented migration elsewhere.
 * Consent does not bypass plausibility, integrity, disk space, quiescence, or
 * the cutover journal; it only substitutes for the cohort ceiling.
 */
export function assessCohort(sourceBytes: number, snapshot: RolloutSnapshot): CohortVerdict {
  if (!Number.isFinite(sourceBytes) || sourceBytes < 0) {
    // Unmeasurable size is not "small". The refusal path names it precisely.
    return { withinCohort: false, reason: 'source_above_ceiling' };
  }
  return sourceBytes <= snapshot.maxSourceBytes
    ? { withinCohort: true }
    : { withinCohort: false, reason: 'source_above_ceiling' };
}

/** `sizeBucket`, re-exported at the seam so callers need one import. */
export { sizeBucket };

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * How a rollout payload reaches this machine.
 *
 * Abstracted so the decision logic never learns what PostHog is, and so the
 * consent question below has exactly one place to be answered.
 */
export interface RolloutConfigSource {
  /**
   * Deliver the payload for `flagKey`, or `null` when it cannot be obtained
   * for any reason. Must never throw and must never block indefinitely.
   */
  fetchPayload(flagKey: string): Promise<unknown | null>;
  /**
   * Can this source deliver anything at all right now?
   *
   * **This is where analytics consent is decided.** See
   * `postHogRolloutConfigSource` in `migrationFlag.ts` for the answer and the
   * reasoning; the short version is that an install with analytics off has no
   * channel by which a remote disable could reach it, so it is permanently
   * ineligible for *automatic* migration rather than being migrated under an
   * authorization nobody can revoke.
   */
  isAvailable(): boolean;
}

export interface ResolveRolloutInput {
  source: RolloutConfigSource;
  buildChannel: ReleaseChannel;
  now?: () => number;
  timeoutMs?: number;
  acceptedConfigVersions?: readonly string[];
  /** Called with a validated snapshot so callers can cache it for Settings. */
  onSnapshot?: (snapshot: RolloutSnapshot) => void;
  log?: (level: 'info' | 'warn', msg: string, meta?: unknown) => void;
}

/**
 * Resolve authorization for *this* launch.
 *
 * Always a live question. There is no cache fallback and no "last known good"
 * path, because a destructive operation authorized by a stale yes is exactly
 * the failure this module was written to remove.
 */
export async function resolveRolloutAuthorization(
  input: ResolveRolloutInput,
): Promise<RolloutAuthorization> {
  const log = input.log ?? (() => {});
  const now = input.now ?? Date.now;
  const timeoutMs = input.timeoutMs ?? AUTHORIZATION_FETCH_TIMEOUT_MS;

  if (!input.source.isAvailable()) {
    log('info', '[rollout] no configuration channel available; automatic migration not authorized');
    return { authorized: false, reason: 'authorization_unavailable' };
  }

  const flagKey = ROLLOUT_FLAG_KEYS[input.buildChannel];
  let raw: unknown = null;
  try {
    raw = await withTimeout(input.source.fetchPayload(flagKey), timeoutMs);
  } catch (err) {
    log('warn', '[rollout] configuration fetch failed; failing closed', err);
    return { authorized: false, reason: 'authorization_unavailable' };
  }

  const authorization = evaluateRolloutAuthorization({
    raw,
    nowMs: now(),
    buildChannel: input.buildChannel,
    acceptedConfigVersions: input.acceptedConfigVersions,
  });

  // Cache only what validated. A snapshot that failed evaluation is not worth
  // showing anyone, and writing it would re-create the stale-yes artifact.
  if (authorization.authorized) input.onSnapshot?.(authorization.snapshot);

  return authorization;
}

/** Reject after `ms`, so a hung request cannot hold the boot path open. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
