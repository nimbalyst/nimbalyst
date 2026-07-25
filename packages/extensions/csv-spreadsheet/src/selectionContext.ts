import type { EditorContextItem } from '@nimbalyst/extension-sdk';
import type { NormalizedSelectionRange } from './types';
import { columnIndexToLetter } from './utils/csvParser';

const MAX_INDEX = 1_000_000;
const MAX_PREVIEW_ROWS = 8;
const MAX_PREVIEW_COLUMNS = 8;
const MAX_CELL_TEXT = 160;

type GridRow = Readonly<Record<string, unknown>>;
type SafeCellValue = string | number | boolean | null;

function boundedText(value: unknown, limit = MAX_CELL_TEXT): string {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 14))}… [truncated]`;
}

function safeIndex(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_INDEX, Math.max(0, Math.floor(value)));
}

function normalizeRange(range: NormalizedSelectionRange): NormalizedSelectionRange {
  const rowA = safeIndex(range.startRow);
  const rowB = safeIndex(range.endRow);
  const colA = safeIndex(range.startCol);
  const colB = safeIndex(range.endCol);
  return {
    startRow: Math.min(rowA, rowB),
    startCol: Math.min(colA, colB),
    endRow: Math.max(rowA, rowB),
    endCol: Math.max(colA, colB),
  };
}

function safeCellValue(value: unknown): SafeCellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return boundedText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : boundedText(value);
  if (typeof value === 'boolean') return value;
  return boundedText(value);
}

function formatCellValue(value: SafeCellValue): string {
  return value === null ? '' : String(value);
}

function rangeReference(range: NormalizedSelectionRange): string {
  const start = `${columnIndexToLetter(range.startCol)}${range.startRow + 1}`;
  if (range.startRow === range.endRow && range.startCol === range.endCol) return start;
  return `${start}:${columnIndexToLetter(range.endCol)}${range.endRow + 1}`;
}

export function buildSpreadsheetSelectionContextItem(
  selection: NormalizedSelectionRange,
  rows: readonly GridRow[],
): EditorContextItem {
  const range = normalizeRange(selection);
  const rowCount = range.endRow - range.startRow + 1;
  const columnCount = range.endCol - range.startCol + 1;
  const cellCount = rowCount * columnCount;
  const previewRowCount = Math.min(rowCount, MAX_PREVIEW_ROWS);
  const previewColumnCount = Math.min(columnCount, MAX_PREVIEW_COLUMNS);
  const preview: SafeCellValue[][] = [];

  for (let rowOffset = 0; rowOffset < previewRowCount; rowOffset += 1) {
    const row = rows[range.startRow + rowOffset];
    const values: SafeCellValue[] = [];
    for (let colOffset = 0; colOffset < previewColumnCount; colOffset += 1) {
      const column = columnIndexToLetter(range.startCol + colOffset);
      values.push(safeCellValue(row?.[column]));
    }
    preview.push(values);
  }

  const reference = rangeReference(range);
  const previewText = preview.map((row) => row.map(formatCellValue).join('\t')).join('\n');
  const omittedRows = rowCount - previewRowCount;
  const omittedColumns = columnCount - previewColumnCount;
  const truncation = [
    omittedRows > 0 ? `${omittedRows} more row${omittedRows === 1 ? '' : 's'}` : '',
    omittedColumns > 0 ? `${omittedColumns} more column${omittedColumns === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' and ');

  return {
    id: `csv-range:${reference}`,
    label: `${reference} (${cellCount} ${cellCount === 1 ? 'cell' : 'cells'})`,
    icon: 'table_view',
    groupLabel: 'spreadsheet ranges',
    description: [
      `Selected spreadsheet range ${reference} containing ${cellCount} ${cellCount === 1 ? 'cell' : 'cells'}.`,
      `Values preview (${previewRowCount} row${previewRowCount === 1 ? '' : 's'} × ${previewColumnCount} column${previewColumnCount === 1 ? '' : 's'}):`,
      previewText || '[empty]',
      truncation ? `[Preview truncated: ${truncation} omitted.]` : '',
    ].filter(Boolean).join('\n'),
    data: {
      range: {
        reference,
        startRow: range.startRow,
        startColumn: range.startCol,
        endRow: range.endRow,
        endColumn: range.endCol,
      },
      rowCount,
      columnCount,
      cellCount,
      preview,
      previewTruncated: omittedRows > 0 || omittedColumns > 0,
      omittedRows,
      omittedColumns,
    },
    includeData: true,
  };
}
