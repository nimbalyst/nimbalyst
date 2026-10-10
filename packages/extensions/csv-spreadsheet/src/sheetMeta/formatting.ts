/**
 * Phase 3 formatting and layout metadata: the fields the `# nimbalyst:` line
 * carries beyond headers, frozen columns, column formats, widths and styles.
 *
 * This module is the one definition of those fields. The file reader
 * (`formattingFromFile`), the file writer (`formattingForFile`, called by the
 * single `buildMetadataLine`), structural edits (`shiftFormatting`) and the
 * collab map (`collab/metaBinding.ts`) all go through `FORMATTING_KEYS`, so a
 * field added here cannot be written by one path and dropped by another.
 *
 * Coordinates follow the existing conventions: per-row data is keyed by
 * zero-based row index counted from the first row of the file *including
 * header rows*; per-column data by zero-based column index; anything covering
 * cells by an A1 range key (`B2`, `A1:C10`), later entries winning on overlap.
 *
 * Every field is optional in the file. A file written before a field existed
 * loads with its default, and an older build that does not know a field
 * ignores it. Merged cells are deliberately absent: per D1 they belong to the
 * workbook format, and RevoGrid cannot edit or select a span (see the Phase 3
 * merges spike).
 */

import type { CellColor, ColumnFormat, HexColor } from '../types';
import type { ConditionalFormat } from '../conditional/types';
import type { ValidationRules } from '../validation/types';
import { shiftConditionalFormatsForStructuralEdit } from '../conditional/shift';
import { shiftRangeKeys, shiftRangeRecord } from '../conditional/rangeKeys';
import { editAxis, mapIndex, mapLeadingCount, type StructuralEdit } from '../structure/structuralEdit';
import { rangeNameError, shiftNamedRanges } from './namedRanges';

export type BorderLineStyle = 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double';

export interface BorderSide {
  style: BorderLineStyle;
  color?: CellColor | HexColor;
}

/**
 * Borders for a range. `top`/`bottom`/`left`/`right` draw on the range's
 * perimeter; `innerHorizontal` / `innerVertical` between its cells. An absent
 * side is no border; `null` clears a side an earlier entry set.
 */
export interface RangeBorders {
  top?: BorderSide | null;
  bottom?: BorderSide | null;
  left?: BorderSide | null;
  right?: BorderSide | null;
  innerHorizontal?: BorderSide | null;
  innerVertical?: BorderSide | null;
}

export interface SheetFormatting {
  /** Per-cell number formats keyed by A1 range; override `columnFormats`. */
  cellFormats: Record<string, ColumnFormat>;
  /** Ordered conditional formats; the first that applies to a cell wins. */
  conditionalFormats: ConditionalFormat[];
  /** Validation rules keyed by A1 range; later entries win. */
  validation: ValidationRules;
  /** Row heights in pixels for rows the user sized, keyed by row index. */
  rowHeights: Record<number, number>;
  /** Hidden row indexes, ascending. */
  hiddenRows: number[];
  /** Hidden column indexes, ascending. */
  hiddenCols: number[];
  /** Data rows frozen below the header rows, independent of `headerRowCount`. */
  frozenRowCount: number;
  /** A1 range keys whose text wraps; everything else clips. */
  wrap: string[];
  /** Borders keyed by A1 range; later entries win per side. */
  borders: Record<string, RangeBorders>;
  /** Named ranges: name -> A1 range key, or `#REF!` (see `namedRanges.ts`). */
  namedRanges: Record<string, string>;
}

/** Field order is the order they are written to the file. */
export const FORMATTING_KEYS = [
  'cellFormats',
  'conditionalFormats',
  'validation',
  'rowHeights',
  'hiddenRows',
  'hiddenCols',
  'frozenRowCount',
  'wrap',
  'borders',
  'namedRanges',
] as const satisfies readonly (keyof SheetFormatting)[];

export type FormattingKey = typeof FORMATTING_KEYS[number];

export const EMPTY_FORMATTING: Readonly<SheetFormatting> = Object.freeze({
  cellFormats: {},
  conditionalFormats: [],
  validation: {},
  rowHeights: {},
  hiddenRows: [],
  hiddenCols: [],
  frozenRowCount: 0,
  wrap: [],
  borders: {},
  namedRanges: {},
});

export const MIN_ROW_HEIGHT = 16;
export const MAX_ROW_HEIGHT = 2000;

// ---- reading -----------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function recordOf<T>(value: unknown, keep: (entry: unknown) => entry is T): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) if (keep(entry)) out[key] = entry;
  return out;
}

function indexRecordOf(value: unknown, keep: (entry: unknown) => boolean): Record<number, number> {
  const out: Record<number, number> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0 && keep(entry)) out[index] = entry as number;
  }
  return out;
}

function indexListOf(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const indexes = value.filter((entry): entry is number => Number.isInteger(entry) && entry >= 0);
  return [...new Set(indexes)].sort((a, b) => a - b);
}

const isColumnFormat = (entry: unknown): entry is ColumnFormat => isRecord(entry) && typeof entry.type === 'string';
const isRowHeight = (entry: unknown) =>
  typeof entry === 'number' && Number.isFinite(entry) && entry >= MIN_ROW_HEIGHT && entry <= MAX_ROW_HEIGHT;
const isConditionalFormat = (entry: unknown): entry is ConditionalFormat =>
  isRecord(entry) && typeof entry.id === 'string' && Array.isArray(entry.ranges)
  && entry.ranges.every((range) => typeof range === 'string') && isRecord(entry.rule) && typeof entry.rule.kind === 'string';
const isValidationRule = (entry: unknown): entry is ValidationRules[string] =>
  isRecord(entry) && typeof entry.kind === 'string' && (entry.mode === 'reject' || entry.mode === 'warn');
const isBorders = (entry: unknown): entry is RangeBorders => isRecord(entry);

/**
 * Formatting from a parsed metadata object (or null for a file without one).
 * Malformed entries are dropped rather than failing the load: a hand-edited
 * line should cost the broken entry, not the whole file's formatting.
 */
export function formattingFromFile(meta: unknown): SheetFormatting {
  if (!isRecord(meta)) return { ...EMPTY_FORMATTING };
  const frozen = meta.frozenRowCount;
  return {
    cellFormats: recordOf(meta.cellFormats, isColumnFormat),
    conditionalFormats: Array.isArray(meta.conditionalFormats) ? meta.conditionalFormats.filter(isConditionalFormat) : [],
    validation: recordOf(meta.validation, isValidationRule),
    rowHeights: indexRecordOf(meta.rowHeights, isRowHeight),
    hiddenRows: indexListOf(meta.hiddenRows),
    hiddenCols: indexListOf(meta.hiddenCols),
    frozenRowCount: Number.isInteger(frozen) && (frozen as number) > 0 ? frozen as number : 0,
    wrap: Array.isArray(meta.wrap) ? [...new Set(meta.wrap.filter((key): key is string => typeof key === 'string'))] : [],
    borders: recordOf(meta.borders, isBorders),
    namedRanges: namedRangesOf(meta.namedRanges),
  };
}

/** Valid names with string targets; a duplicate spelling of a name keeps the first. */
function namedRangesOf(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, range] of Object.entries(recordOf(value, (entry): entry is string => typeof entry === 'string'))) {
    if (rangeNameError(name, out) === null) out[name] = range;
  }
  return out;
}

// ---- writing -----------------------------------------------------------------

function isEmptyField(value: unknown): boolean {
  if (value === undefined || value === null || value === 0) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** The non-default formatting fields, in file order, for the metadata line. */
export function formattingForFile(formatting: Partial<SheetFormatting>): Partial<SheetFormatting> {
  const out: Record<string, unknown> = {};
  for (const key of FORMATTING_KEYS) {
    const value = formatting[key];
    if (!isEmptyField(value)) out[key] = value;
  }
  return out as Partial<SheetFormatting>;
}

export function pickFormatting(source: Partial<SheetFormatting>): SheetFormatting {
  const out = { ...EMPTY_FORMATTING } as Record<string, unknown>;
  for (const key of FORMATTING_KEYS) if (source[key] !== undefined) out[key] = source[key];
  return out as unknown as SheetFormatting;
}

// ---- structural edits ----------------------------------------------------------

function remapIndexRecord<T>(record: Readonly<Record<number, T>>, edit: StructuralEdit): Record<number, T> {
  const next: Record<number, T> = {};
  for (const [key, value] of Object.entries(record)) {
    const mapped = mapIndex(Number(key), edit);
    if (mapped !== null) next[mapped] = value;
  }
  return next;
}

function remapIndexList(list: readonly number[], edit: StructuralEdit): number[] {
  const next: number[] = [];
  for (const index of list) {
    const mapped = mapIndex(index, edit);
    if (mapped !== null) next.push(mapped);
  }
  return [...new Set(next)].sort((a, b) => a - b);
}

/**
 * Formatting rewritten for a structural edit, following cells the way
 * `cellStyles` does. `headerRowCount` / `nextHeaderRowCount` are the header
 * counts before and after the edit: frozen rows sit below the header, so the
 * pinned block is shifted as a whole and the header's share is taken back out.
 * Fields the edit cannot affect keep their identity.
 */
export function shiftFormatting(
  formatting: SheetFormatting,
  edit: StructuralEdit,
  headerRowCount: number,
  nextHeaderRowCount: number,
): SheetFormatting {
  const rowAxis = editAxis(edit) === 'row';
  const pinned = headerRowCount + formatting.frozenRowCount;
  return {
    cellFormats: shiftRangeRecord(formatting.cellFormats, edit),
    conditionalFormats: shiftConditionalFormatsForStructuralEdit(formatting.conditionalFormats, edit),
    validation: shiftRangeRecord(formatting.validation, edit),
    rowHeights: rowAxis ? remapIndexRecord(formatting.rowHeights, edit) : formatting.rowHeights,
    hiddenRows: rowAxis ? remapIndexList(formatting.hiddenRows, edit) : formatting.hiddenRows,
    hiddenCols: rowAxis ? formatting.hiddenCols : remapIndexList(formatting.hiddenCols, edit),
    frozenRowCount: rowAxis && formatting.frozenRowCount > 0
      ? Math.max(0, mapLeadingCount(pinned, edit) - nextHeaderRowCount)
      : formatting.frozenRowCount,
    wrap: shiftRangeKeys(formatting.wrap, edit),
    borders: shiftRangeRecord(formatting.borders, edit, true),
    namedRanges: shiftNamedRanges(formatting.namedRanges, edit),
  };
}

/** Rows pinned at the top of the grid: the header rows plus the frozen data rows. */
export function pinnedRowCount(meta: { headerRowCount: number; frozenRowCount?: number }): number {
  return meta.headerRowCount + (meta.frozenRowCount ?? 0);
}

/**
 * The header count behind a grid whose pinned section holds `pinnedLength`
 * rows. Metadata wins whenever the grid agrees with it, including when the
 * grid pinned fewer rows because nothing below them is populated (freezing
 * through blank rows past the data): the counts are the user's settings, not
 * a measure of the rows. Only a grid that pins more rows, or pins fewer with
 * data below, is ahead of metadata, and then the frozen count stands and the
 * header count gives way.
 */
export function headerRowCountForPinned(
  meta: { headerRowCount: number; frozenRowCount?: number },
  pinnedLength: number,
  populatedBelow: boolean,
): number {
  const pinned = pinnedRowCount(meta);
  if (pinnedLength === pinned || (pinnedLength < pinned && !populatedBelow)) return meta.headerRowCount;
  return Math.max(0, pinnedLength - (meta.frozenRowCount ?? 0));
}
