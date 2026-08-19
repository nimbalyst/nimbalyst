/**
 * Types for the CSV Spreadsheet extension
 */

/**
 * Column format types
 */
export type ColumnType =
  | 'text'
  | 'number'
  | 'currency'
  | 'percentage'
  | 'date'
  | 'datetime'
  | 'time'
  | 'boolean'
  | 'url'
  | 'tracker';

/**
 * Currency format options
 */
export type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'JPY' | 'CNY';

/**
 * Date format options
 */
export type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'MMM D, YYYY';

/**
 * Time-of-day format options
 */
export type TimeFormat = 'h:mm A' | 'h:mm:ss A' | 'HH:mm' | 'HH:mm:ss';

/**
 * Numeric presentation styles layered on top of the `number`/`currency` types.
 * `standard` is the existing fixed-decimal behavior.
 */
export type NumberStyle = 'standard' | 'plain' | 'scientific' | 'accounting';

/**
 * How negative values are drawn. `red` variants add a CSS class rather than
 * changing the string, so the value stays copy-pasteable.
 */
export type NegativeStyle = 'minus' | 'parens' | 'red' | 'parens-red';

/**
 * Rendering style for boolean columns.
 */
export type BooleanStyle = 'true-false' | 'yes-no' | 'check';

/**
 * Explicit horizontal alignment, overriding the type-derived default.
 */
export type CellAlignment = 'left' | 'center' | 'right';

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
  /** Date format string for date/datetime types */
  dateFormat?: DateFormat;
  /** Time format string for datetime/time types */
  timeFormat?: TimeFormat;
  /**
   * Custom token pattern (`YYYY-MM-DD HH:mm`). When set it overrides
   * `dateFormat`/`timeFormat` entirely — this is the "more formats" escape
   * hatch for date, datetime, and time columns.
   */
  pattern?: string;
  /** Numeric presentation style for number/currency types */
  numberStyle?: NumberStyle;
  /** How negatives are drawn for number/currency/percentage types */
  negativeStyle?: NegativeStyle;
  /**
   * For `percentage`: whether stored values are fractions (0.5 means 50%) or
   * whole percents (50 means 50%).
   *
   * `undefined` means "legacy" and falls back to a magnitude guess — see
   * `formatCellValue`. Every format written by the format dialog sets this
   * explicitly, so the guess only ever applies to columns formatted before
   * the flag existed.
   */
  valuesAreFractions?: boolean;
  /** Rendering style for boolean columns */
  booleanStyle?: BooleanStyle;
  /** Explicit alignment override; falls back to the type-derived default */
  align?: CellAlignment;
}

/**
 * Named colors for cell styling.
 *
 * A fixed palette rather than arbitrary hex: the swatches resolve to `--nim-*`
 * derived CSS, so a sheet styled in the light theme stays readable in the dark
 * one. Raw colors would look correct only in whichever theme they were picked in.
 */
export type CellColor =
  | 'default'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'gray';

/**
 * Presentation applied to a cell range, independent of the column's data type.
 */
export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  textColor?: CellColor;
  fillColor?: CellColor;
  align?: CellAlignment;
}

/**
 * Cell styles keyed by A1 range (`B2` or `A1:C10`), 1-based and inclusive.
 *
 * Range-keyed rather than per-cell so the metadata line stays small: styling a
 * whole column is one entry, not ten thousand. Later entries win where ranges
 * overlap.
 */
export type CellStyleRanges = Record<string, CellStyle>;

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
  /** Cell styling, keyed by A1 range */
  cellStyles?: CellStyleRanges;
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
  /** Cell styling, keyed by A1 range */
  cellStyles: CellStyleRanges;
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

/** Physical RevoGrid rgRow indexes hidden from the visible view. */
export type TrimmedRows = Readonly<Record<number, boolean>>;

/** Scalar values supported by column value filters. */
export type FilterScalar = string | number | boolean | null;

export type NumericFilterOperator =
  | 'equals'
  | 'notEquals'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual';

export type TextFilterOperator = 'contains' | 'equals' | 'startsWith';

export type DateFilterOperator = 'on' | 'before' | 'after' | 'between';

export type ColumnFilter =
  | { kind: 'values'; values: ReadonlySet<FilterScalar> }
  | { kind: 'number'; operator: NumericFilterOperator; value: number }
  | { kind: 'text'; operator: TextFilterOperator; value: string; caseSensitive?: boolean }
  | { kind: 'blank'; operator: 'isBlank' | 'isNotBlank' }
  /**
   * Bounds are epoch milliseconds. `on` matches the whole calendar day of
   * `value`; `between` uses `value` and `valueEnd` inclusively.
   */
  | { kind: 'date'; operator: DateFilterOperator; value: number; valueEnd?: number };

/** Session-only filter state keyed by zero-based column index. */
export type ColumnFilterState = ReadonlyMap<number, ColumnFilter>;

export interface FindMatch {
  logicalRow: number;
  columnIndex: number;
  start: number;
  end: number;
  value: string;
}

export interface FindCursor {
  index: number;
  count: number;
  match: FindMatch | null;
}

export interface CellReplacement {
  logicalRow: number;
  columnIndex: number;
  value: string;
  replacementCount: number;
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
