/**
 * CSV parsing and serialization utilities using Papa Parse
 */

import Papa from 'papaparse';
import type { SpreadsheetData, Cell, CSVMetadata, ColumnFormat } from '../types';

/** Comment prefix for nimbalyst metadata */
const METADATA_PREFIX = '# nimbalyst:';

/**
 * Parse metadata from CSV content (first line comment)
 */
export function parseMetadata(content: string): { metadata: CSVMetadata | null; contentWithoutMetadata: string } {
  const lines = content.split('\n');
  const firstLine = lines[0]?.trim() || '';

  if (firstLine.startsWith(METADATA_PREFIX)) {
    try {
      const jsonStr = firstLine.slice(METADATA_PREFIX.length).trim();
      const metadata = JSON.parse(jsonStr) as CSVMetadata;
      const contentWithoutMetadata = lines.slice(1).join('\n');
      return { metadata, contentWithoutMetadata };
    } catch (e) {
      console.warn('[CSV] Failed to parse metadata comment:', e);
    }
  }

  return { metadata: null, contentWithoutMetadata: content };
}

/**
 * Serialize metadata to comment line
 */
export function serializeMetadata(metadata: CSVMetadata): string {
  return `${METADATA_PREFIX} ${JSON.stringify(metadata)}`;
}

/**
 * Detect the delimiter used in a CSV file
 */
export function detectDelimiter(content: string): ',' | '\t' {
  const firstLine = content.split('\n')[0] || '';
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  return tabCount > commaCount ? '\t' : ',';
}

/**
 * Parse CSV content into SpreadsheetData
 */
export function parseCSV(content: string): { data: SpreadsheetData; delimiter: ',' | '\t'; metadata: CSVMetadata | null } {
  // Extract metadata from comment if present
  const { metadata, contentWithoutMetadata } = parseMetadata(content);

  const delimiter = detectDelimiter(contentWithoutMetadata);

  const result = Papa.parse<string[]>(contentWithoutMetadata, {
    delimiter,
    skipEmptyLines: false,
    header: false,
  });

  if (result.errors.length > 0) {
    console.warn('[CSV] Parse warnings:', result.errors);
  }

  const rawRows = result.data as string[][];

  // Ensure we have at least one row
  if (rawRows.length === 0) {
    rawRows.push(['']);
  }

  // Find the maximum column count
  const columnCount = Math.max(...rawRows.map(row => row.length), 1);

  // Normalize all rows to have the same number of columns
  const normalizedRows = rawRows.map(row => {
    while (row.length < columnCount) {
      row.push('');
    }
    return row;
  });

  // Convert to Cell format and evaluate formulas
  const rows = normalizedRows.map((row) =>
    row.map((value) => {
      const cell = createCell(value);
      // Formula evaluation will happen in recalculateFormulas after data is fully built
      return cell;
    })
  );

  // Use metadata headerRowCount if present, otherwise use hasHeaders, otherwise auto-detect
  let headerRowCount: number;
  if (metadata?.headerRowCount !== undefined) {
    headerRowCount = metadata.headerRowCount;
  } else if (metadata !== null) {
    headerRowCount = metadata.hasHeaders ? 1 : 0;
  } else {
    // Auto-detect: first row looks like headers if non-numeric, non-empty strings
    const looksLikeHeaders = rows.length > 1 &&
      rows[0].every(cell =>
        cell.raw !== '' && isNaN(parseFloat(cell.raw))
      );
    headerRowCount = looksLikeHeaders ? 1 : 0;
  }

  const hasHeaders = headerRowCount > 0;

  // Use metadata frozenColumnCount if present, otherwise default to 0
  const frozenColumnCount = metadata?.frozenColumnCount ?? 0;

  // Use metadata columnFormats if present, otherwise default to empty
  const columnFormats: Record<number, ColumnFormat> = metadata?.columnFormats ?? {};

  return {
    data: {
      rows,
      columnCount,
      headers: hasHeaders ? rows[0].map(cell => cell.raw) : undefined,
      hasHeaders,
      headerRowCount,
      frozenColumnCount,
      columnFormats,
    },
    delimiter,
    metadata,
  };
}

/**
 * ISO-style calendar date pattern (YYYY-MM-DD, YYYY-M-D, etc.). Kept here
 * as a literal rather than importing from `formatters.ts` to avoid pulling
 * the formatting layer into the parsing layer.
 *
 * The check is intentionally narrow: it only matches the full-string
 * `YYYY-(M)M-(D)D` shape. Other date shapes (slash-delimited, dot-delimited,
 * date-with-time, partial dates) are out of scope for this guard; they fall
 * through to the existing string branch and render as plain text.
 */
const ISO_DATE_PATTERN = /^\d{4}-\d{1,2}-\d{1,2}$/;

/**
 * Create a Cell from a raw string value
 */
export function createCell(value: string): Cell {
  const trimmed = value.trim();

  // Check if it's a formula
  if (trimmed.startsWith('=')) {
    return {
      raw: trimmed,
      computed: null, // Will be computed by formula engine
    };
  }

  // ISO date guard (issue #329).
  //
  // `parseFloat("2026-05-15")` returns `2026` because parseFloat stops at
  // the first non-numeric character. Without this guard, `2026-05-15` got
  // stored as `{ raw: "2026-05-15", computed: 2026 }` and the spreadsheet
  // grid wrote `cell.computed` (2026) into the rendered cell, truncating
  // the displayed value to the year. The raw file content stayed correct
  // on disk because `serializeToCSV` reads `cell.raw`; only the rendered
  // cell was wrong.
  //
  // Treat ISO-date-shaped strings as strings so the displayed value matches
  // the file contents. Numeric values like `2026` (a year on its own) stay
  // on the numeric path below.
  if (ISO_DATE_PATTERN.test(trimmed)) {
    return {
      raw: trimmed,
      computed: trimmed,
    };
  }

  // Check if it's a number
  const num = parseFloat(trimmed);
  if (!isNaN(num) && trimmed !== '') {
    return {
      raw: trimmed,
      computed: num,
    };
  }

  // Otherwise it's a string
  return {
    raw: value,
    computed: value,
  };
}

/**
 * Serialize SpreadsheetData back to CSV format
 */
export function serializeToCSV(data: SpreadsheetData, delimiter: ',' | '\t' = ',', includeMetadata: boolean = true): string {
  const rows = data.rows.map(row =>
    row.map(cell => {
      // Always save the raw value (including formulas)
      const value = cell.raw;

      // Quote the value if it contains the delimiter, quotes, or newlines
      if (value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')) {
        return `"${value.replace(/"/g, '""')}"`;
      }

      return value;
    })
  );

  const csvContent = rows.map(row => row.join(delimiter)).join('\n');

  // Prepend metadata comment if requested AND if using non-default features
  if (includeMetadata) {
    const hasColumnFormats = Object.keys(data.columnFormats || {}).length > 0;
    const headerRowCount = data.headerRowCount || (data.hasHeaders ? 1 : 0);
    const frozenColumnCount = data.frozenColumnCount || 0;
    const hasNonDefaultMetadata = headerRowCount > 0 || frozenColumnCount > 0 || hasColumnFormats;

    if (hasNonDefaultMetadata) {
      const metadata: CSVMetadata = {
        hasHeaders: data.hasHeaders,
        headerRowCount,
        frozenColumnCount,
        ...(hasColumnFormats ? { columnFormats: data.columnFormats } : {}),
      };
      return `${serializeMetadata(metadata)}\n${csvContent}`;
    }
  }

  return csvContent;
}

/**
 * Convert column index to letter (0 = A, 1 = B, ..., 25 = Z, 26 = AA, etc.)
 */
export function columnIndexToLetter(index: number): string {
  let letter = '';
  let n = index;

  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }

  return letter;
}

/**
 * Convert column letter to index (A = 0, B = 1, ..., Z = 25, AA = 26, etc.)
 */
export function columnLetterToIndex(letter: string): number {
  let index = 0;
  const upper = letter.toUpperCase();

  for (let i = 0; i < upper.length; i++) {
    index = index * 26 + (upper.charCodeAt(i) - 64);
  }

  return index - 1;
}

/**
 * Parse a cell reference like "A1" into column and row indices
 */
export function parseCellReference(ref: string): { col: number; row: number } | null {
  const match = ref.match(/^([A-Za-z]+)(\d+)$/);
  if (!match) return null;

  const col = columnLetterToIndex(match[1]);
  const row = parseInt(match[2], 10) - 1; // Convert to 0-indexed

  return { col, row };
}

/**
 * Parse a range reference like "A1:B5"
 */
export function parseRangeReference(ref: string): { start: { col: number; row: number }; end: { col: number; row: number } } | null {
  const parts = ref.split(':');
  if (parts.length !== 2) return null;

  const start = parseCellReference(parts[0]);
  const end = parseCellReference(parts[1]);

  if (!start || !end) return null;

  return { start, end };
}

/**
 * Generate column headers (A, B, C, ..., Z, AA, AB, etc.)
 */
export function generateColumnHeaders(count: number): string[] {
  return Array.from({ length: count }, (_, i) => columnIndexToLetter(i));
}
