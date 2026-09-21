// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseWeeklyModelLimits } from '../claudeUsage';

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
