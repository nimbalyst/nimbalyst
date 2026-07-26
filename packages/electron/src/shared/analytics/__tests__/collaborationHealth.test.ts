import { describe, expect, it } from 'vitest';
import { CollaborationHealthAttemptTracker } from '../collaborationHealth';

/** Clock-driven tracker with the emit cooldown out of the way by default. */
function makeTracker(
  resourceType: 'team_index' | 'document' | 'tracker' | 'asset',
  encryptionMode: 'server_managed' | 'legacy_e2e' | 'unknown',
  clock: { now: number },
  minEmitIntervalMs = 0,
) {
  return new CollaborationHealthAttemptTracker(
    resourceType,
    encryptionMode,
    () => clock.now,
    minEmitIntervalMs,
  );
}

describe('CollaborationHealthAttemptTracker', () => {
  it('coalesces connecting and syncing into one successful attempt', () => {
    const clock = { now: 0 };
    const tracker = makeTracker('document', 'server_managed', clock);
    tracker.start('initial', true);
    expect(tracker.observe('connecting')).toBeNull();
    expect(tracker.observe('connecting')).toBeNull();
    clock.now = 1_500;
    expect(tracker.observe('syncing')).toBeNull();
    expect(tracker.observe('connected')).toEqual({
      surface: 'desktop',
      resourceType: 'document',
      connectionPath: 'initial',
      outcome: 'success',
      durationCategory: 'medium',
      retryCountBucket: '0',
      encryptionMode: 'server_managed',
      hadPendingOutbox: true,
    });
    expect(tracker.observe('connected')).toBeNull();
  });

  it('starts one reconnect attempt after a completed connection', () => {
    const clock = { now: 0 };
    const tracker = makeTracker('tracker', 'legacy_e2e', clock);
    tracker.start('initial');
    tracker.observe('connected');
    expect(tracker.observe('disconnected')).toBeNull();
    expect(tracker.observe('connecting')).toBeNull();
    expect(tracker.observe('connected')).toMatchObject({
      connectionPath: 'reconnect',
      outcome: 'success',
    });
  });

  it('emits bounded offline-ready and failed terminal outcomes', () => {
    const clock = { now: 0 };
    const offline = makeTracker('document', 'unknown', clock);
    offline.start('offline_open', true);
    expect(offline.observe('offline-unsynced')).toMatchObject({
      outcome: 'offline_ready',
      connectionPath: 'offline_open',
    });

    const failed = makeTracker('team_index', 'unknown', clock);
    failed.start('initial');
    expect(failed.observe('error', new Error('JWT expired'))).toMatchObject({
      outcome: 'failed',
      errorCategory: 'auth',
    });
  });

  it('ignores duplicate status notifications without inflating retries', () => {
    const clock = { now: 0 };
    const tracker = makeTracker('document', 'unknown', clock);
    tracker.start('initial');
    for (let i = 0; i < 10; i += 1) expect(tracker.observe('connecting')).toBeNull();
    for (let i = 0; i < 10; i += 1) expect(tracker.observe('syncing')).toBeNull();
    expect(tracker.observe('connected')).toMatchObject({ retryCountBucket: '0' });
  });

  it('counts a flapping connect/sync loop as retries on one attempt', () => {
    const clock = { now: 0 };
    const tracker = makeTracker('document', 'unknown', clock);
    tracker.start('initial');
    tracker.observe('connecting');
    // Three transient drops that each recover: one attempt, three retries.
    for (let i = 0; i < 3; i += 1) {
      expect(tracker.observe('syncing')).toBeNull();
      expect(tracker.observe('connecting')).toBeNull();
    }
    clock.now = 6_000;
    expect(tracker.observe('connected')).toMatchObject({
      outcome: 'success',
      connectionPath: 'initial',
      retryCountBucket: '2-3',
      durationCategory: 'slow',
    });
  });

  it('reports a recovered transient failure as one successful attempt', () => {
    const clock = { now: 0 };
    const tracker = makeTracker('tracker', 'unknown', clock);
    tracker.start('initial');
    tracker.observe('connecting');
    // A terminal error completes the attempt...
    expect(tracker.observe('error', new Error('socket hang up'))).toMatchObject({
      outcome: 'failed',
      errorCategory: 'network',
    });
    // ...and the recovery is a separate attempt, not a mutation of the first.
    clock.now = 500;
    expect(tracker.observe('connecting')).toBeNull();
    expect(tracker.observe('connected')).toMatchObject({
      outcome: 'success',
      connectionPath: 'initial',
    });
  });

  it('does not treat a post-connect offline drop as a new offline_ready open', () => {
    const clock = { now: 0 };
    const tracker = makeTracker('document', 'unknown', clock);
    tracker.start('initial');
    tracker.observe('connected');
    // offline_ready describes a cold local-first open, not losing the network
    // after a successful connection.
    expect(tracker.observe('offline-unsynced')).toBeNull();
  });

  describe('reconnect-storm cooldown', () => {
    it('suppresses repeat attempts inside the cooldown for every outcome', () => {
      const clock = { now: 0 };
      const tracker = makeTracker('document', 'unknown', clock, 60_000);

      tracker.start('initial');
      expect(tracker.observe('connected')).not.toBeNull();

      // A tight reconnect loop: the attempts still resolve, but only the first
      // is reported.
      for (let i = 0; i < 20; i += 1) {
        clock.now += 100;
        tracker.observe('connecting');
        expect(tracker.observe('connected')).toBeNull();
      }

      // Failures are suppressed by the same rule, so the failure rate computed
      // from the emitted sample is not biased by the cooldown.
      clock.now += 100;
      tracker.observe('connecting');
      expect(tracker.observe('error', new Error('socket hang up'))).toBeNull();

      // Past the cooldown, reporting resumes.
      clock.now += 60_000;
      tracker.observe('connecting');
      expect(tracker.observe('connected')).toMatchObject({ outcome: 'success' });
    });
  });
});
