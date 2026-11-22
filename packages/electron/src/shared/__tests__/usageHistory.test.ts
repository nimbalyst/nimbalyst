// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  codexUsageWeekSamples,
  usageWeeksByMeter,
  recordUsageWeekSamples,
  type UsageWeekRecord,
} from '../usageHistory';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RESET_1 = '2026-10-27T17:00:00Z';
const RESET_2 = '2026-11-03T17:00:00Z';
const reset1Ms = Date.parse(RESET_1);

function weekly(utilization: number, resetsAt: string | null) {
  return { meter: 'claude:weekly', label: 'Weekly', utilization, resetsAt };
}

describe('weekly usage history', () => {
  it('keeps the last reading of each window and closes it when the reset passes', () => {
    let history: UsageWeekRecord[] = [];
    history = recordUsageWeekSamples(history, [weekly(40, RESET_1)], reset1Ms - 3 * DAY);
    // Reset timestamps drift slightly between polls; still the same window.
    history = recordUsageWeekSamples(history, [weekly(82, '2026-10-27T17:00:00.412Z')], reset1Ms - 2 * HOUR);
    // Error responses carry no reset time and must not create or overwrite a week.
    history = recordUsageWeekSamples(history, [weekly(0, null)], reset1Ms - HOUR);
    history = recordUsageWeekSamples(history, [weekly(5, RESET_2)], reset1Ms + HOUR);

    expect(history.map(r => [r.utilization, r.resetsAt])).toEqual([
      [82, '2026-10-27T17:00:00.412Z'],
      [5, RESET_2],
    ]);
    expect(usageWeeksByMeter(history, reset1Ms + HOUR)).toEqual([{
      meter: 'claude:weekly',
      label: 'Weekly',
      weeks: [
        expect.objectContaining({ utilization: 5, inProgress: true, partial: false }),
        expect.objectContaining({ utilization: 82, inProgress: false, partial: false }),
      ],
    }]);
  });

  it('keeps a point for each change in utilization so the week can be graphed', () => {
    let history: UsageWeekRecord[] = [];
    for (const [hoursBeforeReset, value] of [[72, 10], [48, 10], [24, 40.04], [2, 61]]) {
      history = recordUsageWeekSamples(history, [weekly(value, RESET_1)], reset1Ms - hoursBeforeReset * HOUR);
    }
    expect(history[0].points).toEqual([
      [reset1Ms - 72 * HOUR, 10],
      [reset1Ms - 24 * HOUR, 40],
      [reset1Ms - 2 * HOUR, 61],
    ]);
    expect(history[0].lastSeenAt).toBe(reset1Ms - 2 * HOUR);
  });

  it('marks a week partial when the app was closed long before its reset', () => {
    let history = recordUsageWeekSamples([], [weekly(30, RESET_1)], reset1Ms - 2 * DAY);
    history = recordUsageWeekSamples(history, [weekly(10, RESET_2)], reset1Ms + DAY);
    const [meter] = usageWeeksByMeter(history, Date.parse(RESET_2) + HOUR);
    expect(meter.weeks.map(w => [w.resetsAt, w.utilization, w.partial])).toEqual([
      [RESET_2, 10, true],
      [RESET_1, 30, true],
    ]);
  });

  it('lists the main weekly meter first even when a model limit reset earlier', () => {
    const fable = { meter: 'claude:model:fable', label: 'Fable (Weekly)', utilization: 0, resetsAt: '2026-10-27T16:59:59Z' };
    const history = recordUsageWeekSamples([], [weekly(68, RESET_1), fable], reset1Ms - DAY);
    expect(usageWeeksByMeter(history, reset1Ms - DAY).map(m => m.meter)).toEqual([
      'claude:weekly',
      'claude:model:fable',
    ]);
  });

  it('ignores resets already in the past or further out than a week', () => {
    const now = reset1Ms - DAY;
    expect(recordUsageWeekSamples([], [
      weekly(50, '2026-10-20T17:00:00Z'),
      weekly(50, '2026-11-10T17:00:00Z'),
    ], now)).toEqual([]);
  });

  it('records only the weekly Codex windows', () => {
    expect(codexUsageWeekSamples({
      limits: [{
        id: 'codex',
        name: null,
        windows: [
          { slot: 'primary', usedPercent: 12, windowDurationMins: 300, resetsAt: RESET_1 },
          { slot: 'secondary', usedPercent: 64, windowDurationMins: 10080, resetsAt: RESET_2 },
        ],
      }],
    })).toEqual([{ meter: 'codex:codex:secondary', label: 'Weekly', utilization: 64, resetsAt: RESET_2 }]);
  });
});
