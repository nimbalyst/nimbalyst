/**
 * Display text for a cell under its column format, plus the sort key and the
 * pasted-value normalization that share the same parsing.
 */

import type { BooleanStyle, ColumnFormat, ColumnType, NegativeStyle } from '../../types';
import { CURRENCY_LOCALES, CURRENCY_SYMBOLS, isNumericColumnType, isTemporalColumnType } from './columnTypes';
import {
  decodeHyperlink,
  isNumericCellValue,
  parseBoolean,
  parseDateTime,
  parseNumber,
  parseTrackerCell,
  parseUrlCell,
  shownValue,
} from './parse';
import { formatWithPattern, resolveTemporalPattern } from './temporalPattern';

/**
 * Format a number with thousands separator
 */
function formatWithThousandsSeparator(num: number, decimals: number): string {
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format a number without thousands separator
 */
function formatWithoutThousandsSeparator(num: number, decimals: number): string {
  return num.toFixed(decimals);
}

/**
 * `1.23e+4` -> `1.23E+04`, matching the spreadsheet convention of a
 * two-digit exponent.
 */
function formatScientific(num: number, decimals: number): string {
  const [mantissa, exponent] = num.toExponential(decimals).split('e');
  const sign = exponent.startsWith('-') ? '-' : '+';
  const digits = exponent.replace(/^[-+]/, '').padStart(2, '0');
  return `${mantissa}E${sign}${digits}`;
}

/**
 * Format the magnitude of a number per the column's numeric style. The sign is
 * applied separately by {@link applyNegativeStyle} so every style shares one
 * negative-number convention.
 */
function formatMagnitude(magnitude: number, format: ColumnFormat): string {
  const decimals = format.decimals ?? 2;
  switch (format.numberStyle ?? 'standard') {
    case 'plain':
      // No forced decimals and no separators: the number as typed.
      return String(magnitude);
    case 'scientific':
      return formatScientific(magnitude, decimals);
    case 'accounting':
    case 'standard':
    default:
      return format.showThousandsSeparator
        ? formatWithThousandsSeparator(magnitude, decimals)
        : formatWithoutThousandsSeparator(magnitude, decimals);
  }
}

/** Whether this style draws negatives in parentheses rather than with a sign. */
function usesParens(style: NegativeStyle | undefined): boolean {
  return style === 'parens' || style === 'parens-red';
}

/** Whether this style asks for red negatives (applied as a CSS class). */
export function usesRedNegatives(style: NegativeStyle | undefined): boolean {
  return style === 'red' || style === 'parens-red';
}

function applyNegativeStyle(formattedMagnitude: string, isNegative: boolean, style: NegativeStyle | undefined): string {
  if (!isNegative) return formattedMagnitude;
  return usesParens(style) ? `(${formattedMagnitude})` : `-${formattedMagnitude}`;
}

/**
 * A percentage column's display value, honoring the explicit fraction flag.
 *
 * When the flag is absent the column predates it, so we keep the original
 * magnitude guess rather than silently re-scaling an existing sheet. The guess
 * is wrong for whole-number inputs (1 reads as 1%, not 100%) — which is exactly
 * why the flag exists — but changing already-formatted columns under the user
 * would be worse.
 */
function percentageDisplayValue(num: number, format: ColumnFormat): number {
  if (format.valuesAreFractions === true) return num * 100;
  if (format.valuesAreFractions === false) return num;
  return Math.abs(num) <= 1 && num !== 0 ? num * 100 : num;
}

function formatBoolean(flag: boolean, style: BooleanStyle | undefined): string {
  switch (style) {
    case 'yes-no': return flag ? 'Yes' : 'No';
    case 'check': return flag ? '✓' : '';
    case 'true-false':
    default:
      return flag ? 'TRUE' : 'FALSE';
  }
}

/**
 * Whether this cell should be drawn with the negative-value class.
 */
export function isNegativeFormattedValue(value: string | number | null, format: ColumnFormat): boolean {
  if (!usesRedNegatives(format.negativeStyle)) return false;
  if (!isNumericColumnType(format.type)) return false;
  const num = parseNumber(value);
  return num !== null && num < 0;
}

/** The text a cell shows, formatted when it has a format; a HYPERLINK result reads as its label. */
export function cellDisplayText(value: string | number | null | undefined, format: ColumnFormat | undefined): string {
  if (format) return formatCellValue(value ?? null, format);
  return String(shownValue(value) ?? '');
}

/**
 * Format a cell value according to the column format
 *
 * @param value The raw or computed cell value
 * @param format The column format configuration
 * @returns The formatted string for display
 */
export function formatCellValue(value: string | number | null, format: ColumnFormat): string {
  if (value === null || value === '') return '';
  // A HYPERLINK result outside a url column still reads as its label.
  if (format.type !== 'url' && typeof value === 'string' && decodeHyperlink(value)) return shownValue(value);

  switch (format.type) {
    case 'text':
      return String(value);

    case 'number': {
      const num = parseNumber(value);
      if (num === null) return String(value);
      return applyNegativeStyle(formatMagnitude(Math.abs(num), format), num < 0, format.negativeStyle);
    }

    case 'currency': {
      const num = parseNumber(value);
      if (num === null) return String(value);

      const decimals = format.decimals ?? 2;
      const currency = format.currency ?? 'USD';
      const symbol = CURRENCY_SYMBOLS[currency];
      const magnitude = Math.abs(num);
      const style = format.numberStyle ?? 'standard';

      // Accounting keeps the symbol hard against the left edge of the cell,
      // separated from the digits — the reason the style exists.
      if (style === 'accounting') {
        const body = formatWithThousandsSeparator(magnitude, decimals);
        return num < 0 ? `${symbol} (${body})` : `${symbol} ${body}`;
      }

      if (style === 'plain' || style === 'scientific') {
        return applyNegativeStyle(
          `${symbol}${formatMagnitude(magnitude, format)}`,
          num < 0,
          format.negativeStyle,
        );
      }

      const locale = CURRENCY_LOCALES[currency];
      let body: string;
      try {
        body = magnitude.toLocaleString(locale, {
          style: 'currency',
          currency: currency,
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        });
      } catch {
        // Fallback if Intl fails
        body = `${symbol}${
          format.showThousandsSeparator
            ? formatWithThousandsSeparator(magnitude, decimals)
            : formatWithoutThousandsSeparator(magnitude, decimals)
        }`;
      }
      return applyNegativeStyle(body, num < 0, format.negativeStyle);
    }

    case 'percentage': {
      const num = parseNumber(value);
      if (num === null) return String(value);

      const decimals = format.decimals ?? 1;
      const displayValue = percentageDisplayValue(num, format);
      const body = `${Math.abs(displayValue).toFixed(decimals)}%`;
      return applyNegativeStyle(body, displayValue < 0, format.negativeStyle);
    }

    case 'date':
    case 'datetime':
    case 'time': {
      const date = parseDateTime(value);
      if (date === null) return String(value);
      return formatWithPattern(date, resolveTemporalPattern(format));
    }

    case 'boolean': {
      const flag = parseBoolean(value);
      if (flag === null) return String(value);
      return formatBoolean(flag, format.booleanStyle);
    }

    case 'url': {
      const link = parseUrlCell(value);
      return link ? link.label : String(value);
    }

    case 'tracker': {
      const key = parseTrackerCell(value);
      return key ?? String(value);
    }

    default:
      return String(value);
  }
}

/**
 * A value's canonical sort key for a formatted column.
 *
 * Sorting a `date` column has to compare instants, not the `MM/DD/YYYY` strings
 * a lexical sort would order by month. Returns a number for numeric and
 * temporal columns, a lowercased string otherwise, and null for blanks (which
 * callers push to the end).
 */
export function getSortKey(value: string | number | null, format: ColumnFormat | undefined): number | string | null {
  if (value === null || value === '') return null;

  if (format) {
    if (isNumericColumnType(format.type)) {
      const num = parseNumber(value);
      if (num !== null) {
        return format.type === 'percentage' ? percentageDisplayValue(num, format) : num;
      }
    } else if (isTemporalColumnType(format.type)) {
      const date = parseDateTime(value);
      if (date !== null) return date.getTime();
    } else if (format.type === 'boolean') {
      const flag = parseBoolean(value);
      if (flag !== null) return flag ? 1 : 0;
    }
  }

  if (typeof value === 'number') return value;
  const text = String(value);
  // Unformatted columns keep the existing behavior: numeric-looking values
  // compare as numbers, everything else as text.
  if (isNumericCellValue(text)) {
    const num = parseNumber(text);
    if (num !== null) return num;
  }
  return text.toLocaleLowerCase();
}

/** Canonical `YYYY-MM-DD[ HH:mm:ss]` storage form for a temporal column. */
function canonicalTemporalText(date: Date, type: ColumnType): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  if (type === 'time') return timePart;
  if (type === 'date') return datePart;
  return `${datePart} ${timePart}`;
}

/**
 * Normalize a pasted value against its destination column's type.
 *
 * This is the one place formatting touches what gets stored, so it stays
 * conservative: a value that does not parse is left exactly as pasted, and
 * formulas are never rewritten. What it does fix is the class of paste that
 * would otherwise land as dead text — `1/2/2026` into a datetime column,
 * `$1,200` into a currency column that formulas then cannot add up, or `50%`
 * into a percentage column that stores fractions and would render 5000%.
 */
export function normalizePastedValue(value: string, format: ColumnFormat | undefined): string {
  if (!format) return value;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('=')) return value;

  if (isTemporalColumnType(format.type)) {
    const parsed = parseDateTime(trimmed);
    return parsed === null ? value : canonicalTemporalText(parsed, format.type);
  }

  if (format.type === 'percentage') {
    const num = parseNumber(trimmed);
    if (num === null) return value;
    // A trailing % means the user pasted a whole percent; store it the way the
    // column says it stores values.
    const isWholePercent = trimmed.endsWith('%');
    if (format.valuesAreFractions === true && isWholePercent) return String(num / 100);
    if (format.valuesAreFractions === false && !isWholePercent && Math.abs(num) <= 1 && num !== 0) {
      return String(num * 100);
    }
    return isWholePercent ? String(num) : value;
  }

  if (format.type === 'number' || format.type === 'currency') {
    const num = parseNumber(trimmed);
    // Only rewrite when the text carried formatting; a bare number is already
    // stored the way we want it.
    if (num === null || /^-?\d*\.?\d+$/.test(trimmed)) return value;
    return String(num);
  }

  return value;
}
