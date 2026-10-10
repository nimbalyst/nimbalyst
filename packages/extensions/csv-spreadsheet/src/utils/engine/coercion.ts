/**
 * Value coercion between formula results, cell values, and date serials.
 */

import type { CellValue } from '../../types';
import { parseTemporalStrict } from '../formatters';
import { FormulaEvaluationError } from './errors';
import type { EvaluationValue } from './types';

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * Which clock a formula.js `Date` should be read on.
 *
 * formula.js is not internally consistent about which midnight it means:
 * `DATE`, `TODAY`, and `EOMONTH` return *local* midnight, while `DATEVALUE`
 * returns *UTC* midnight. Reading either one with the wrong set of getters
 * shifts the day by one in most of the world. So a Date sitting exactly on UTC
 * midnight is read as a UTC-anchored calendar date, and anything else is read
 * in local time. The only value that lands on the wrong branch is an instant
 * that genuinely is UTC midnight, which then reads as a bare date — harmless.
 */
function isUtcMidnight(value: Date): boolean {
  return value.getUTCHours() === 0
    && value.getUTCMinutes() === 0
    && value.getUTCSeconds() === 0
    && value.getUTCMilliseconds() === 0;
}

/** The calendar fields of a Date, read on whichever clock it is anchored to. */
function dateFields(value: Date): { year: number; month: number; day: number; hours: number; minutes: number; seconds: number } {
  return isUtcMidnight(value)
    ? {
        year: value.getUTCFullYear(), month: value.getUTCMonth(), day: value.getUTCDate(),
        hours: 0, minutes: 0, seconds: 0,
      }
    : {
        year: value.getFullYear(), month: value.getMonth(), day: value.getDate(),
        hours: value.getHours(), minutes: value.getMinutes(), seconds: value.getSeconds(),
      };
}

const MILLIS_PER_DAY = 86400000;
/** Excel counts day 1 as 1900-01-01 but treats 1900 as a leap year, so day 0 is 1899-12-30. */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

/**
 * A Date as its spreadsheet serial number — days since 1899-12-30, with the
 * time of day as the fraction.
 *
 * This is what makes `=A1+7` and `=B1-A1` work: every spreadsheet models a date
 * as a number, so date arithmetic is just arithmetic. The serial round-trips,
 * because `parseDateTime` already reads serials back when a column is date
 * formatted. A result landing in an unformatted column shows the raw serial,
 * which is what Excel does with a General-formatted cell.
 *
 * Computed through `Date.UTC` on both sides so a DST boundary between the epoch
 * and the value cannot introduce a fractional day.
 */
export function dateToSerial(value: Date): number {
  const { year, month, day, hours, minutes, seconds } = dateFields(value);
  const days = (Date.UTC(year, month, day) - EXCEL_EPOCH_UTC) / MILLIS_PER_DAY;
  return days + (hours * 3600 + minutes * 60 + seconds) / 86400;
}

/**
 * A value as a numeric aggregate (MAX, SUM, ...) must see it: a formula's Date
 * and, in a date-typed column, strict date text become serials; anything else
 * passes through. Applied to the aggregate's arguments, never to the formula
 * cache, so text functions reading the same cell still see a date.
 */
export function aggregateDateValue(value: EvaluationValue, dateColumn: boolean): EvaluationValue {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? value : dateToSerial(value);
  if (!dateColumn || typeof value !== 'string' || value.trim() === '') return value;
  const temporal = parseTemporalStrict(value);
  return temporal === null ? value : dateToSerial(temporal);
}

/**
 * Serialize a formula's `Date` result.
 *
 * Results keep their time when they have one, so `=NOW()` can actually feed a
 * `datetime` column. The previous `toISOString().slice(0, 10)` truncated every
 * result to a date and made time-of-day unreachable.
 */
function formatDateResult(value: Date): string {
  const { year, month, day, hours, minutes, seconds } = dateFields(value);
  const datePart = `${year}-${pad2(month + 1)}-${pad2(day)}`;
  if (hours === 0 && minutes === 0 && seconds === 0) return datePart;
  return `${datePart} ${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
}

export function normalizeCellResult(value: EvaluationValue): CellValue {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FormulaEvaluationError('#VALUE!');
    return value;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDateResult(value);
  }
  throw new FormulaEvaluationError('#VALUE!');
}

export function toNumber(value: EvaluationValue): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null) return 0;
  // Dates are numbers in every spreadsheet, which is what makes `=A1+7` and
  // `=B1-A1` mean something. `compareValues` routes through here too, so date
  // comparisons order chronologically rather than falling back to text.
  if (value instanceof Date && !Number.isNaN(value.getTime())) return dateToSerial(value);
  if (typeof value === 'string') {
    if (value.trim() === '') return 0;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
    // A date column stores text, so reaching the serial requires parsing it.
    // Strictly: the loose parse would turn "March" into a number.
    const temporal = parseTemporalStrict(value);
    if (temporal !== null) return dateToSerial(temporal);
  }
  throw new FormulaEvaluationError('#VALUE!');
}

export function toText(value: EvaluationValue): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  // So `="Due "&TODAY()` reads as a date rather than erroring.
  if (value instanceof Date && !Number.isNaN(value.getTime())) return formatDateResult(value);
  throw new FormulaEvaluationError('#VALUE!');
}

export function toLogical(value: EvaluationValue): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  if (typeof value === 'string') {
    if (value.toUpperCase() === 'TRUE') return true;
    if (value.toUpperCase() === 'FALSE' || value === '') return false;
  }
  if (value === null) return false;
  throw new FormulaEvaluationError('#VALUE!');
}

export function compareValues(left: EvaluationValue, right: EvaluationValue): number {
  try {
    return toNumber(left) - toNumber(right);
  } catch {
    return toText(left).toLocaleLowerCase().localeCompare(toText(right).toLocaleLowerCase());
  }
}
