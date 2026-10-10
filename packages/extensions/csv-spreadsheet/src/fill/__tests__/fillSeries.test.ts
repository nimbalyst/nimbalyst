// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { fillSeries } from '../fillSeries';

const down = { direction: 'down' } as const;
const up = { direction: 'up' } as const;

describe('fillSeries', () => {
  it('numbers: single repeats unless incrementing, two or more continue the trend', () => {
    expect(fillSeries(['5'], 3, down)).toEqual(['5', '5', '5']);
    expect(fillSeries(['5'], 3, { direction: 'right', incrementSingleNumber: true })).toEqual(['6', '7', '8']);
    expect(fillSeries(['1', '3'], 3, down)).toEqual(['5', '7', '9']);
    expect(fillSeries(['1', '3'], 2, up)).toEqual(['-1', '-3']);
    expect(fillSeries(['0.1', '0.2'], 2, down)).toEqual(['0.3', '0.4']);
    // Uneven samples: least-squares fit, as in Sheets.
    expect(fillSeries(['1', '2', '4'], 1, down)).toEqual(['5.3333333333']);
  });

  // R1-6: a lone decimal or negative number used to match the text+number
  // series ('1.' + 5, '-' + 5) and count; R1-7: exponent steps rounded to 0.
  it('a single decimal or negative number repeats, and tiny steps keep significant digits', () => {
    expect(fillSeries(['1.5'], 2, down)).toEqual(['1.5', '1.5']);
    expect(fillSeries(['-5'], 2, down)).toEqual(['-5', '-5']);
    expect(fillSeries(['-5'], 2, { direction: 'down', incrementSingleNumber: true })).toEqual(['-4', '-3']);
    expect(fillSeries(['1e-12', '2e-12'], 2, down)).toEqual(['3e-12', '4e-12']);
    expect(fillSeries(['1e-12', '2e-12', '4e-12'], 1, down)).toEqual(['5.33333333333e-12']);
  });

  it('dates step by day or month in the shape the user typed', () => {
    expect(fillSeries(['2026-01-30'], 3, down)).toEqual(['2026-01-31', '2026-02-01', '2026-02-02']);
    expect(fillSeries(['1/1/2026', '1/8/2026'], 2, down)).toEqual(['1/15/2026', '1/22/2026']);
    expect(fillSeries(['01/15/2026', '02/15/2026'], 2, down)).toEqual(['03/15/2026', '04/15/2026']);
    expect(fillSeries(['31.1.2026', '28.2.2026'], 2, down)).toEqual(['31.3.2026', '30.4.2026']);
    expect(fillSeries(['2026-03-31'], 1, up)).toEqual(['2026-03-30']);
    expect(fillSeries(['2026-12-01', '2027-12-01'], 1, down)).toEqual(['2028-12-01']);
  });

  it('weekday and month names wrap and keep case', () => {
    expect(fillSeries(['Fri'], 3, down)).toEqual(['Sat', 'Sun', 'Mon']);
    expect(fillSeries(['MONDAY', 'WEDNESDAY'], 2, down)).toEqual(['FRIDAY', 'SUNDAY']);
    expect(fillSeries(['november'], 2, down)).toEqual(['december', 'january']);
    expect(fillSeries(['Jan'], 1, up)).toEqual(['Dec']);
  });

  it('text with a trailing number counts, keeping prefix and padding', () => {
    expect(fillSeries(['Item 1'], 2, down)).toEqual(['Item 2', 'Item 3']);
    expect(fillSeries(['Q09', 'Q11'], 1, down)).toEqual(['Q13']);
    expect(fillSeries(['Item 1'], 3, up)).toEqual(['Item 0', 'Item 1', 'Item 2']);
    expect(fillSeries(['Item 1', 'Task 2'], 3, down)).toEqual(['Item 1', 'Task 2', 'Item 1']);
  });

  it('formulas repeat with relative refs shifted along the fill axis in every direction', () => {
    expect(fillSeries(['=A1*$B$1'], 2, down)).toEqual(['=A2*$B$1', '=A3*$B$1']);
    expect(fillSeries(['=A2', 'x'], 3, up)).toEqual(['x', '=#REF!', 'x']);
    expect(fillSeries(['=Z1+$Z1'], 2, { direction: 'right' })).toEqual(['=AA1+$Z1', '=AB1+$Z1']);
    expect(fillSeries(['=C1'], 2, { direction: 'left' })).toEqual(['=B1', '=A1']);
    expect(fillSeries(['=A1', '=B1'], 2, down)).toEqual(['=A3', '=B3']);
  });
});
