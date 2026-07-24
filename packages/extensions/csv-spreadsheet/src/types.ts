/**
 * Types for the CSV Spreadsheet extension
 */

/**
 * Column format types
 */
export type ColumnType = 'text' | 'number' | 'currency' | 'percentage' | 'date';

/**
 * Currency format options
 */
export type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'JPY' | 'CNY';

/**
 * Date format options
 */
export type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'MMM D, YYYY';

/**
 * Column format configuration
 */
export interface ColumnFormat {
  /** Column type determines how values are parsed and displayed */
  type: ColumnType;
  /** Number of decimal places for number/currency/percentage types */
  decimals?: number;
  /** Whether to show thousands separator for number/currency types */
  showThousandsSeparator?: boolean;
  /** Currency code for currency type */
  currency?: CurrencyCode;
  /** Date format string for date type */
  dateFormat?: DateFormat;
}

/**
 * Metadata stored in CSV comment header
 */
export interface CSVMetadata {
  hasHeaders: boolean;
  headerRowCount?: number;
  frozenColumnCount?: number;
  /** Column format configurations, keyed by column index */
  columnFormats?: Record<number, ColumnFormat>;
  /** Column widths, keyed by column index (only stored if user has resized) */
  columnWidths?: Record<number, number>;
}

/**
 * Represents a single cell value
 * Can be a raw value or a formula (starting with =)
 */
export type CellValue = string | number | null;

/**
 * A cell with both the raw value/formula and computed display value
 */
export interface Cell {
  /** The raw value or formula (formulas start with =) */
  raw: string;
  /** The computed display value (for formulas, this is the result) */
  computed: CellValue;
  /** Error message if formula evaluation failed */
  error?: string;
}

/**
 * Represents a row of cells
 */
export type Row = Cell[];

/**
 * The entire spreadsheet data structure
 */
export interface SpreadsheetData {
  /** Array of rows, each row is an array of cells */
  rows: Row[];
  /** Number of columns */
  columnCount: number;
  /** Column headers (if first row is header) - deprecated, kept for compatibility */
  headers?: string[];
  /** Whether the first row should be treated as headers - deprecated, use headerRowCount */
  hasHeaders: boolean;
  /** Number of header rows (0 = no headers, 1+ = that many rows are headers) */
  headerRowCount: number;
  /** Number of frozen/pinned columns on the left (0 = no frozen columns) */
  frozenColumnCount: number;
  /** Column format configurations, keyed by column index */
  columnFormats: Record<number, ColumnFormat>;
}

/**
 * Minimal data structure needed for formula evaluation
 * This is a subset of SpreadsheetData used when we only need row data
 */
export interface FormulaEvalData {
  /** Array of rows, each row is an array of cells */
  rows: Row[];
  /** Number of columns */
  columnCount: number;
}

/**
 * Column definition for RevoGrid
 */
export interface ColumnDefinition {
  prop: string;
  name: string;
  size?: number;
  sortable?: boolean;
  readonly?: boolean;
}

/**
 * Sort direction
 */
export type SortDirection = 'asc' | 'desc' | null;

/**
 * Sort configuration for a column
 */
export interface SortConfig {
  columnIndex: number;
  direction: SortDirection;
}

/**
 * Selection range for multi-cell selection
 */
export interface SelectionRange {
  /** Starting cell (where selection began) */
  start: CellReference;
  /** Ending cell (where selection ends) */
  end: CellReference;
}

/**
 * Normalized selection range (start is always top-left, end is always bottom-right)
 */
export interface NormalizedSelectionRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * Props for custom editor components (from Nimbalyst extension system)
 * Re-exported from runtime for convenience
 */
export type { EditorHost, EditorHostProps } from '@nimbalyst/extension-sdk';

/**
 * Cell reference (for formulas)
 */
export interface CellReference {
  col: number;
  row: number;
}

/**
 * Range reference (for formulas like SUM(A1:B5))
 */
export interface RangeReference {
  start: CellReference;
  end: CellReference;
}

/**
 * Diff mode types for AI edit review
 */

/** Type of change for a cell */
export type CellDiffType = 'added' | 'modified' | 'deleted' | 'unchanged';

/** Diff information for a single cell */
export interface CellDiff {
  type: CellDiffType;
  /** Previous value for modified/deleted cells */
  previousValue?: string;
}

/** Diff information for a row */
export interface RowDiff {
  type: 'added' | 'modified' | 'deleted' | 'unchanged';
  /** True for deleted rows that are shown as phantom rows */
  isPhantom?: boolean;
}

/** Complete diff state for the spreadsheet */
export interface DiffState {
  /** Cell-level diff info, keyed by "rowIndex:colProp" (e.g., "3:B") */
  cells: Map<string, CellDiff>;
  /** Row-level diff info, keyed by row index in merged view */
  rows: Map<number, RowDiff>;
  /** Deleted rows from original to display as phantom rows */
  phantomRows: Row[];
  /** Position in modified data where each phantom row should be inserted (data row index, not including header) */
  phantomRowPositions: number[];
  /** Original content for revert */
  originalContent: string;
  /** Whether diff mode is currently active */
  isActive: boolean;
  /** History tag ID */
  tagId: string;
  /** AI session ID that made the edit */
  sessionId: string;
}
