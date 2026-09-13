// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  decideDailyActive,
  hasFocusedWindow,
  localDateKey,
  dailyActiveProperties,
} from '../dailyActiveHeartbeat';

/**
 * The heartbeat is only correct across CALLS, not within one: every interesting
 * case is "what happens the second time". These drive the decision the way the
 * service does — feed the previous `next` back in as the stored state.
 */
describe('decideDailyActive', () => {
  const at = (iso: string) => new Date(iso);

  it('emits on a fresh install and not again the same local day', () => {
    const first = decideDailyActive({}, at('2026-09-09T09:00:00'));
    expect(first.shouldEmit).toBe(true);
    expect(first.next.lastDailyActiveDate).toBe('2026-09-09');

    const later = decideDailyActive(first.next, at('2026-09-09T23:59:59'));
    expect(later.shouldEmit).toBe(false);
  });

  it('emits again once the local day rolls over', () => {
    const first = decideDailyActive({}, at('2026-09-09T23:59:59'));
    const next = decideDailyActive(first.next, at('2026-09-10T00:00:01'));

    expect(next.shouldEmit).toBe(true);
    expect(next.next.lastDailyActiveDate).toBe('2026-09-10');
  });

  it('emits after a gap of days rather than only on consecutive days', () => {
    const first = decideDailyActive({}, at('2026-09-01T12:00:00'));
    const afterGap = decideDailyActive(first.next, at('2026-09-20T12:00:00'));

    expect(afterGap.shouldEmit).toBe(true);
  });

  /**
   * A clock that was wrong and got corrected, or a machine carried west across
   * timezones, leaves a stored date in the future. Suppressing until real time
   * catches up would silence a live install for as long as the skew lasted.
   */
  it('emits when the stored date is in the future', () => {
    const decision = decideDailyActive(
      { lastDailyActiveDate: '2027-01-01' },
      at('2026-09-09T12:00:00'),
    );

    expect(decision.shouldEmit).toBe(true);
    expect(decision.next.lastDailyActiveDate).toBe('2026-09-09');
  });

  it('emits when the stored date is unparseable rather than wedging', () => {
    const decision = decideDailyActive(
      { lastDailyActiveDate: 'not-a-date' },
      at('2026-09-09T12:00:00'),
    );

    expect(decision.shouldEmit).toBe(true);
  });
});

describe('localDateKey', () => {
  it('zero-pads month and day so keys compare and group as strings', () => {
    expect(localDateKey(new Date('2026-01-05T12:00:00'))).toBe('2026-01-05');
  });

  /**
   * Local, not UTC: an evening in a negative-offset timezone is already the
   * next day in UTC, and bucketing it there would split one user's single day
   * across two heartbeats.
   */
  it('uses local calendar fields, not UTC ones', () => {
    const evening = new Date(2026, 8, 9, 23, 30, 0);
    expect(localDateKey(evening)).toBe('2026-09-09');
  });
});

/**
 * This guard is the whole difference between DAU and "installs whose process is
 * running". Removing it re-inflates the metric by roughly a third on weekdays
 * and more than half on weekends, silently and with no other visible symptom.
 */
describe('hasFocusedWindow', () => {
  const win = (focused: boolean, destroyed = false) => ({
    isFocused: () => focused,
    isDestroyed: () => destroyed,
  });

  it('is false when the app is running with no focused window', () => {
    expect(hasFocusedWindow([win(false), win(false)])).toBe(false);
  });

  it('is false when there are no windows at all', () => {
    expect(hasFocusedWindow([])).toBe(false);
  });

  it('is true when any window is focused', () => {
    expect(hasFocusedWindow([win(false), win(true)])).toBe(true);
  });

  /** `isFocused()` throws on a destroyed window, so it must never be reached. */
  it('does not consult a destroyed window', () => {
    const destroyed = {
      isDestroyed: () => true,
      isFocused: () => {
        throw new Error('Object has been destroyed');
      },
    };
    expect(hasFocusedWindow([destroyed])).toBe(false);
    expect(hasFocusedWindow([destroyed, win(true)])).toBe(true);
  });
});

describe('dailyActiveProperties', () => {
  const props = () =>
    dailyActiveProperties({
      version: '0.33.1',
      platform: 'darwin',
      cpuArch: 'arm64',
      daysSinceInstall: 45,
      localDate: '2026-09-09',
      nowIso: '2026-09-09T14:30:00.000Z',
    });

  it('buckets install age instead of carrying a precise install date', () => {
    expect(props()).toMatchObject({
      nimbalyst_version: '0.33.1',
      platform: 'darwin',
      days_since_install: '31-90',
      local_date: '2026-09-09',
    });
  });

  /**
   * These four have no other surviving carrier: version and arch were only on
   * the sampled session-start event, and the other two died with `$set`. If the
   * `$set` block is dropped from the payload they silently decay again, with no
   * failure anywhere to notice it.
   */
  it('carries the person properties that lost their original carrier', () => {
    expect(props().$set).toEqual({
      nimbalyst_version: '0.33.1',
      cpu_arch: 'arm64',
      last_session_at: '2026-09-09T14:30:00.000Z',
      has_nimbalyst_session: true,
    });
  });
});
