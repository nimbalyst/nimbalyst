// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { computeRangeStats, computeSelectionStats, type StatsCell } from '../selectionStats';

describe('selection stats', () => {
  it('sums numbers only, counts non-blank cells, and lets dates into min/max only', () => {
    const jan1 = new Date(2026, 0, 1).getTime();
    const cells: (StatsCell | null)[] = [
      { raw: '10' },
      { raw: '=A1*2', display: '20', numeric: 20 },
      { raw: '$1,000', numeric: 1000 },
      { raw: 'text' },
      { raw: 'TRUE', numeric: null },
      { raw: '2026-01-01', date: jan1 },
      { raw: '   ' },
      null,
    ];
    expect(computeSelectionStats(cells)).toEqual({
      count: 6,
      countNumbers: 3,
      sum: 1030,
      average: 1030 / 3,
      min: 10,
      max: jan1,
      minIsDate: false,
      maxIsDate: true,
    });
  });

  it('reports nulls with no numbers and counts overlapping ranges once', () => {
    expect(computeSelectionStats([{ raw: 'a' }])).toMatchObject({ count: 1, average: null, min: null, max: null, maxIsDate: false });

    const value = (row: number, col: number): StatsCell => ({ raw: String(row * 10 + col) });
    const stats = computeRangeStats([
      { startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
      { startRow: 1, startCol: 1, endRow: 2, endCol: 2 },
    ], value);
    // 0,1,10,11 then 12,21,22 (11 already counted)
    expect(stats).toMatchObject({ count: 7, sum: 77, min: 0, max: 22 });
  });

  it('streams a large selection', () => {
    const many = { *[Symbol.iterator]() { for (let i = 0; i < 200_000; i++) yield { numeric: 1, raw: '1' }; } };
    expect(computeSelectionStats(many)).toMatchObject({ count: 200_000, sum: 200_000 });
  });
});
