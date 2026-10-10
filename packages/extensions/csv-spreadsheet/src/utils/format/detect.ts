/**
 * Column type detection from sample values.
 */

import type { ColumnType } from '../../types';
import { TIME_PATTERN, parseTrackerCell, parseUrlCell } from './parse';

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
