// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  detectColumnType,
  encodeHyperlink,
  formatCellValue,
  getSortKey,
  isNumericCellValue,
  normalizePastedValue,
  parseTrackerCell,
  parseUrlCell,
} from '../formatters';
import type { ColumnFormat } from '../../types';

describe('formatCellValue (cellTemplate wire path for #329 sub-bug 4)', () => {
  describe('currency', () => {
    const usd: ColumnFormat = { type: 'currency', currency: 'USD', decimals: 2, showThousandsSeparator: true };

    it('formats a raw number as USD', () => {
      expect(formatCellValue(1234.56, usd)).toBe('$1,234.56');
    });

    it('formats a numeric string as USD', () => {
      expect(formatCellValue('1234.56', usd)).toBe('$1,234.56');
    });

    it('strips existing $ / commas before formatting', () => {
      expect(formatCellValue('$1,234.56', usd)).toBe('$1,234.56');
    });

    it('handles negatives', () => {
      expect(formatCellValue(-1234.5, usd)).toBe('-$1,234.50');
    });

    it('falls back to String(value) when not numeric', () => {
      expect(formatCellValue('hello', usd)).toBe('hello');
    });

    it('handles EUR locale formatting', () => {
      const eur: ColumnFormat = { type: 'currency', currency: 'EUR', decimals: 2, showThousandsSeparator: true };
      // Intl en-DE / de-DE uses a non-breaking space and the symbol after the number;
      // we only assert the symbol is present and the digits appear.
      const out = formatCellValue(1234.5, eur);
      expect(out).toMatch(/€/);
      expect(out).toMatch(/1\.234|1,234/);
    });
  });

  /**
   * The magnitude guess these cover is wrong for whole-number inputs, which is
   * why `valuesAreFractions` exists. They stay because a column formatted
   * before the flag existed must keep rendering the way it always did.
   */
  describe('percentage', () => {
    const pct: ColumnFormat = { type: 'percentage', decimals: 1 };

    it('formats a value 0..1 as a percent', () => {
      expect(formatCellValue(0.123, pct)).toBe('12.3%');
    });

    it('treats a >1 value as already a percent', () => {
      expect(formatCellValue(45.6, pct)).toBe('45.6%');
    });

    it('handles negative percentages', () => {
      expect(formatCellValue(-0.5, pct)).toBe('-50.0%');
    });

    it('preserves zero', () => {
      expect(formatCellValue(0, pct)).toBe('0.0%');
    });

    it('falls back to String(value) when not numeric', () => {
      expect(formatCellValue('n/a', pct)).toBe('n/a');
    });
  });

  describe('number', () => {
    const numWithSep: ColumnFormat = { type: 'number', decimals: 2, showThousandsSeparator: true };
    const numNoSep: ColumnFormat = { type: 'number', decimals: 2, showThousandsSeparator: false };

    it('adds thousands separator when configured', () => {
      expect(formatCellValue(1234567.89, numWithSep)).toBe('1,234,567.89');
    });

    it('omits thousands separator when configured', () => {
      expect(formatCellValue(1234567.89, numNoSep)).toBe('1234567.89');
    });

    it('respects decimals=0', () => {
      const zeroDec: ColumnFormat = { type: 'number', decimals: 0, showThousandsSeparator: true };
      expect(formatCellValue(1234.7, zeroDec)).toBe('1,235');
    });
  });

  describe('null / empty edge cases', () => {
    const usd: ColumnFormat = { type: 'currency', currency: 'USD', decimals: 2, showThousandsSeparator: true };

    it('returns empty string for null', () => {
      expect(formatCellValue(null, usd)).toBe('');
    });

    it('returns empty string for empty string', () => {
      expect(formatCellValue('', usd)).toBe('');
    });
  });

  describe('text format (passthrough)', () => {
    const text: ColumnFormat = { type: 'text' };

    it('returns the value as-is', () => {
      expect(formatCellValue('hello world', text)).toBe('hello world');
    });

    it('coerces a number to string', () => {
      expect(formatCellValue(42, text)).toBe('42');
    });
  });
});

describe('percentage scaling is explicit, not guessed', () => {
  const fractions: ColumnFormat = { type: 'percentage', decimals: 1, valuesAreFractions: true };
  const wholes: ColumnFormat = { type: 'percentage', decimals: 1, valuesAreFractions: false };

  it.each([
    [0.5, fractions, '50.0%'],
    // The case the old magnitude guess got wrong: 1 is 100%, not 1%.
    [1, fractions, '100.0%'],
    [0.4, wholes, '0.4%'],
    [40, wholes, '40.0%'],
  ])('%o with %o -> %s', (value, format, expected) => {
    expect(formatCellValue(value, format)).toBe(expected);
  });
});

describe('date, datetime, and time', () => {
  it('renders a date through the named preset', () => {
    expect(formatCellValue('2026-08-18', { type: 'date', dateFormat: 'MMM D, YYYY' })).toBe('Aug 18, 2026');
  });

  it('keeps the time on a datetime value', () => {
    expect(
      formatCellValue('2026-08-18 13:30:00', { type: 'datetime', dateFormat: 'YYYY-MM-DD', timeFormat: 'h:mm A' }),
    ).toBe('2026-08-18 1:30 PM');
  });

  it('parses an ISO datetime with a T separator', () => {
    expect(formatCellValue('2026-08-18T09:05', { type: 'time', timeFormat: 'HH:mm' })).toBe('09:05');
  });

  it('parses a bare 12-hour time', () => {
    expect(formatCellValue('1:30 PM', { type: 'time', timeFormat: 'HH:mm:ss' })).toBe('13:30:00');
  });

  it('a custom pattern overrides the presets', () => {
    expect(
      formatCellValue('2026-08-18 13:30:00', {
        type: 'datetime',
        dateFormat: 'MM/DD/YYYY',
        timeFormat: 'HH:mm',
        pattern: 'ddd MMMM D [at] h:mma',
      }),
    ).toBe('Tue August 18 at 1:30pm');
  });

  it('a bare ISO date does not shift a day', () => {
    // Built field-by-field in local time; a UTC parse lands on the 17th west of Greenwich.
    expect(formatCellValue('2026-08-18', { type: 'date', dateFormat: 'YYYY-MM-DD' })).toBe('2026-08-18');
  });

  it('leaves an unparseable value alone', () => {
    expect(formatCellValue('sometime', { type: 'date' })).toBe('sometime');
  });
});

describe('number styles and negatives', () => {
  it.each([
    [-1234.567, { type: 'number', decimals: 2, numberStyle: 'plain' } as ColumnFormat, '-1234.567'],
    [1234.567, { type: 'number', decimals: 2, numberStyle: 'scientific' } as ColumnFormat, '1.23E+03'],
    [0.0001234, { type: 'number', decimals: 2, numberStyle: 'scientific' } as ColumnFormat, '1.23E-04'],
    [-1234.5, { type: 'currency', currency: 'USD', decimals: 2, numberStyle: 'accounting' } as ColumnFormat, '$ (1,234.50)'],
    [1234.5, { type: 'currency', currency: 'USD', decimals: 2, numberStyle: 'accounting' } as ColumnFormat, '$ 1,234.50'],
    [-1234.5, { type: 'number', decimals: 2, showThousandsSeparator: true, negativeStyle: 'parens' } as ColumnFormat, '(1,234.50)'],
    // `red` decorates with a CSS class, so the string stays a plain number.
    [-1234.5, { type: 'number', decimals: 2, showThousandsSeparator: true, negativeStyle: 'red' } as ColumnFormat, '-1,234.50'],
  ])('%o -> %s', (value, format, expected) => {
    expect(formatCellValue(value, format)).toBe(expected);
  });

  it('reads an accounting-style negative back as a negative number', () => {
    expect(formatCellValue('(1,234.50)', { type: 'number', decimals: 2, showThousandsSeparator: true })).toBe('-1,234.50');
  });
});

describe('boolean, link, and tracker cells', () => {
  it.each([
    ['yes', 'true-false', 'TRUE'],
    ['0', 'yes-no', 'No'],
    ['TRUE', 'check', '✓'],
  ])('%s as %s -> %s', (value, style, expected) => {
    expect(formatCellValue(value, { type: 'boolean', booleanStyle: style as never })).toBe(expected);
  });

  it('leaves a non-boolean spelling as text', () => {
    expect(formatCellValue('maybe', { type: 'boolean' })).toBe('maybe');
  });

  it.each([
    ['https://example.com/a', 'https://example.com/a'],
    ['www.example.com', 'https://www.example.com'],
    ['mailto:a@b.com', 'mailto:a@b.com'],
  ])('%s is a link to %s', (value, href) => {
    expect(parseUrlCell(value)?.href).toBe(href);
  });

  it.each(['just a note', 'ftp://example.com', ''])('%o is not a link', (value) => {
    expect(parseUrlCell(value)).toBeNull();
  });

  it('unpacks a HYPERLINK label and target', () => {
    const link = parseUrlCell(encodeHyperlink('https://example.com', 'Q3 report'));
    expect(link).toEqual({ href: 'https://example.com', label: 'Q3 report' });
  });

  it('shows a HYPERLINK result as its label in a plain text column', () => {
    expect(formatCellValue(encodeHyperlink('https://example.com', 'Q3 report'), { type: 'text' })).toBe('Q3 report');
  });

  it.each([
    ['NIM-123', 'NIM-123'],
    ['nimbalyst://NIM-123', 'NIM-123'],
    ['nim-7', 'NIM-7'],
  ])('%s resolves to tracker key %s', (value, key) => {
    expect(parseTrackerCell(value)).toBe(key);
  });

  it.each(['UTF-8x', 'NIM123', 'plain text'])('%o is not a tracker key', (value) => {
    expect(parseTrackerCell(value)).toBeNull();
  });
});

/**
 * Sorting compares these keys, so a wrong key is a wrong sort order — the
 * failure the old `localeCompare` path produced for every non-ISO date column.
 */
describe('getSortKey', () => {
  it('orders US-format dates chronologically, not by month', () => {
    const format: ColumnFormat = { type: 'date', dateFormat: 'MM/DD/YYYY' };
    const sorted = ['12/01/2025', '01/15/2026', '02/03/2026']
      .sort((a, b) => (getSortKey(a, format) as number) - (getSortKey(b, format) as number));
    expect(sorted).toEqual(['12/01/2025', '01/15/2026', '02/03/2026']);
  });

  it('compares currency by magnitude', () => {
    const format: ColumnFormat = { type: 'currency', currency: 'USD', decimals: 2 };
    expect(getSortKey('$1,200', format)).toBe(1200);
    expect(getSortKey('($300)', format)).toBe(-300);
  });

  it('scales percentages the same way the display does', () => {
    expect(getSortKey('0.5', { type: 'percentage', valuesAreFractions: true })).toBe(50);
  });

  it('returns null for blanks so callers can sink them', () => {
    expect(getSortKey('', { type: 'number' })).toBeNull();
    expect(getSortKey(null, undefined)).toBeNull();
  });

  it('keeps the unformatted behavior of numbers-as-numbers, text-as-text', () => {
    expect(getSortKey('42', undefined)).toBe(42);
    expect(getSortKey('Banana', undefined)).toBe('banana');
  });
});

describe('normalizePastedValue', () => {
  it('canonicalizes a US date pasted into a datetime column', () => {
    expect(normalizePastedValue('1/2/2026 3:04 PM', { type: 'datetime' })).toBe('2026-01-02 15:04:00');
  });

  it('converts a whole percent into the fraction the column stores', () => {
    expect(normalizePastedValue('50%', { type: 'percentage', valuesAreFractions: true })).toBe('0.5');
  });

  it('strips currency formatting so formulas can add the value up', () => {
    expect(normalizePastedValue('$1,200.50', { type: 'currency' })).toBe('1200.5');
  });

  it.each([
    ['=SUM(A1:A2)', { type: 'currency' } as ColumnFormat],
    ['not a date', { type: 'date' } as ColumnFormat],
    ['1200', { type: 'number' } as ColumnFormat],
    ['anything', undefined],
  ])('leaves %o untouched', (value, format) => {
    expect(normalizePastedValue(value, format)).toBe(value);
  });
});

describe('detectColumnType', () => {
  it.each([
    [['2026-08-18', '2026-01-02'], 'date'],
    [['2026-08-18 13:30', '2026-01-02 09:00'], 'datetime'],
    [['$1,200', '$3.50'], 'currency'],
    [['10%', '25%'], 'percentage'],
    [['NIM-1', 'NIM-22'], 'tracker'],
    [['https://a.com', 'www.b.com'], 'url'],
    [['true', 'no'], 'boolean'],
    [['1', '2.5'], 'number'],
  ])('%o -> %s', (values, expected) => {
    expect(detectColumnType(values)).toBe(expected);
  });

  it('ignores blanks', () => {
    expect(detectColumnType(['', null, '2026-08-18', '   '])).toBe('date');
  });

  it('falls back to text when the column disagrees with itself', () => {
    expect(detectColumnType(['2026-08-18', '$12'])).toBe('text');
  });
});

/**
 * Alignment is inferred from the value, so the predicate has to reject the
 * strings `parseFloat` would happily accept a numeric prefix of -- an ISO date
 * right-aligned as if it were the year 2026 is the visible form of issue #329.
 */
describe('isNumericCellValue', () => {
  it.each([
    [100, true],
    ['100', true],
    ['-1.5', true],
    ['+3', true],
    ['1,234', true],
    ['12%', true],
    ['1.5e3', true],
    ['  42  ', true],
    ['2026-05-15', false],
    ['12 apples', false],
    ['steady', false],
    ['', false],
    ['   ', false],
    [null, false],
    [undefined, false],
    [Number.NaN, false],
  ])('%o -> %s', (value, expected) => {
    expect(isNumericCellValue(value)).toBe(expected);
  });
});
