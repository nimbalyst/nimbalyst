// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { resolveIndexSortTimestamp } from '../sessionSortTimestamp';

/**
 * Regression lock for the mobile session-list ordering invariant (NIM-2167).
 *
 * `ai_sessions.updated_at` is bumped per message, and the 10s incremental sync
 * re-pushes any session whose local `updatedAt` drifted ahead of the server's.
 * iOS sorts directly off `Session.updatedAt` with no turn-boundary indirection
 * and no throttle, so an advancing sort key mid-turn makes the list visibly
 * reshuffle while sessions stream.
 *
 * Desktop avoids this via `getLiveSessionOrderTimestamp` (SessionHistory.tsx),
 * which prefers a turn-boundary timestamp in agent mode. This helper gives the
 * mobile index the same property: while a session is executing, its sort
 * timestamp is held at the last server-known value. Turn boundaries still move
 * it, via `pushExecutionStateToMobile` (SessionStateHandlers.ts).
 *
 * See the regression history this protects: 3d613ecfc -> 3d78447dd -> fa17c7cf5.
 */
describe('resolveIndexSortTimestamp', () => {
  it('uses the local timestamp when the session is idle', () => {
    expect(
      resolveIndexSortTimestamp({
        localUpdatedAt: 5000,
        cachedUpdatedAt: 1000,
        isExecuting: false,
      }),
    ).toBe(5000);
  });

  it('holds the last server-known timestamp while the session is executing', () => {
    expect(
      resolveIndexSortTimestamp({
        localUpdatedAt: 5000,
        cachedUpdatedAt: 1000,
        isExecuting: true,
      }),
    ).toBe(1000);
  });

  it('does not reshuffle across a burst of per-message bumps mid-turn', () => {
    // Simulates the 10s diff observing an advancing local updated_at while a
    // turn streams. Every push must carry the same sort key, or iOS animates a
    // re-sort each time.
    const perMessageBumps = [5000, 5200, 5400, 5900, 6100];
    const emitted = perMessageBumps.map((localUpdatedAt) =>
      resolveIndexSortTimestamp({ localUpdatedAt, cachedUpdatedAt: 1000, isExecuting: true }),
    );
    expect(new Set(emitted).size).toBe(1);
    expect(emitted[0]).toBe(1000);
  });

  it('stays held across repeated sync passes when the result is fed back as the cache', () => {
    // CollabV3Sync writes the emitted value back into sessionIndexCache, so the
    // next pass reads it as cachedUpdatedAt. If the cache were seeded from the
    // local row instead, the hold would leak and the row would drift upward on
    // every 10s pass -- the exact bug this guards.
    let cachedUpdatedAt: number | undefined = 1000;
    const emitted: number[] = [];
    for (const localUpdatedAt of [5000, 5200, 5400, 5900, 6100]) {
      const next = resolveIndexSortTimestamp({ localUpdatedAt, cachedUpdatedAt, isExecuting: true });
      emitted.push(next);
      cachedUpdatedAt = next;
    }
    expect(emitted).toEqual([1000, 1000, 1000, 1000, 1000]);
  });

  it('seeds from the local timestamp when the server has never seen the session', () => {
    // First push of a brand-new session that started executing immediately:
    // there is no cached value to hold, so it must still sort sensibly.
    expect(
      resolveIndexSortTimestamp({
        localUpdatedAt: 5000,
        cachedUpdatedAt: undefined,
        isExecuting: true,
      }),
    ).toBe(5000);
  });

  it('releases to the local timestamp once the turn ends', () => {
    // pushExecutionStateToMobile fires isExecuting:false at the turn boundary
    // with a fresh updatedAt; the diff must then converge on the local value.
    expect(
      resolveIndexSortTimestamp({
        localUpdatedAt: 6100,
        cachedUpdatedAt: 1000,
        isExecuting: false,
      }),
    ).toBe(6100);
  });

  it('never moves the sort key backwards while executing', () => {
    // If the server is somehow ahead (another device pushed a turn boundary),
    // holding the cached value must not rewind the row below its current place.
    expect(
      resolveIndexSortTimestamp({
        localUpdatedAt: 900,
        cachedUpdatedAt: 4000,
        isExecuting: true,
      }),
    ).toBe(4000);
  });
});
