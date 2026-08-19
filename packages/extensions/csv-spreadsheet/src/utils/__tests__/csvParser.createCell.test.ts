// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createCell, parseCSV, serializeToCSV } from '../csvParser';
import { spreadsheetDataToGridSource } from '../gridOperations';

/**
 * `cell.computed` is what `toGridSource` writes into the RevoGrid model, and
 * the cell editor renders that model value. So a value coerced to the wrong
 * type here is a value the user sees mangled the moment they open the cell —
 * `06/01/2001` opening as `6`, `1,234` opening as `1`.
 *
 * The cause is `parseFloat` stopping at the first character it cannot read.
 * Issue #329 patched the reported shape (`YYYY-MM-DD`) with a targeted guard;
 * the guard is now a full-string numeric check, so these cases are one rule
 * rather than a growing list of exceptions.
 */
describe('createCell', () => {
  it.each([
    // Numbers stay numbers.
    ['42', 42],
    ['-1.5', -1.5],
    ['+3', 3],
    ['.5', 0.5],
    ['3.14', 3.14],
    ['1e5', 100000],
    ['2026', 2026],
    ['20260515', 20260515],
    ['  42  ', 42],

    // Anything only *starting* with digits keeps the text the user typed.
    ['2026-05-15', '2026-05-15'],
    ['2026-3-9', '2026-3-9'],
    ['06/01/2001', '06/01/2001'],
    ['2026/05/15', '2026/05/15'],
    ['01.02.2026', '01.02.2026'],
    ['06/01/2001 12:00 AM', '06/01/2001 12:00 AM'],
    ['2026-05-15T13:30', '2026-05-15T13:30'],
    ['13:30', '13:30'],
    ['1,234', '1,234'],
    ['12 apples', '12 apples'],
    ['$1,200', '$1,200'],
    ['50%', '50%'],
    ['NIM-123', 'NIM-123'],
    ['hello world', 'hello world'],
    ['', ''],
  ])('%o -> %o', (input, expected) => {
    expect(createCell(input).computed).toBe(expected);
  });

  it('trims the raw value it stores for a numeric cell', () => {
    expect(createCell('  42  ').raw).toBe('42');
  });

  it('preserves surrounding whitespace on a text cell', () => {
    // `raw` is what gets serialized, so a text cell round-trips verbatim.
    expect(createCell('  hello  ').raw).toBe('  hello  ');
  });

  it.each(['=A1+B1', '=2026-05-15'])('leaves %s for the formula engine', (formula) => {
    const cell = createCell(formula);
    expect(cell.raw).toBe(formula);
    expect(cell.computed).toBeNull();
  });
});

/**
 * The truncation above was not merely a display bug, and testing `createCell`
 * alone would not have caught why.
 *
 * The grid model — not `SpreadsheetData` — is what gets serialized back to the
 * file. `spreadsheetDataToGridSource` writes `cell.computed` into that model, so
 * a value `createCell` coerced was written back to disk on the next save, and
 * the original text was gone. A user typed `06/01/2001`, the sheet reloaded, and
 * the file permanently held `6`.
 *
 * This pins the whole chain rather than one function in it.
 */
describe('file -> grid -> file round trip', () => {
  const roundTrip = (csv: string): string => {
    const { data } = parseCSV(csv);
    const { source } = spreadsheetDataToGridSource(data, 0, 0);
    // What the grid would serialize back after a reload.
    const reparsed = parseCSV(
      source.map((row) => Object.values(row).join(',')).join('\n'),
    );
    return serializeToCSV(reparsed.data, ',', false);
  };

  it.each([
    'Due\n06/01/2001',
    'Due\n06/01/2001 12:00 AM',
    'Due\n2026-05-15',
    'Due\n01.02.2026',
    'Amount\n"1,234"',
  ])('survives a reload without losing text: %j', (csv) => {
    expect(roundTrip(csv)).toBe(roundTrip(roundTrip(csv)));
    expect(roundTrip(csv)).toContain(csv.split('\n')[1].replace(/"/g, ''));
  });

  it('keeps a genuine number a number through the round trip', () => {
    const { data } = parseCSV('Count\n42');
    const { source } = spreadsheetDataToGridSource(data, 0, 0);
    expect(source[0].A).toBe(42);
  });
});
