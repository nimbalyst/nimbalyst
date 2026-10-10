/**
 * CSV parsing and serialization utilities using Papa Parse
 */

import Papa from 'papaparse';
import type { SpreadsheetData, Cell, CSVMetadata, CellStyleRanges, ColumnFormat } from '../types';
import { formattingForFile, formattingFromFile, type SheetFormatting } from '../sheetMeta/formatting';

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

/** The sheet-level fields the metadata comment carries. */
export interface MetadataLineFields extends Partial<SheetFormatting> {
  headerRowCount: number;
  frozenColumnCount: number;
  columnFormats?: Record<number, ColumnFormat>;
  columnWidths?: Record<number, number>;
  cellStyles?: CellStyleRanges;
}

export interface MetadataLineContext {
  /** What a reload would auto-detect from the rows being written. */
  detectedHeaderRowCount?: number;
  /** The file already carries the line; keep it even at defaults. */
  keepLine?: boolean;
}

/**
 * The metadata comment line for a sheet, or null when nothing differs from
 * what a reload of the plain rows would produce. The single builder for both
 * serializers, so a new metadata field cannot be written by one save path and
 * silently dropped by the other. A header count equal to the auto-detected one
 * is not a reason to write the line: a plain CSV stays plain.
 */
export function buildMetadataLine(fields: MetadataLineFields, context: MetadataLineContext = {}): string | null {
  const { headerRowCount, frozenColumnCount } = fields;
  const nonEmpty = <T extends object>(value: T | undefined): value is T =>
    !!value && Object.keys(value).length > 0;
  const columnFormats = nonEmpty(fields.columnFormats) ? fields.columnFormats : undefined;
  const columnWidths = nonEmpty(fields.columnWidths) ? fields.columnWidths : undefined;
  const cellStyles = nonEmpty(fields.cellStyles) ? fields.cellStyles : undefined;
  const formatting = formattingForFile(fields);

  if (!context.keepLine && headerRowCount === (context.detectedHeaderRowCount ?? 0)
    && frozenColumnCount <= 0 && !columnFormats && !columnWidths && !cellStyles
    && Object.keys(formatting).length === 0) {
    return null;
  }

  return serializeMetadata({
    hasHeaders: headerRowCount > 0,
    headerRowCount,
    frozenColumnCount,
    ...(columnFormats ? { columnFormats } : {}),
    ...(columnWidths ? { columnWidths } : {}),
    ...(cellStyles ? { cellStyles } : {}),
    ...formatting,
  });
}

/** Quote a field if it contains the delimiter, a quote, or a line break. */
export function quoteCsvField(value: string, delimiter: ',' | '\t'): string {
  if (value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
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
 * The delimiter to write a file back with. Content wins when its first line
 * has a separator in it; a single-column or empty file has nothing to detect,
 * so the extension decides -- otherwise a new `.tsv` would save with commas
 * the moment a second column appeared.
 */
export function resolveFileDelimiter(content: string, filePath: string): ',' | '\t' {
  const { contentWithoutMetadata } = parseMetadata(content);
  const firstLine = contentWithoutMetadata.split('\n')[0] || '';
  if (firstLine.includes('\t') || firstLine.includes(',')) {
    return detectDelimiter(contentWithoutMetadata);
  }
  return filePath.toLowerCase().endsWith('.tsv') ? '\t' : ',';
}

/** How a file's bytes are laid out beyond its cells, so a save can write them back the same way. */
export interface CsvFileLayout {
  readonly lineEnding: '\n' | '\r\n';
  readonly trailingNewline: boolean;
  /** The file carried a `# nimbalyst:` line; saves keep it even at defaults. */
  readonly hasMetadataLine: boolean;
}

export const DEFAULT_FILE_LAYOUT: CsvFileLayout = { lineEnding: '\n', trailingNewline: false, hasMetadataLine: false };

export function detectFileLayout(content: string): CsvFileLayout {
  const { metadata, contentWithoutMetadata } = parseMetadata(content);
  return {
    lineEnding: content.includes('\r\n') ? '\r\n' : '\n',
    trailingNewline: contentWithoutMetadata.length > 0 && contentWithoutMetadata.endsWith('\n'),
    hasMetadataLine: metadata !== null,
  };
}

/**
 * Header rows a file without a metadata line gets: one when there is more than
 * one row and every cell of the first, up to its last non-empty one, is
 * non-empty, non-numeric text. Both the parser and the serializers call this
 * on the same rows, so a save only writes a header count the reload would not
 * detect by itself. Trailing empty cells do not count: a save trims empty
 * trailing columns, and the answer must not change when it does.
 */
export function autoDetectHeaderRowCount(firstRow: readonly string[], rowCount: number): number {
  let width = firstRow.length;
  while (width > 0 && firstRow[width - 1] === '') width -= 1;
  if (rowCount <= 1 || width === 0) return 0;
  return firstRow.slice(0, width).every((value) => value !== '' && isNaN(parseFloat(value))) ? 1 : 0;
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
  // The final line break ends the last row; it does not start an empty one.
  // `CsvFileLayout.trailingNewline` remembers it for the save.
  const last = rawRows[rawRows.length - 1];
  if (rawRows.length > 1 && last.length === 1 && last[0] === '' && contentWithoutMetadata.endsWith('\n')) {
    rawRows.pop();
  }

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
    headerRowCount = autoDetectHeaderRowCount(normalizedRows[0], rows.length);
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
      frozenRowCount: Number.isInteger(metadata?.frozenRowCount) ? Math.max(0, metadata!.frozenRowCount as number) : 0,
      columnFormats,
      cellStyles,
      namedRanges: formattingFromFile(metadata).namedRanges,
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
export function serializeToCSV(
  data: SpreadsheetData,
  delimiter: ',' | '\t' = ',',
  includeMetadata: boolean = true,
  columnWidths?: Record<number, number>,
  formatting?: Partial<SheetFormatting>,
): string {
  // Always save the raw value (including formulas)
  const csvContent = data.rows
    .map(row => row.map(cell => quoteCsvField(cell.raw, delimiter)).join(delimiter))
    .join('\n');

  if (!includeMetadata) return csvContent;

  const metadataLine = buildMetadataLine({
    headerRowCount: data.headerRowCount || (data.hasHeaders ? 1 : 0),
    frozenColumnCount: data.frozenColumnCount || 0,
    columnFormats: data.columnFormats,
    columnWidths,
    cellStyles: data.cellStyles,
    ...formatting,
  }, { detectedHeaderRowCount: autoDetectHeaderRowCount(data.rows[0]?.map((cell) => cell.raw) ?? [], data.rows.length) });
  return metadataLine ? `${metadataLine}\n${csvContent}` : csvContent;
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
