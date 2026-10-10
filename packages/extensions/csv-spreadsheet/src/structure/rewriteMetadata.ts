/**
 * Rewrite sheet metadata for a structural edit, so formats, widths, styles and
 * header/frozen counts stay attached to the cells they described.
 *
 * Coordinates are the sheet's A1 space; see `structuralEdit.ts`.
 */

import type { CellStyleRanges, ColumnFormat } from '../types';
import { FORMATTING_KEYS, pickFormatting, shiftFormatting, type SheetFormatting } from '../sheetMeta/formatting';
import { shiftRangeRecord } from '../conditional/rangeKeys';
import {
  editAxis,
  mapIndex,
  mapLeadingCount,
  type StructuralEdit,
} from './structuralEdit';

/**
 * The structural slice of metadata. Matches the fields of `CSVMetadata`,
 * `SpreadsheetMetadata` (useSpreadsheetMetadata) and `SpreadsheetData`, so any
 * of them can be passed; fields not listed here pass through untouched.
 */
export interface StructuralMetadata extends Partial<SheetFormatting> {
  headerRowCount?: number;
  hasHeaders?: boolean;
  frozenColumnCount?: number;
  columnCount?: number;
  columnFormats?: Record<number, ColumnFormat>;
  columnWidths?: Record<number, number>;
  cellStyles?: CellStyleRanges;
}

function remapColumnKeys<T>(record: Record<number, T>, edit: StructuralEdit): Record<number, T> {
  const next: Record<number, T> = {};
  for (const [key, value] of Object.entries(record)) {
    const mapped = mapIndex(Number(key), edit);
    if (mapped !== null) next[mapped] = value;
  }
  return next;
}

/**
 * Return metadata rewritten for `edit`. Never mutates `meta`; fields that are
 * absent stay absent and fields the edit does not affect keep their identity.
 *
 * - Column edits remap `columnFormats` / `columnWidths` keys (deleted columns
 *   drop their entries; inserted columns get none) and adjust `columnCount`.
 * - Both axes remap `cellStyles`.
 * - `headerRowCount` / `frozenColumnCount` grow when rows/columns are inserted
 *   inside the block and shrink when rows/columns inside it are deleted.
 *   `hasHeaders` follows `headerRowCount`.
 */
export function rewriteMetadataForStructuralEdit<T extends StructuralMetadata>(meta: T, edit: StructuralEdit): T {
  const next: T = { ...meta };

  // Styles layer per property, so entries a shift lands on one key merge rather than replace.
  if (meta.cellStyles) next.cellStyles = shiftRangeRecord(meta.cellStyles, edit, true);
  rewriteFormatting(meta, next, edit);

  if (editAxis(edit) === 'row') {
    if (meta.headerRowCount !== undefined) {
      next.headerRowCount = mapLeadingCount(meta.headerRowCount, edit);
      if (meta.hasHeaders !== undefined) next.hasHeaders = next.headerRowCount > 0;
    }
    return next;
  }

  if (meta.columnFormats) next.columnFormats = remapColumnKeys(meta.columnFormats, edit);
  if (meta.columnWidths) next.columnWidths = remapColumnKeys(meta.columnWidths, edit);
  if (meta.frozenColumnCount !== undefined) {
    next.frozenColumnCount = mapLeadingCount(meta.frozenColumnCount, edit);
  }
  if (meta.columnCount !== undefined) {
    if (edit.type === 'insertCols') next.columnCount = meta.columnCount + edit.count;
    if (edit.type === 'deleteCols') {
      const removed = Math.max(0, Math.min(meta.columnCount, edit.at + edit.count) - edit.at);
      next.columnCount = meta.columnCount - removed;
    }
  }
  return next;
}

/**
 * The Phase 3 fields (`sheetMeta/formatting.ts`), for whichever of them `meta`
 * carries. Absent fields stay absent.
 */
function rewriteFormatting(meta: StructuralMetadata, next: StructuralMetadata, edit: StructuralEdit): void {
  const present = FORMATTING_KEYS.filter((key) => meta[key] !== undefined);
  if (present.length === 0) return;
  const header = meta.headerRowCount ?? 0;
  const nextHeader = editAxis(edit) === 'row' ? mapLeadingCount(header, edit) : header;
  const shifted = shiftFormatting(pickFormatting(meta), edit, header, nextHeader);
  const target = next as Record<string, unknown>;
  for (const key of present) target[key] = shifted[key];
}
