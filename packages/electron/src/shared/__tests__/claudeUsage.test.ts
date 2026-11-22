// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { claudeUsageHeadline, parseClaudeUsageResponse, parseWeeklyModelLimits } from '../claudeUsage';

describe('Claude weekly model limits', () => {
  it('reads Fable from the live API shape even when its model id is null', () => {
    expect(parseWeeklyModelLimits([
      { kind: 'weekly_all', percent: 73, scope: null },
      { kind: 'weekly_scoped', percent: 86, resets_at: '2026-09-15T18:59:59Z', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: true },
      { kind: 'weekly_scoped', percent: 0, resets_at: null, scope: { model: { id: 'future', display_name: 'Future' } }, is_active: false },
    ])).toEqual([
      { model: 'Fable', utilization: 86, resetsAt: '2026-09-15T18:59:59Z' },
      { model: 'Future', utilization: 0, resetsAt: null },
    ]);
  });

  it('handles older responses and rejects malformed model limits instead of inventing remaining quota', () => {
    expect(parseWeeklyModelLimits(undefined)).toEqual([]);
    expect(parseWeeklyModelLimits(null)).toEqual([]);
    expect(parseWeeklyModelLimits([{ kind: 'weekly_scoped', percent: 5, scope: { surface: 'cowork' } }])).toEqual([]);
    expect(() => parseWeeklyModelLimits([{ kind: 'weekly_scoped', percent: null, scope: { model: { display_name: 'Fable' } } }])).toThrow();
  });
});

describe('Claude plans without a 5-hour session limit', () => {
  it('reports no session window when the API sends five_hour: null, and headlines the weekly window', () => {
    const usage = parseClaudeUsageResponse({
      five_hour: null,
      seven_day: { utilization: 35, resets_at: '2026-11-03T18:59:59Z' },
      seven_day_opus: null,
      limits: [],
    }, 1000);
    expect(usage.fiveHour).toBeNull();
    expect(usage.sevenDayOpus).toBeUndefined();
    expect(claudeUsageHeadline(usage)).toEqual({ label: 'Weekly', utilization: 35, resetsAt: '2026-11-03T18:59:59Z' });
  });

  it('keeps an idle session window (0%, no reset) as a real session limit', () => {
    const usage = parseClaudeUsageResponse({
      five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: 12, resets_at: null },
    }, 1000);
    expect(usage.fiveHour).toEqual({ utilization: 0, resetsAt: null });
    expect(claudeUsageHeadline(usage).label).toBe('Session');
  });
});
