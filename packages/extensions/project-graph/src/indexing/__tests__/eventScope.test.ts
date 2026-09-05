// @vitest-environment node

/**
 * Event time bounds and the preceding comparison period.
 *
 * The rule that matters: a comparison against "the previous week" is only
 * honest if both sides cover the same amount of elapsed time. Three days into
 * the current week, comparing against a full previous week reports a fake 60%
 * decline. So a partial current period is matched against the same elapsed
 * slice of the preceding one, and the result says it was matched.
 *
 * Metadata headers are never bounded by any of this — an old record that was
 * active last week must stay indexed, which is the predicate that hid it
 * before.
 */
import { describe, expect, it } from 'vitest';
import { resolveEventWindows, DAY_MS } from '../eventScope';
import { resolveOptions } from '../types';

const WEEK = 7 * DAY_MS;
const start = Date.UTC(2026, 8, 1);

describe('resolved event windows', () => {
  it('applies no event bound by default, and none when all history is asked for', () => {
    for (const options of [resolveOptions({}), resolveOptions({ eventScope: { mode: 'all' } })]) {
      const scope = resolveEventWindows(options, { nowMs: start });

      // The retention floor belongs to the CALLER, which computes its requested
      // history and passes it. A default horizon here would state a bound the
      // caller never set, and `coverage.window` reports that bound back to the
      // user as fact. `DEFAULT_EVENT_HORIZON_DAYS` stays exported for a caller
      // that wants that floor explicitly.
      expect(scope.mode).toBe('all');
      expect(scope.current).toBeNull();
      expect(scope.preceding).toBeNull();
      // Coverage must be able to say "all history" rather than inventing bounds.
      expect(scope.coverageWindow).toEqual({ startMs: null, endMs: null });
    }
  });

  it('honours a selected window older or wider than the retention default', () => {
    const older = { startMs: start - 400 * DAY_MS, endMs: start - 300 * DAY_MS };
    const scope = resolveEventWindows(
      resolveOptions({ eventScope: { mode: 'window', window: older } }),
      { nowMs: start },
    );

    // The default is a floor on what is retained, never a ceiling on what can
    // be asked for.
    expect(scope.current).toEqual(older);
  });

  it('derives the preceding window from the current one when only the current is configured', () => {
    const options = resolveOptions({
      eventScope: { mode: 'window', window: { startMs: start, endMs: start + WEEK } },
    });

    const scope = resolveEventWindows(options, { nowMs: start + WEEK });

    expect(scope.current).toEqual({ startMs: start, endMs: start + WEEK });
    expect(scope.preceding).toMatchObject({ startMs: start - WEEK - 1, endMs: start - 1 });
    expect(scope.coverageWindow).toEqual({ startMs: start, endMs: start + WEEK });
  });

  it('honours an explicitly supplied preceding window instead of deriving one', () => {
    const explicit = { startMs: start - 3 * WEEK, endMs: start - 2 * WEEK };
    const options = resolveOptions({
      eventScope: {
        mode: 'window',
        window: { startMs: start, endMs: start + WEEK },
        precedingWindow: explicit,
      },
    });

    const scope = resolveEventWindows(options, { nowMs: start + WEEK });

    expect(scope.preceding).toMatchObject(explicit);
    // A caller-supplied window is taken as given, so it cannot claim the
    // elapsed-matching guarantee the derived one carries.
    expect(scope.preceding?.partial).toBe(false);
  });

  it('falls back to all history when window mode is set without a window', () => {
    const scope = resolveEventWindows(resolveOptions({ eventScope: { mode: 'window' } }), { nowMs: start });

    // Under-specified. Stating "all history" is honest; inventing a range would
    // silently bound an answer the caller never scoped. The walk itself stays
    // bounded by `loadCommitFileEvidence`'s per-call commit cap.
    expect(scope.mode).toBe('all');
    expect(scope.current).toBeNull();
  });

  it('keeps the legacy historyHorizonMs working as a window ending now', () => {
    const options = resolveOptions({ historyHorizonMs: 30 * DAY_MS });

    const scope = resolveEventWindows(options, { nowMs: start });

    expect(scope.mode).toBe('window');
    expect(scope.current).toEqual({ startMs: start - 30 * DAY_MS, endMs: start });
  });
});


it('uses the same contiguous elapsed comparison as the visible shell', () => {
  const current = { startMs: start, endMs: start + WEEK };
  const options = resolveOptions({ eventScope: { mode: 'window', window: current } });
  const scope = resolveEventWindows(options, { nowMs: start + 3 * DAY_MS });
  expect(scope.preceding).toEqual({
    startMs: start - 3 * DAY_MS - 1, endMs: start - 1,
    partial: true, elapsedMs: 3 * DAY_MS + 1,
  });
});
