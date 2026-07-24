import { describe, expect, it } from 'vitest';
import { formatCellValue } from '../formatters';
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
