/**
 * Fill-handle series detection.
 *
 * Given the raw values of the source cells along the fill axis and how many
 * cells to fill, produce the raw values for the new cells. Recognized series,
 * tried in this order, each requiring every source cell to match:
 *
 * - Numbers: one sample repeats (Sheets' default) unless `incrementSingleNumber`
 *   (Sheets' Ctrl/Option-drag) counts up by 1. Two or more continue the linear
 *   trend: the exact step when the samples are evenly spaced, otherwise a
 *   least-squares fit.
 * - Dates (`2026-01-31`, `1/31/2026`, `31.1.2026`, all samples in one shape):
 *   one sample steps by a day. Samples on the same day of month (or all on the
 *   last day) step by whole months; otherwise an even day spacing continues.
 * - Weekday and month names, full or short, keeping the case of the first
 *   sample (`MON` -> `TUE`). Wraps around.
 * - Text ending in a number with a shared prefix (`Item 1` -> `Item 2`,
 *   `Q09` -> `Q10`). Counts by absolute value, so filling up past zero turns
 *   back upward, as in Excel.
 *
 * Anything else repeats the source pattern; formulas in it are shifted by
 * their distance from the source cell they were copied from.
 *
 * Datetimes with a time part are not a series and repeat. The date shapes are
 * matched here rather than via `parseTemporalStrict` because the output must be
 * written back in the shape (and zero-padding) the user typed.
 */

import { shiftFormulaRelative } from '../structure/rewriteFormula';

export type FillDirection = 'down' | 'up' | 'right' | 'left';

export interface FillOptions {
  direction: FillDirection;
  /** A single number counts up instead of repeating (Sheets' modifier-drag). */
  incrementSingleNumber?: boolean;
  /**
   * Sheet positions of the source cells and of the filled cells (outward
   * order). A filter hides rows between them, so a repeated formula shifts by
   * the real distance rather than by its place in the series.
   */
  positions?: { readonly source: readonly number[]; readonly target: readonly number[] };
}

/** Value at position `p` along the axis (the source occupies `0 .. n - 1`) for filled cell `k`. */
type Series = (p: number, k: number) => string;

/**
 * Fill `length` cells beyond `source`.
 *
 * `source` is in sheet order (top to bottom, or left to right) whatever the
 * direction. The result is ordered outward from the source: `result[0]` is the
 * cell adjacent to the source (below it for `down`, above it for `up`).
 */
export function fillSeries(source: readonly string[], length: number, options: FillOptions): string[] {
  if (length <= 0 || source.length === 0) return [];
  const backward = options.direction === 'up' || options.direction === 'left';
  const series = detectSeries(source, options) ?? repeatPattern(source, options);
  return Array.from({ length }, (_, k) => series(backward ? -(k + 1) : source.length + k, k));
}

function detectSeries(source: readonly string[], options: FillOptions): Series | null {
  const values = source.map((value) => value.trim());
  if (values.some((value) => value === '' || value.startsWith('='))) return null;
  return numberSeries(values, options.incrementSingleNumber ?? false)
    ?? dateSeries(values)
    ?? nameSeries(values)
    ?? textNumberSeries(values);
}

function repeatPattern(source: readonly string[], { direction, positions }: FillOptions): Series {
  const vertical = direction === 'up' || direction === 'down';
  return (p, k) => {
    const index = mod(p, source.length);
    const value = source[index];
    if (!value.trimStart().startsWith('=')) return value;
    const target = positions?.target[k];
    const from = positions?.source[index];
    const distance = target === undefined || from === undefined ? p - index : target - from;
    return vertical ? shiftFormulaRelative(value, distance, 0) : shiftFormulaRelative(value, 0, distance);
  };
}

function mod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/** Constant difference between consecutive samples, or null. */
function constantStep(values: readonly number[], tolerance = 0): number | null {
  if (values.length < 2) return null;
  const step = values[1] - values[0];
  for (let i = 2; i < values.length; i += 1) {
    if (Math.abs(values[i] - values[i - 1] - step) > tolerance) return null;
  }
  return step;
}

// ---- Numbers ---------------------------------------------------------------

/** Same full-string numeric test `createCell` uses. */
const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/** Decimal places the user typed, or null for exponent notation (`1e-12`). */
function decimalPlaces(text: string): number | null {
  if (/[eE]/.test(text)) return null;
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * Round away float noise (`0.1 + 0.2`). With typed decimals the output keeps
 * that precision; otherwise it keeps 12 significant digits, so a step of
 * `1e-12` is not rounded to zero the way fixed decimal places would.
 */
function formatNumber(value: number, decimals: number | null): string {
  const rounded = decimals === null
    ? Number(value.toPrecision(12))
    : Number(value.toFixed(Math.min(decimals, 15)));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function numberSeries(values: readonly string[], incrementSingle: boolean): Series | null {
  if (!values.every((value) => NUMERIC.test(value))) return null;
  const numbers = values.map(Number);
  const places = values.map(decimalPlaces);
  const decimals = places.some((place) => place === null) ? null : Math.max(...(places as number[]));

  if (numbers.length === 1) {
    // A recognized number repeats. Returning null here would let the
    // text-with-a-number series read `1.5` as `1.` + 5 and `-5` as `-` + 5.
    const [only] = values;
    return incrementSingle ? (p) => formatNumber(numbers[0] + p, decimals) : () => only;
  }

  // Relative tolerance: a floor of 1 made every sub-1e-12 series look evenly spaced.
  const scale = Math.max(...numbers.map(Math.abs));
  const step = constantStep(numbers, scale * 1e-12);
  if (step !== null) return (p) => formatNumber(numbers[0] + step * p, decimals);

  const n = numbers.length;
  const meanX = (n - 1) / 2;
  const meanY = numbers.reduce((sum, y) => sum + y, 0) / n;
  let numerator = 0;
  let denominator = 0;
  numbers.forEach((y, x) => {
    numerator += (x - meanX) * (y - meanY);
    denominator += (x - meanX) ** 2;
  });
  const slope = numerator / denominator;
  return (p) => formatNumber(meanY + slope * (p - meanX), decimals === null ? null : 10);
}

// ---- Dates -----------------------------------------------------------------

type DateShape = 'iso' | 'us' | 'eu';

interface ParsedDate {
  shape: DateShape;
  year: number;
  month: number;
  day: number;
  monthText: string;
  dayText: string;
}

const DATE_SHAPES: { shape: DateShape; pattern: RegExp; order: ['year' | 'month' | 'day', 'year' | 'month' | 'day', 'year' | 'month' | 'day'] }[] = [
  { shape: 'iso', pattern: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, order: ['year', 'month', 'day'] },
  { shape: 'us', pattern: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, order: ['month', 'day', 'year'] },
  { shape: 'eu', pattern: /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, order: ['day', 'month', 'year'] },
];

const DAY_MS = 86_400_000;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function parseDate(text: string): ParsedDate | null {
  for (const { shape, pattern, order } of DATE_SHAPES) {
    const match = pattern.exec(text);
    if (!match) continue;
    const parts = { year: '', month: '', day: '' };
    order.forEach((part, i) => { parts[part] = match[i + 1]; });
    const year = Number(parts.year);
    const month = Number(parts.month) - 1;
    const day = Number(parts.day);
    if (month < 0 || month > 11 || day < 1 || day > daysInMonth(year, month)) return null;
    return { shape, year, month, day, monthText: parts.month, dayText: parts.day };
  }
  return null;
}

function dateSeries(values: readonly string[]): Series | null {
  const dates = values.map(parseDate);
  if (dates.some((date) => date === null)) return null;
  const parsed = dates as ParsedDate[];
  const { shape } = parsed[0];
  if (parsed.some((date) => date.shape !== shape)) return null;

  // Keep zero-padding when the user typed it.
  const padMonth = parsed.some((date) => date.monthText.length === 2 && date.monthText.startsWith('0'))
    || (shape === 'iso' && parsed[0].monthText.length === 2);
  const padDay = parsed.some((date) => date.dayText.length === 2 && date.dayText.startsWith('0'))
    || (shape === 'iso' && parsed[0].dayText.length === 2);
  const format = (date: Date): string => {
    const year = String(date.getUTCFullYear());
    const month = String(date.getUTCMonth() + 1).padStart(padMonth ? 2 : 1, '0');
    const day = String(date.getUTCDate()).padStart(padDay ? 2 : 1, '0');
    if (shape === 'iso') return `${year}-${month}-${day}`;
    if (shape === 'us') return `${month}/${day}/${year}`;
    return `${day}.${month}.${year}`;
  };

  const serials = parsed.map((date) => Date.UTC(date.year, date.month, date.day) / DAY_MS);
  if (parsed.length === 1) return (p) => format(new Date((serials[0] + p) * DAY_MS));

  const monthIndexes = parsed.map((date) => date.year * 12 + date.month);
  const monthStep = constantStep(monthIndexes);
  const sameDay = parsed.every((date) => date.day === parsed[0].day);
  const endOfMonth = parsed.every((date) => date.day === daysInMonth(date.year, date.month));
  if (monthStep !== null && monthStep !== 0 && (sameDay || endOfMonth)) {
    return (p) => {
      const target = monthIndexes[0] + monthStep * p;
      const year = Math.floor(target / 12);
      const month = mod(target, 12);
      const last = daysInMonth(year, month);
      return format(new Date(Date.UTC(year, month, endOfMonth ? last : Math.min(parsed[0].day, last))));
    };
  }

  const dayStep = constantStep(serials);
  if (dayStep === null) return null;
  return (p) => format(new Date((serials[0] + dayStep * p) * DAY_MS));
}

// ---- Weekday and month names -----------------------------------------------

const NAME_LISTS: readonly (readonly string[])[] = [
  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
];

function applyCase(name: string, sample: string): string {
  if (sample === sample.toUpperCase()) return name.toUpperCase();
  if (sample === sample.toLowerCase()) return name.toLowerCase();
  return name;
}

function nameSeries(values: readonly string[]): Series | null {
  for (const list of NAME_LISTS) {
    const lower = list.map((name) => name.toLowerCase());
    const indexes = values.map((value) => lower.indexOf(value.toLowerCase()));
    if (indexes.some((index) => index === -1)) continue;

    let step = 1;
    if (indexes.length > 1) {
      const steps = indexes.slice(1).map((index, i) => mod(index - indexes[i], list.length));
      if (steps.some((s) => s !== steps[0])) return null;
      step = steps[0];
    }
    return (p) => applyCase(list[mod(indexes[0] + step * p, list.length)], values[0]);
  }
  return null;
}

// ---- Text ending in a number -----------------------------------------------

const TEXT_NUMBER = /^(.*\D)(\d{1,15})$/;

function textNumberSeries(values: readonly string[]): Series | null {
  const matches = values.map((value) => TEXT_NUMBER.exec(value));
  if (matches.some((match) => match === null)) return null;
  const parts = matches as RegExpExecArray[];
  const prefix = parts[0][1];
  if (parts.some((match) => match[1] !== prefix)) return null;

  const numbers = parts.map((match) => Number(match[2]));
  const step = numbers.length === 1 ? 1 : constantStep(numbers);
  if (step === null) return null;
  const firstDigits = parts[0][2];
  const width = firstDigits.length > 1 && firstDigits.startsWith('0') ? firstDigits.length : 1;
  return (p) => `${prefix}${String(Math.abs(numbers[0] + step * p)).padStart(width, '0')}`;
}
