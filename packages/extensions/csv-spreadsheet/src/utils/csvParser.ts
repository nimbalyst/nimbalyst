/**
 * CSV parsing and serialization utilities using Papa Parse
 */

import Papa from 'papaparse';
import type { SpreadsheetData, Cell, CSVMetadata, CellStyleRanges, ColumnFormat } from '../types';

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
  const cellStyles: CellStyleRanges = metadata?.cellStyles ?? {};

  return {
    data: {
      rows,
      columnCount,
      headers: hasHeaders ? rows[0].map(cell => cell.raw) : undefined,
      hasHeaders,
      headerRowCount,
      frozenColumnCount,
      columnFormats,
      cellStyles,
    },
    delimiter,
    metadata,
  };
}

/**
 * A string that is a number *in its entirety*.
 *
 * `parseFloat` stops at the first character it cannot read, so it happily
 * turns `06/01/2001` into 6, `1,234` into 1, and `12 apples` into 12. Because
 * `toGridSource` writes `cell.computed` into the RevoGrid model, and the cell
 * editor renders that model value, every one of those became the truncated
 * number the moment you opened the cell to edit it — the file on disk stayed
 * correct, since `serializeToCSV` reads `cell.raw`.
 *
 * Issue #329 patched the one shape that had been reported (`YYYY-MM-DD`) with
 * a targeted guard. This replaces that guard: requiring a full-string match
 * closes the whole family at once — slash and dot dates, dates with times,
 * thousands separators, and numeric-prefixed prose.
 *
 * Exponent notation stays numeric; grouped values like `1,234` do not, so the
 * cell keeps the text the user typed. Column formatting is what turns a stored
 * `1234` into `1,234` on screen.
 */
const FULLY_NUMERIC_PATTERN = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

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

  if (FULLY_NUMERIC_PATTERN.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      return {
        raw: trimmed,
        computed: num,
      };
    }
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
    const hasCellStyles = Object.keys(data.cellStyles || {}).length > 0;
    const headerRowCount = data.headerRowCount || (data.hasHeaders ? 1 : 0);
    const frozenColumnCount = data.frozenColumnCount || 0;
    const hasNonDefaultMetadata = headerRowCount > 0 || frozenColumnCount > 0
      || hasColumnFormats || hasCellStyles;

    if (hasNonDefaultMetadata) {
      const metadata: CSVMetadata = {
        hasHeaders: data.hasHeaders,
        headerRowCount,
        frozenColumnCount,
        ...(hasColumnFormats ? { columnFormats: data.columnFormats } : {}),
        ...(hasCellStyles ? { cellStyles: data.cellStyles } : {}),
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
 * Generate column headers (A, B, C, ..., Z, AA, AB, etc.)
 */
export function generateColumnHeaders(count: number): string[] {
  return Array.from({ length: count }, (_, i) => columnIndexToLetter(i));
}
