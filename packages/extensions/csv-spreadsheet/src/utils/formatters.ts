/**
 * Cell value formatting utilities
 *
 * Provides functions to format cell values based on column type and format
 * settings. Everything here is display-only: the spreadsheet always serializes
 * `cell.raw`, so formatting never rewrites what lands on disk.
 *
 * This module is the public surface; the implementation lives in `./format/`:
 * column types and names, parsing, date/time patterns, display, detection.
 */

export {
  DEFAULT_COLUMN_FORMAT,
  getBooleanStyleName,
  getColumnTypeName,
  getCurrencyName,
  getDateFormatName,
  getDefaultAlignmentForType,
  getDefaultFormatForType,
  getNegativeStyleName,
  getNumberStyleName,
  getTimeFormatName,
  isNumericColumnType,
  isTemporalColumnType,
} from './format/columnTypes';
export {
  encodeHyperlink,
  isNumericCellValue,
  parseBoolean,
  parseDateTime,
  parseNumber,
  parseTemporalStrict,
  parseTrackerCell,
  parseUrlCell,
  shownValue,
  type UrlCell,
} from './format/parse';
export { formatWithPattern, resolveTemporalPattern } from './format/temporalPattern';
export {
  cellDisplayText,
  formatCellValue,
  getSortKey,
  isNegativeFormattedValue,
  normalizePastedValue,
  usesRedNegatives,
} from './format/display';
export { detectColumnType, detectValueType } from './format/detect';
