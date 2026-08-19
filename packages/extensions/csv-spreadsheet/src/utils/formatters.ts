/**
 * Cell value formatting utilities
 *
 * Provides functions to format cell values based on column type and format
 * settings. Everything here is display-only: the spreadsheet always serializes
 * `cell.raw`, so formatting never rewrites what lands on disk.
 */

import type {
  BooleanStyle,
  CellAlignment,
  ColumnFormat,
  ColumnType,
  CurrencyCode,
  DateFormat,
  NegativeStyle,
  NumberStyle,
  TimeFormat,
} from '../types';

/**
 * Currency symbols for supported currencies
 */
const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CNY: '¥',
};

/**
 * Currency locale mappings for Intl formatting
 */
const CURRENCY_LOCALES: Record<CurrencyCode, string> = {
  USD: 'en-US',
  EUR: 'de-DE',
  GBP: 'en-GB',
  JPY: 'ja-JP',
  CNY: 'zh-CN',
};

/**
 * Default column format (text, no special formatting)
 */
export const DEFAULT_COLUMN_FORMAT: ColumnFormat = {
  type: 'text',
};

/** Types whose values are fundamentally numeric. */
const NUMERIC_TYPES: ReadonlySet<ColumnType> = new Set<ColumnType>([
  'number',
  'currency',
  'percentage',
]);

/** Types whose values are fundamentally instants. */
const TEMPORAL_TYPES: ReadonlySet<ColumnType> = new Set<ColumnType>([
  'date',
  'datetime',
  'time',
]);

export function isNumericColumnType(type: ColumnType): boolean {
  return NUMERIC_TYPES.has(type);
}

export function isTemporalColumnType(type: ColumnType): boolean {
  return TEMPORAL_TYPES.has(type);
}

/**
 * Get a default format for a column type
 */
export function getDefaultFormatForType(type: ColumnType): ColumnFormat {
  switch (type) {
    case 'number':
      return { type: 'number', decimals: 2, showThousandsSeparator: true, numberStyle: 'standard', negativeStyle: 'minus' };
    case 'currency':
      return { type: 'currency', decimals: 2, showThousandsSeparator: true, currency: 'USD', numberStyle: 'standard', negativeStyle: 'minus' };
    case 'percentage':
      // Explicit rather than guessed: see the `valuesAreFractions` note on ColumnFormat.
      return { type: 'percentage', decimals: 1, valuesAreFractions: true, negativeStyle: 'minus' };
    case 'date':
      return { type: 'date', dateFormat: 'MM/DD/YYYY' };
    case 'datetime':
      return { type: 'datetime', dateFormat: 'MM/DD/YYYY', timeFormat: 'h:mm A' };
    case 'time':
      return { type: 'time', timeFormat: 'h:mm A' };
    case 'boolean':
      return { type: 'boolean', booleanStyle: 'true-false' };
    case 'url':
      return { type: 'url' };
    case 'tracker':
      return { type: 'tracker' };
    case 'text':
    default:
      return { type: 'text' };
  }
}

/**
 * A cell value that reads as a number, and so should sit against the right edge
 * of its column the way it does in every other spreadsheet.
 *
 * Deliberately stricter than {@link parseNumber}, which exists to coerce a value
 * a user has already declared numeric via a column format. Alignment is inferred
 * from the value alone, so it has to match the *whole* string: `parseFloat`
 * happily reads `2026-05-15` as `2026` (issue #329) and `12 apples` as `12`, and
 * right-aligning either of those would be wrong. Thousands separators, a
 * trailing percent and exponent notation are all still numbers.
 */
const NUMERIC_CELL_PATTERN = /^[-+]?(\d+|\d{1,3}(,\d{3})+)(\.\d+)?([eE][-+]?\d+)?%?$/;

export function isNumericCellValue(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed !== '' && NUMERIC_CELL_PATTERN.test(trimmed);
}

/**
 * Parse a value to a number, returning null if not a valid number.
 *
 * Exported because sorting and numeric filters need the same coercion the
 * formatter uses — a currency column holding `$1,200` has to compare as 1200,
 * not fail `Number(...)` and fall back to a string sort.
 */
export function parseNumber(value: string | number | null): number | null {
  if (value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  let text = value.trim();
  if (text === '') return null;

  // Accounting-style negatives: (1,200.00) means -1200.00
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  // Remove common formatting characters (currency symbols, commas, percent signs)
  const cleaned = text.replace(/[$€£¥,\s%]/g, '').trim();
  if (cleaned === '') return null;

  const num = parseFloat(cleaned);
  if (isNaN(num)) return null;
  return negative ? -num : num;
}

/** `HH:mm`, `H:mm:ss`, with an optional AM/PM suffix. */
const TIME_PATTERN = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/;

function applyTimeParts(
  base: Date,
  hourText: string,
  minuteText: string,
  secondText: string | undefined,
  meridiem: string | undefined,
): Date | null {
  let hours = parseInt(hourText, 10);
  const minutes = parseInt(minuteText, 10);
  const seconds = secondText === undefined ? 0 : parseInt(secondText, 10);

  if (meridiem) {
    const isPm = meridiem.toLowerCase() === 'pm';
    if (hours < 1 || hours > 12) return null;
    if (hours === 12) hours = 0;
    if (isPm) hours += 12;
  } else if (hours > 23) {
    return null;
  }

  if (minutes > 59 || seconds > 59) return null;

  const result = new Date(base);
  result.setHours(hours, minutes, seconds, 0);
  return result;
}

/**
 * Parse a value that is *unambiguously* a date, datetime, or time.
 *
 * Unlike {@link parseDateTime} this never falls back to `new Date(str)`, which
 * is far too permissive to use as a type test — it happily reads `"March"` and
 * `"Sat"` as dates. Formula arithmetic needs the strict version: coercing a
 * date cell to a number is right, but doing the same to the word "March" is
 * how `="March"+1` would silently become a number.
 *
 * Time-only values are anchored to the Unix epoch day so that `time` columns
 * still produce a real Date the pattern formatter can render.
 */
export function parseTemporalStrict(value: string | number | null): Date | null {
  if (value === null || value === '') return null;
  if (typeof value === 'number') {
    // Excel serial date number
    if (value > 0 && value < 2958466) {
      // Excel uses 1900-01-01 as day 1, but has a bug treating 1900 as a leap year
      const excelEpoch = new Date(1899, 11, 30);
      return new Date(excelEpoch.getTime() + value * 24 * 60 * 60 * 1000);
    }
    // Unix timestamp
    const fromEpoch = new Date(value);
    return isNaN(fromEpoch.getTime()) ? null : fromEpoch;
  }

  const str = value.trim();
  if (str === '') return null;

  // Time only: anchor to the epoch day.
  const timeOnly = str.match(TIME_PATTERN);
  if (timeOnly) {
    return applyTimeParts(new Date(1970, 0, 1), timeOnly[1], timeOnly[2], timeOnly[3], timeOnly[4]);
  }

  // ISO with an explicit zone or a `T` separator: let the platform handle the
  // offset rather than re-deriving it.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str)) {
    const parsed = new Date(str);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  // Date, optionally followed by a time. Constructed field-by-field in local
  // time so a bare `2026-05-15` does not shift a day in negative-offset zones.
  const dateThenTime = str.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/,
  );
  if (dateThenTime) {
    const base = new Date(
      parseInt(dateThenTime[1], 10),
      parseInt(dateThenTime[2], 10) - 1,
      parseInt(dateThenTime[3], 10),
    );
    if (dateThenTime[4] === undefined) return base;
    return applyTimeParts(base, dateThenTime[4], dateThenTime[5], dateThenTime[6], dateThenTime[7]);
  }

  // US format: MM/DD/YYYY or M/D/YYYY, optionally with a time
  const usMatch = str.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/,
  );
  if (usMatch) {
    const base = new Date(
      parseInt(usMatch[3], 10),
      parseInt(usMatch[1], 10) - 1,
      parseInt(usMatch[2], 10),
    );
    if (usMatch[4] === undefined) return base;
    return applyTimeParts(base, usMatch[4], usMatch[5], usMatch[6], usMatch[7]);
  }

  // European format: DD.MM.YYYY or D.M.YYYY, optionally with a time
  const euMatch = str.match(
    /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/,
  );
  if (euMatch) {
    const base = new Date(
      parseInt(euMatch[3], 10),
      parseInt(euMatch[2], 10) - 1,
      parseInt(euMatch[1], 10),
    );
    if (euMatch[4] === undefined) return base;
    return applyTimeParts(base, euMatch[4], euMatch[5], euMatch[6], euMatch[7]);
  }

  return null;
}

/**
 * Parse a date, datetime, or time-of-day value for *display*.
 *
 * Adds a permissive native-parse fallback on top of
 * {@link parseTemporalStrict}, so a column the user has explicitly declared
 * temporal still renders shapes we do not have a pattern for. Never use this as
 * a test for "is this a date" — see the note on the strict version.
 */
export function parseDateTime(value: string | number | null): Date | null {
  const strict = parseTemporalStrict(value);
  if (strict !== null) return strict;
  if (typeof value !== 'string') return null;

  const str = value.trim();
  if (str === '') return null;
  const parsed = new Date(str);
  return isNaN(parsed.getTime()) ? null : parsed;
}

const MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Tokens are matched by a single alternation so a substituted value can never
 * be re-matched — `MMM` yielding `May` must not then have its `M` replaced.
 * Longest tokens come first. `[...]` escapes a literal run.
 */
const PATTERN_TOKENS = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|A|a/g;

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Render a Date through a token pattern.
 *
 * Supported: `YYYY` `YY` `MMMM` `MMM` `MM` `M` `DD` `D` `dddd` `ddd`
 * `HH` `H` (24h) `hh` `h` (12h) `mm` `m` `ss` `s` `A` `a` (meridiem),
 * plus `[literal]` for text that should pass through untouched.
 */
export function formatWithPattern(date: Date, pattern: string): string {
  const hours24 = date.getHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;

  return pattern.replace(PATTERN_TOKENS, (token, literal: string | undefined) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case 'YYYY': return date.getFullYear().toString();
      case 'YY': return date.getFullYear().toString().slice(-2);
      case 'MMMM': return MONTH_NAMES_LONG[date.getMonth()];
      case 'MMM': return MONTH_NAMES_SHORT[date.getMonth()];
      case 'MM': return pad2(date.getMonth() + 1);
      case 'M': return (date.getMonth() + 1).toString();
      case 'DD': return pad2(date.getDate());
      case 'D': return date.getDate().toString();
      case 'dddd': return DAY_NAMES_LONG[date.getDay()];
      case 'ddd': return DAY_NAMES_SHORT[date.getDay()];
      case 'HH': return pad2(hours24);
      case 'H': return hours24.toString();
      case 'hh': return pad2(hours12);
      case 'h': return hours12.toString();
      case 'mm': return pad2(date.getMinutes());
      case 'm': return date.getMinutes().toString();
      case 'ss': return pad2(date.getSeconds());
      case 's': return date.getSeconds().toString();
      case 'A': return hours24 < 12 ? 'AM' : 'PM';
      case 'a': return hours24 < 12 ? 'am' : 'pm';
      default: return token;
    }
  });
}

/** The four named date presets expressed as patterns. */
function datePatternFor(format: DateFormat): string {
  switch (format) {
    case 'DD/MM/YYYY': return 'DD/MM/YYYY';
    case 'YYYY-MM-DD': return 'YYYY-MM-DD';
    case 'MMM D, YYYY': return 'MMM D, YYYY';
    case 'MM/DD/YYYY':
    default:
      return 'MM/DD/YYYY';
  }
}

/** The named time presets expressed as patterns. */
function timePatternFor(format: TimeFormat): string {
  switch (format) {
    case 'h:mm:ss A': return 'h:mm:ss A';
    case 'HH:mm': return 'HH:mm';
    case 'HH:mm:ss': return 'HH:mm:ss';
    case 'h:mm A':
    default:
      return 'h:mm A';
  }
}

/**
 * Resolve the effective pattern for a temporal column — the custom pattern when
 * one is set, otherwise the named presets for the column's type.
 */
export function resolveTemporalPattern(format: ColumnFormat): string {
  if (format.pattern) return format.pattern;
  const datePart = datePatternFor(format.dateFormat ?? 'MM/DD/YYYY');
  const timePart = timePatternFor(format.timeFormat ?? 'h:mm A');
  switch (format.type) {
    case 'time': return timePart;
    case 'datetime': return `${datePart} ${timePart}`;
    case 'date':
    default:
      return datePart;
  }
}

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

/** Truthy/falsy spellings a boolean column accepts. */
const BOOLEAN_TRUE = new Set(['true', 't', 'yes', 'y', '1', '✓', 'x']);
const BOOLEAN_FALSE = new Set(['false', 'f', 'no', 'n', '0', '✗', '']);

/**
 * Coerce a cell value to a boolean, or null when it is not a recognized
 * spelling (in which case the cell renders as plain text).
 */
export function parseBoolean(value: string | number | null): boolean | null {
  if (value === null) return null;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return null;
  if (BOOLEAN_TRUE.has(normalized)) return true;
  if (BOOLEAN_FALSE.has(normalized)) return false;
  return null;
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
 * Sentinel encoding for `=HYPERLINK(url, label)` results.
 *
 * The formula engine has nowhere to put a label alongside a URL — a computed
 * cell value is `string | number | null`. This packs both into one string using
 * the repo's standard `\x1f` separator. It only ever exists in memory: the
 * spreadsheet serializes `cell.raw` (the `=HYPERLINK(...)` text), so the
 * sentinel never reaches disk.
 */
const HYPERLINK_SENTINEL = '\x1fHYPERLINK\x1f';

export function encodeHyperlink(url: string, label: string): string {
  return `${HYPERLINK_SENTINEL}${label}\x1f${url}`;
}

function decodeHyperlink(value: string): { href: string; label: string } | null {
  if (!value.startsWith(HYPERLINK_SENTINEL)) return null;
  const [label, href] = value.slice(HYPERLINK_SENTINEL.length).split('\x1f');
  if (!href) return null;
  return { href, label: label || href };
}

/** A URL cell that should render as a clickable link. */
export interface UrlCell {
  href: string;
  label: string;
}

const URL_PATTERN = /^(https?:\/\/|mailto:)\S+$/i;
const BARE_WWW_PATTERN = /^www\.\S+\.\S+$/i;

/**
 * Resolve a cell value to a link, or null when it is not one.
 *
 * Deliberately conservative: a `url` column holding a note rather than a link
 * renders as plain text instead of as a dead link.
 */
export function parseUrlCell(value: string | number | null): UrlCell | null {
  if (typeof value !== 'string') return null;
  const hyperlink = decodeHyperlink(value);
  if (hyperlink) return hyperlink;

  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (URL_PATTERN.test(trimmed)) return { href: trimmed, label: trimmed };
  if (BARE_WWW_PATTERN.test(trimmed)) return { href: `https://${trimmed}`, label: trimmed };
  return null;
}

const TRACKER_URN_PREFIX = 'nimbalyst://';
const TRACKER_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/**
 * Resolve a cell value to a tracker reference key (`NIM-123`), or null.
 *
 * Accepts a bare key or a `nimbalyst://NIM-123` URN. The key is what the file
 * stores, so a spreadsheet of tracker items stays readable in `git diff` and in
 * any other tool.
 */
export function parseTrackerCell(value: string | number | null): string | null {
  if (typeof value !== 'string') return null;
  let trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.toLowerCase().startsWith(TRACKER_URN_PREFIX)) {
    trimmed = trimmed.slice(TRACKER_URN_PREFIX.length);
  }
  return TRACKER_KEY_PATTERN.test(trimmed) ? trimmed.toUpperCase() : null;
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

/**
 * Format a cell value according to the column format
 *
 * @param value The raw or computed cell value
 * @param format The column format configuration
 * @returns The formatted string for display
 */
export function formatCellValue(value: string | number | null, format: ColumnFormat): string {
  if (value === null || value === '') return '';

  switch (format.type) {
    case 'text':
      // A HYPERLINK result in a non-url column still reads as its label.
      return typeof value === 'string'
        ? (decodeHyperlink(value)?.label ?? value)
        : String(value);

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

/**
 * Check if a value looks like a specific column type
 * Used for auto-detection of column types
 */
export function detectValueType(value: string): ColumnType {
  if (value === null || value === '') return 'text';

  const trimmed = value.trim();

  // Check for currency
  if (/^-?[$€£¥][\d,]+(\.\d+)?$/.test(trimmed)) {
    return 'currency';
  }

  // Check for percentage
  if (/^-?\d+(\.\d+)?%$/.test(trimmed)) {
    return 'percentage';
  }

  if (parseTrackerCell(trimmed) !== null) {
    return 'tracker';
  }

  if (parseUrlCell(trimmed) !== null) {
    return 'url';
  }

  // Date-with-time before date, so a datetime is not truncated to a date.
  if (/^\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}/.test(trimmed) ||
      /^\d{1,2}\/\d{1,2}\/\d{4}[ T]\d{1,2}:\d{2}/.test(trimmed)) {
    return 'datetime';
  }

  // Check for date patterns
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(trimmed) ||
      /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(trimmed) ||
      /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(trimmed)) {
    return 'date';
  }

  if (TIME_PATTERN.test(trimmed)) {
    return 'time';
  }

  // Check for number
  if (/^-?[\d,]+(\.\d+)?$/.test(trimmed)) {
    return 'number';
  }

  // Only unambiguous boolean spellings count; a column of "1"/"0" is a number.
  if (/^(true|false|yes|no)$/i.test(trimmed)) {
    return 'boolean';
  }

  return 'text';
}

/**
 * Infer a column's type from its values.
 *
 * Blanks are ignored, and a column only takes a type when every non-blank
 * sample agrees — mixed data stays text rather than getting a format that is
 * wrong for some of its rows.
 */
export function detectColumnType(values: readonly (string | number | null)[]): ColumnType {
  let detected: ColumnType | null = null;

  for (const value of values) {
    if (value === null) continue;
    const text = String(value).trim();
    if (text === '') continue;

    const type = detectValueType(text);
    if (detected === null) {
      detected = type;
    } else if (detected !== type) {
      return 'text';
    }
  }

  return detected ?? 'text';
}

/**
 * The default alignment for a column type, used when no explicit override is set.
 */
export function getDefaultAlignmentForType(type: ColumnType): CellAlignment | null {
  if (isNumericColumnType(type)) return 'right';
  if (isTemporalColumnType(type)) return 'right';
  if (type === 'boolean') return 'center';
  return null;
}

/**
 * Get display name for a column type
 */
export function getColumnTypeName(type: ColumnType): string {
  switch (type) {
    case 'text': return 'Text';
    case 'number': return 'Number';
    case 'currency': return 'Currency';
    case 'percentage': return 'Percentage';
    case 'date': return 'Date';
    case 'datetime': return 'Date & time';
    case 'time': return 'Time';
    case 'boolean': return 'Checkbox';
    case 'url': return 'Link';
    case 'tracker': return 'Tracker item';
    default: return 'Text';
  }
}

/**
 * Get display name for a currency code
 */
export function getCurrencyName(currency: CurrencyCode): string {
  switch (currency) {
    case 'USD':
      return 'US Dollar ($)';
    case 'EUR':
      return 'Euro (€)';
    case 'GBP':
      return 'British Pound (£)';
    case 'JPY':
      return 'Japanese Yen (¥)';
    case 'CNY':
      return 'Chinese Yuan (¥)';
    default:
      return currency;
  }
}

/**
 * Get display name for a date format
 */
export function getDateFormatName(format: DateFormat): string {
  switch (format) {
    case 'MM/DD/YYYY':
      return 'MM/DD/YYYY (US)';
    case 'DD/MM/YYYY':
      return 'DD/MM/YYYY (EU)';
    case 'YYYY-MM-DD':
      return 'YYYY-MM-DD (ISO)';
    case 'MMM D, YYYY':
      return 'MMM D, YYYY (Long)';
    default:
      return format;
  }
}

/**
 * Get display name for a time format
 */
export function getTimeFormatName(format: TimeFormat): string {
  switch (format) {
    case 'h:mm A': return '1:30 PM';
    case 'h:mm:ss A': return '1:30:00 PM';
    case 'HH:mm': return '13:30';
    case 'HH:mm:ss': return '13:30:00';
    default: return format;
  }
}

/**
 * Get display name for a number style
 */
export function getNumberStyleName(style: NumberStyle): string {
  switch (style) {
    case 'standard': return 'Standard (1,234.57)';
    case 'plain': return 'Plain (1234.567)';
    case 'scientific': return 'Scientific (1.23E+03)';
    case 'accounting': return 'Accounting ($ 1,234.57)';
    default: return style;
  }
}

/**
 * Get display name for a negative style
 */
export function getNegativeStyleName(style: NegativeStyle): string {
  switch (style) {
    case 'minus': return '-1,234.57';
    case 'parens': return '(1,234.57)';
    case 'red': return '-1,234.57 in red';
    case 'parens-red': return '(1,234.57) in red';
    default: return style;
  }
}

/**
 * Get display name for a boolean style
 */
export function getBooleanStyleName(style: BooleanStyle): string {
  switch (style) {
    case 'true-false': return 'TRUE / FALSE';
    case 'yes-no': return 'Yes / No';
    case 'check': return 'Checkmark';
    default: return style;
  }
}
