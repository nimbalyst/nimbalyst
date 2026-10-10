/**
 * Reading cell text as typed values: numbers, dates and times, booleans,
 * hyperlinks, URLs and tracker references.
 */

import { localCalendarDate } from '../calendarDate';

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
export const TIME_PATTERN = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/;

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
    const base = localCalendarDate(Number(dateThenTime[1]), Number(dateThenTime[2]) - 1, Number(dateThenTime[3]));
    if (base === null || dateThenTime[4] === undefined) return base;
    return applyTimeParts(base, dateThenTime[4], dateThenTime[5], dateThenTime[6], dateThenTime[7]);
  }

  // US format: MM/DD/YYYY or M/D/YYYY, optionally with a time
  const usMatch = str.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/,
  );
  if (usMatch) {
    const base = localCalendarDate(Number(usMatch[3]), Number(usMatch[1]) - 1, Number(usMatch[2]));
    if (base === null || usMatch[4] === undefined) return base;
    return applyTimeParts(base, usMatch[4], usMatch[5], usMatch[6], usMatch[7]);
  }

  // European format: DD.MM.YYYY or D.M.YYYY, optionally with a time
  const euMatch = str.match(
    /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/,
  );
  if (euMatch) {
    const base = localCalendarDate(Number(euMatch[3]), Number(euMatch[2]) - 1, Number(euMatch[1]));
    if (base === null || euMatch[4] === undefined) return base;
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

export function decodeHyperlink(value: string): { href: string; label: string } | null {
  if (!value.startsWith(HYPERLINK_SENTINEL)) return null;
  const [label, href] = value.slice(HYPERLINK_SENTINEL.length).split('\x1f');
  if (!href) return null;
  return { href, label: label || href };
}

/** What a cell shows: a HYPERLINK result reads as its label, anything else as itself. */
export function shownValue<T>(value: T): T | string {
  return typeof value === 'string' ? (decodeHyperlink(value)?.label ?? value) : value;
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
