// @vitest-environment node
/**
 * Rollout authorization for the forced PGLite -> SQLite migration.
 *
 * The claim under test is narrow and total: **nothing authorizes a migration
 * except a live, valid, current-channel, allowlisted, unexpired, enabled
 * payload.** Every other input -- and every absence of input -- fails closed.
 *
 * That is one table, not seven files. The failure modes differ only in which
 * field is wrong, and enumerating them in a table is what makes it obvious
 * when a future change adds an eighth without a row.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ACCEPTED_CONFIG_VERSIONS,
  CLOCK_SKEW_TOLERANCE_MS,
  FIRST_COHORT_MAX_SOURCE_BYTES,
  MAX_AUTHORIZATION_TTL_MS,
  MAX_REMOTE_SOURCE_BYTES,
  ROLLOUT_FLAG_KEYS,
  assessCohort,
  evaluateRolloutAuthorization,
  resolveRolloutAuthorization,
  type RolloutConfigSource,
  type RolloutSnapshot,
} from '../rolloutAuthorization';

const ACCEPTED = ['sqlite-ramp-1'] as const;
const FETCHED_AT = '2026-09-02T00:00:00.000Z';
const EXPIRES_AT = '2026-09-03T00:00:00.000Z';
const FETCHED_MS = Date.parse(FETCHED_AT);
const EXPIRES_MS = Date.parse(EXPIRES_AT);
/** Halfway through the window: unambiguously live. */
const DURING_MS = FETCHED_MS + (EXPIRES_MS - FETCHED_MS) / 2;

function payload(overrides: Partial<RolloutSnapshot> = {}): Record<string, unknown> {
  return {
    enabled: true,
    maxSourceBytes: FIRST_COHORT_MAX_SOURCE_BYTES,
    releaseChannel: 'alpha',
    configVersion: 'sqlite-ramp-1',
    fetchedAt: FETCHED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

describe('evaluateRolloutAuthorization', () => {
  it('authorizes a live, valid, current-channel, allowlisted payload', () => {
    // The one green row. Without it the table below could pass because
    // evaluation returns "no" unconditionally, which is a gate that cannot fail.
    const result = evaluateRolloutAuthorization({
      raw: payload(),
      nowMs: DURING_MS,
      buildChannel: 'alpha',
      acceptedConfigVersions: ACCEPTED,
    });

    expect(result).toEqual({
      authorized: true,
      snapshot: {
        enabled: true,
        maxSourceBytes: 268435456, // 256 MiB
        releaseChannel: 'alpha',
        configVersion: 'sqlite-ramp-1',
        fetchedAt: FETCHED_AT,
        expiresAt: EXPIRES_AT,
      },
    });
  });

  const failsClosed: Array<{
    name: string;
    raw: unknown;
    nowMs?: number;
    buildChannel?: 'alpha' | 'stable';
    reason: string;
  }> = [
    // --- No answer at all. Offline, opted out, client down, request timed out.
    { name: 'nothing delivered', raw: null, reason: 'authorization_unavailable' },
    { name: 'undefined delivered', raw: undefined, reason: 'authorization_unavailable' },

    // --- The operator turned it off. This is the kill switch firing.
    {
      name: 'remotely disabled',
      raw: payload({ enabled: false }),
      reason: 'rollout_disabled',
    },

    // --- Malformed. Each row is one field the payload got wrong; a partially
    //     good payload must never partially apply.
    { name: 'not an object', raw: 'enabled', reason: 'authorization_invalid' },
    { name: 'an array', raw: [payload()], reason: 'authorization_invalid' },
    {
      name: 'enabled is a string',
      raw: payload({ enabled: 'true' as unknown as boolean }),
      reason: 'authorization_invalid',
    },
    {
      name: 'maxSourceBytes is a float',
      raw: payload({ maxSourceBytes: 268435456.5 }),
      reason: 'authorization_invalid',
    },
    {
      name: 'maxSourceBytes is negative',
      raw: payload({ maxSourceBytes: -1 }),
      reason: 'authorization_invalid',
    },
    {
      name: 'maxSourceBytes is beyond a safe integer',
      raw: payload({ maxSourceBytes: Number.MAX_SAFE_INTEGER + 2 }),
      reason: 'authorization_invalid',
    },
    {
      // The measured tail. ~32 telemetry-visible installs cannot validate a 1%
      // failure rate -- its gate cannot fail -- so it must not be reachable by
      // editing a remote value. Enabling it requires shipping a build.
      name: 'maxSourceBytes above the build ceiling',
      raw: payload({ maxSourceBytes: MAX_REMOTE_SOURCE_BYTES + 1 }),
      reason: 'authorization_invalid',
    },
    {
      name: 'configVersion is empty',
      raw: payload({ configVersion: '' }),
      reason: 'authorization_invalid',
    },
    {
      name: 'fetchedAt is not a date',
      raw: payload({ fetchedAt: 'yesterday' }),
      reason: 'authorization_invalid',
    },
    {
      name: 'the window ends before it starts',
      raw: payload({ expiresAt: '2026-09-01T00:00:00.000Z' }),
      reason: 'authorization_invalid',
    },
    {
      // A payload that grants itself a month is a cached boolean with a
      // timestamp on it, which is the thing this module removes.
      name: 'the window is longer than the maximum TTL',
      raw: payload({
        expiresAt: new Date(FETCHED_MS + MAX_AUTHORIZATION_TTL_MS + 1).toISOString(),
      }),
      reason: 'authorization_invalid',
    },

    // --- Wrong channel, both directions. A cached alpha authorization is not
    //     valid in stable, and the payload says so even if transport did not.
    {
      name: 'an alpha payload on a stable build',
      raw: payload({ releaseChannel: 'alpha' }),
      buildChannel: 'stable',
      reason: 'channel_mismatch',
    },
    {
      name: 'a stable payload on an alpha build',
      raw: payload({ releaseChannel: 'stable' }),
      buildChannel: 'alpha',
      reason: 'channel_mismatch',
    },
    {
      name: 'a channel this build has never heard of',
      raw: payload({ releaseChannel: 'canary' as unknown as 'alpha' }),
      reason: 'authorization_invalid',
    },

    // --- A version this build was not reviewed for.
    {
      name: 'a configVersion outside the build allowlist',
      raw: payload({ configVersion: 'sqlite-ramp-9' }),
      reason: 'unsupported_config_version',
    },

    // --- Expiry and clock skew. The boundaries are the interesting part.
    {
      name: 'expired an hour ago',
      raw: payload(),
      nowMs: EXPIRES_MS + 60 * 60 * 1000,
      reason: 'authorization_expired',
    },
    {
      name: 'exactly at the expiry instant',
      raw: payload(),
      nowMs: EXPIRES_MS,
      reason: 'authorization_expired',
    },
    {
      name: 'the clock sits further behind fetchedAt than the skew tolerance',
      raw: payload(),
      nowMs: FETCHED_MS - CLOCK_SKEW_TOLERANCE_MS - 1,
      reason: 'authorization_expired',
    },
  ];

  it.each(failsClosed)('fails closed: $name', ({ raw, nowMs, buildChannel, reason }) => {
    const result = evaluateRolloutAuthorization({
      raw,
      nowMs: nowMs ?? DURING_MS,
      buildChannel: buildChannel ?? 'alpha',
      acceptedConfigVersions: ACCEPTED,
    });

    expect(result.authorized).toBe(false);
    expect(result.authorized === false && result.reason).toBe(reason);
  });

  it('still authorizes at the boundaries that are meant to be inside the window', () => {
    // The mirror of the two skew rows above. Without these, tightening the
    // comparison to reject everything would leave the table green.
    const atStart = evaluateRolloutAuthorization({
      raw: payload(),
      nowMs: FETCHED_MS,
      buildChannel: 'alpha',
      acceptedConfigVersions: ACCEPTED,
    });
    const oneMsBeforeExpiry = evaluateRolloutAuthorization({
      raw: payload(),
      nowMs: EXPIRES_MS - 1,
      buildChannel: 'alpha',
      acceptedConfigVersions: ACCEPTED,
    });
    const withinSkewTolerance = evaluateRolloutAuthorization({
      raw: payload(),
      nowMs: FETCHED_MS - CLOCK_SKEW_TOLERANCE_MS + 1,
      buildChannel: 'alpha',
      acceptedConfigVersions: ACCEPTED,
    });

    expect(atStart.authorized).toBe(true);
    expect(oneMsBeforeExpiry.authorized).toBe(true);
    expect(withinSkewTolerance.authorized).toBe(true);
  });

  it('does not report a configVersion it has not matched against the allowlist', () => {
    // A remote-controlled string must not become an event property. The only
    // rejections carrying a version are the ones that got past the allowlist.
    const unknownVersion = evaluateRolloutAuthorization({
      raw: payload({ configVersion: 'attacker-supplied-'.repeat(20) }),
      nowMs: DURING_MS,
      buildChannel: 'alpha',
      acceptedConfigVersions: ACCEPTED,
    });
    const disabled = evaluateRolloutAuthorization({
      raw: payload({ enabled: false }),
      nowMs: DURING_MS,
      buildChannel: 'alpha',
      acceptedConfigVersions: ACCEPTED,
    });

    expect(unknownVersion.authorized === false && unknownVersion.configVersion).toBeUndefined();
    expect(disabled.authorized === false && disabled.configVersion).toBe('sqlite-ramp-1');
  });
});

describe('shipped defaults', () => {
  it('accepts no configuration version, so no remote payload can start a migration', () => {
    // Automatic migration is off in Phase B, and this is what makes it off by
    // construction rather than by a remote value someone could flip. Adding a
    // version here is the ramp; it must be a deliberate, reviewed commit.
    expect(ACCEPTED_CONFIG_VERSIONS).toEqual([]);

    expect(
      evaluateRolloutAuthorization({
        raw: payload(),
        nowMs: DURING_MS,
        buildChannel: 'alpha',
      }),
    ).toEqual({ authorized: false, reason: 'unsupported_config_version' });
  });

  it('reads a different flag key per channel', () => {
    // Two switches, not one widened targeting rule. Enabling stable must be a
    // deliberate act against a differently-named flag.
    expect(ROLLOUT_FLAG_KEYS.alpha).not.toBe(ROLLOUT_FLAG_KEYS.stable);
  });
});

describe('assessCohort', () => {
  const snapshot: RolloutSnapshot = {
    enabled: true,
    maxSourceBytes: FIRST_COHORT_MAX_SOURCE_BYTES,
    releaseChannel: 'alpha',
    configVersion: 'sqlite-ramp-1',
    fetchedAt: FETCHED_AT,
    expiresAt: EXPIRES_AT,
  };

  it('admits a source at or below the ceiling and excludes one above it', () => {
    expect(assessCohort(FIRST_COHORT_MAX_SOURCE_BYTES, snapshot)).toEqual({ withinCohort: true });
    expect(assessCohort(FIRST_COHORT_MAX_SOURCE_BYTES + 1, snapshot)).toEqual({
      withinCohort: false,
      reason: 'source_above_ceiling',
    });
  });

  it('treats an unmeasurable source as outside the cohort, not as small', () => {
    expect(assessCohort(Number.NaN, snapshot).withinCohort).toBe(false);
  });
});

describe('resolveRolloutAuthorization', () => {
  function source(overrides: Partial<RolloutConfigSource> = {}): RolloutConfigSource {
    return {
      isAvailable: () => true,
      fetchPayload: async () => payload(),
      ...overrides,
    };
  }

  it('never asks when the configuration channel is unavailable', async () => {
    // The opted-out install. A remote disable has no path to this machine, so
    // it is kept out of automatic migration rather than migrated under an
    // authorization nobody can revoke.
    const fetchPayload = vi.fn();
    const result = await resolveRolloutAuthorization({
      source: source({ isAvailable: () => false, fetchPayload }),
      buildChannel: 'alpha',
      now: () => DURING_MS,
      acceptedConfigVersions: ACCEPTED,
    });

    expect(result).toEqual({ authorized: false, reason: 'authorization_unavailable' });
    expect(fetchPayload).not.toHaveBeenCalled();
  });

  it('fails closed when the fetch rejects', async () => {
    const result = await resolveRolloutAuthorization({
      source: source({
        fetchPayload: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
      buildChannel: 'alpha',
      now: () => DURING_MS,
      acceptedConfigVersions: ACCEPTED,
    });

    expect(result).toEqual({ authorized: false, reason: 'authorization_unavailable' });
  });

  it('fails closed rather than hanging the boot when the fetch never settles', async () => {
    const result = await resolveRolloutAuthorization({
      source: source({ fetchPayload: () => new Promise(() => {}) }),
      buildChannel: 'alpha',
      now: () => DURING_MS,
      timeoutMs: 5,
      acceptedConfigVersions: ACCEPTED,
    });

    expect(result).toEqual({ authorized: false, reason: 'authorization_unavailable' });
  });

  it('asks for the key belonging to the running channel', async () => {
    const fetchPayload = vi.fn(async () => payload({ releaseChannel: 'stable' }));
    await resolveRolloutAuthorization({
      source: source({ fetchPayload }),
      buildChannel: 'stable',
      now: () => DURING_MS,
      acceptedConfigVersions: ACCEPTED,
    });

    expect(fetchPayload).toHaveBeenCalledWith(ROLLOUT_FLAG_KEYS.stable);
  });

  it('caches only a snapshot that validated', async () => {
    // A rejected payload written to the cache would re-create the stale-yes
    // artifact this module exists to remove.
    const onSnapshot = vi.fn();
    await resolveRolloutAuthorization({
      source: source({ fetchPayload: async () => payload({ enabled: false }) }),
      buildChannel: 'alpha',
      now: () => DURING_MS,
      acceptedConfigVersions: ACCEPTED,
      onSnapshot,
    });
    expect(onSnapshot).not.toHaveBeenCalled();

    await resolveRolloutAuthorization({
      source: source(),
      buildChannel: 'alpha',
      now: () => DURING_MS,
      acceptedConfigVersions: ACCEPTED,
      onSnapshot,
    });
    expect(onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ configVersion: 'sqlite-ramp-1' }));
  });
});
