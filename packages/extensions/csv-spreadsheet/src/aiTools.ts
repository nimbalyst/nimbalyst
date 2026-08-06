import type { AIToolContext, ExtensionAITool, ExtensionToolResult } from '@nimbalyst/extension-sdk';
import type {
  SpreadsheetCellSnapshot,
  SpreadsheetEditorAPI,
  SpreadsheetEditorSelection,
  SpreadsheetSheetInfo,
} from './editorAPI';
import { columnIndexToLetter } from './utils/csvParser';

const DISTINCT_SAMPLE_LIMIT = 10;
const OUTLIER_SAMPLE_LIMIT = 10;
const MAX_ANALYZED_COLUMNS = 100;
const MAX_ANALYZED_ROWS = 10_000;
const MAX_ANALYZED_CELLS = 100_000;
const MAX_SAMPLE_TEXT = 120;
const MAX_FORMULA_LENGTH = 8192;
const MAX_FORMULA_TARGET_CELLS = 10_000;

type AnalysisScope = 'sheet' | 'selection';
type DetectedType = 'number' | 'date' | 'boolean' | 'text';

function getEditorAPI(context: AIToolContext): SpreadsheetEditorAPI | null {
  return (context.editorAPI as SpreadsheetEditorAPI | undefined) ?? null;
}

function noEditorError(context: AIToolContext): ExtensionToolResult {
  const path = context.activeFilePath;
  return {
    success: false,
    error: path
      ? `Could not connect to the spreadsheet editor for ${path}. Try the tool again after the editor finishes loading.`
      : 'No spreadsheet file was provided. Pass filePath for an existing .csv or .tsv file.',
  };
}

function errorResult(error: unknown): ExtensionToolResult {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

function parseScope<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`scope must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function assertIndex(name: string, value: unknown, upperBound: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= upperBound) {
    throw new Error(`${name} ${String(value)} is out of bounds; expected an integer from 0 to ${Math.max(0, upperBound - 1)}`);
  }
  return value as number;
}

function assertSelection(selection: SpreadsheetEditorSelection | null, info: SpreadsheetSheetInfo): SpreadsheetEditorSelection {
  if (!selection) throw new Error('scope "selection" requires a current spreadsheet selection');
  const { range, logicalRows } = selection;
  assertIndex('Selection start row', range.startRow, info.rowCount);
  assertIndex('Selection end row', range.endRow, info.rowCount);
  assertIndex('Selection start column', range.startCol, info.metadata.columnCount);
  assertIndex('Selection end column', range.endCol, info.metadata.columnCount);
  if (range.startRow > range.endRow) throw new Error('Selection rows are not ordered');
  if (range.startCol > range.endCol) throw new Error('Selection columns are not ordered');
  if (logicalRows.length === 0) throw new Error('The current selection contains no visible rows');
  let previousRow = -1;
  for (const row of logicalRows) {
    assertIndex('Selection row index', row, info.rowCount);
    if (row <= previousRow) throw new Error('Selection logical rows must be a unique ordered list');
    previousRow = row;
  }
  return selection;
}

function boundedValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  const text = String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length <= MAX_SAMPLE_TEXT ? text : `${text.slice(0, MAX_SAMPLE_TEXT - 14)}… [truncated]`;
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const normalized = text.replace(/[$€£¥,]/g, '');
  const percent = normalized.endsWith('%');
  const numberText = percent ? normalized.slice(0, -1) : normalized;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(numberText)) return null;
  const parsed = Number(numberText);
  if (!Number.isFinite(parsed)) return null;
  return percent ? parsed / 100 : parsed;
}

function detectType(value: unknown): { type: DetectedType; numeric?: number } {
  const numeric = numericValue(value);
  if (numeric !== null) return { type: 'number', numeric };
  if (typeof value === 'boolean' || (typeof value === 'string' && /^(true|false)$/i.test(value.trim()))) {
    return { type: 'boolean' };
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})$/.test(text) && !Number.isNaN(Date.parse(text))) {
      return { type: 'date' };
    }
  }
  return { type: 'text' };
}

function quantile(sorted: readonly number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function compactNumber(value: number): number {
  return Number(value.toPrecision(12));
}

function analyzeColumn(cells: readonly SpreadsheetCellSnapshot[]) {
  const typeCounts: Record<DetectedType, number> = { number: 0, date: 0, boolean: 0, text: 0 };
  const distinct = new Map<string, { value: string | number | boolean | null; count: number }>();
  const numericValues: number[] = [];
  let blankCount = 0;
  let formulaCount = 0;

  for (const cell of cells) {
    if (cell.raw.startsWith('=')) formulaCount += 1;
    const value = cell.value;
    if (value === null || String(value).trim() === '') {
      blankCount += 1;
      continue;
    }
    const detected = detectType(value);
    typeCounts[detected.type] += 1;
    if (detected.numeric !== undefined) numericValues.push(detected.numeric);
    const safeValue = boundedValue(value);
    const key = `${detected.type}:${typeof value}:${String(value)}`;
    const existing = distinct.get(key);
    if (existing) existing.count += 1;
    else distinct.set(key, { value: safeValue, count: 1 });
  }

  const nonBlankCount = cells.length - blankCount;
  const presentTypes = (Object.entries(typeCounts) as [DetectedType, number][]).filter(([, count]) => count > 0);
  const dominantType = presentTypes.sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'text';
  const detectedType = presentTypes.length > 1 ? 'mixed' : dominantType;
  const duplicateValues = [...distinct.values()].filter((entry) => entry.count > 1);
  const duplicateCount = duplicateValues.reduce((count, entry) => count + entry.count - 1, 0);
  const distinctSample = [...distinct.values()].slice(0, DISTINCT_SAMPLE_LIMIT).map((entry) => entry.value);
  const duplicateSample = duplicateValues.slice(0, DISTINCT_SAMPLE_LIMIT).map((entry) => ({
    value: entry.value,
    count: entry.count,
  }));

  let numeric: Record<string, unknown> | undefined;
  let outlierCount = 0;
  if (numericValues.length > 0) {
    const sorted = [...numericValues].sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;
    const outliers = sorted.length >= 4
      ? sorted.filter((value) => value < lowerBound || value > upperBound)
      : [];
    outlierCount = outliers.length;
    numeric = {
      min: compactNumber(sorted[0]),
      max: compactNumber(sorted[sorted.length - 1]),
      mean: compactNumber(sum / sorted.length),
      median: compactNumber(quantile(sorted, 0.5)),
      outliers: {
        count: outlierCount,
        sample: outliers.slice(0, OUTLIER_SAMPLE_LIMIT).map(compactNumber),
        sampleLimit: OUTLIER_SAMPLE_LIMIT,
        truncated: outliers.length > OUTLIER_SAMPLE_LIMIT,
      },
    };
  }

  const flags = [
    blankCount > 0 ? 'blanks' : '',
    presentTypes.length > 1 ? 'mixed-types' : '',
    duplicateCount > 0 ? 'duplicates' : '',
    outlierCount > 0 ? 'outliers' : '',
  ].filter(Boolean);

  return {
    detectedType,
    typeCounts: Object.fromEntries(presentTypes),
    nonBlankCount,
    blankCount,
    formulaCount,
    distinctValues: {
      count: distinct.size,
      sample: distinctSample,
      sampleLimit: DISTINCT_SAMPLE_LIMIT,
      truncated: distinct.size > DISTINCT_SAMPLE_LIMIT,
    },
    duplicates: {
      duplicateCellCount: duplicateCount,
      values: duplicateSample,
      sampleLimit: DISTINCT_SAMPLE_LIMIT,
      truncated: duplicateValues.length > DISTINCT_SAMPLE_LIMIT,
    },
    ...(numeric ? { numeric } : {}),
    flags,
  };
}

async function resolveAnalysisTarget(api: SpreadsheetEditorAPI, scope: AnalysisScope) {
  const info = await api.getSheetInfo();
  if (info.rowCount === 0) throw new Error('The spreadsheet has no rows to analyze');

  if (scope === 'selection') {
    const selection = assertSelection(await api.getSelection(), info);
    return {
      info,
      logicalRows: selection.logicalRows.filter((row) => row >= info.metadata.headerRowCount),
      columnIndexes: Array.from(
        { length: selection.range.endCol - selection.range.startCol + 1 },
        (_, offset) => selection.range.startCol + offset,
      ),
    };
  }

  return {
    info,
    logicalRows: Array.from(
      { length: Math.max(0, info.rowCount - info.metadata.headerRowCount) },
      (_, offset) => info.metadata.headerRowCount + offset,
    ),
    columnIndexes: Array.from({ length: info.metadata.columnCount }, (_, index) => index),
  };
}

function headerLabel(headerCells: SpreadsheetCellSnapshot[][], columnOffset: number, columnIndex: number): string {
  for (let row = headerCells.length - 1; row >= 0; row -= 1) {
    const label = boundedValue(headerCells[row][columnOffset]?.value);
    if (label !== null && String(label).trim()) return String(label);
  }
  return columnIndexToLetter(columnIndex);
}

const analyzeDataTool: ExtensionAITool = {
  name: 'csv-spreadsheet.analyze_data',
  scope: 'global',
  access: { kind: 'editor-read' },
  description: 'Analyze spreadsheet columns for types, numeric statistics, blanks, mixed types, duplicates, and outliers. Set scope to selection to analyze only the user\'s current visible selection; filtered-out rows are excluded. The target file can be opened through filePath.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['sheet', 'selection'],
        default: 'sheet',
        description: 'Analyze the whole sheet or only the current visible selection.',
      },
    },
  },
  async handler(params, context) {
    const api = getEditorAPI(context);
    if (!api) return noEditorError(context);
    try {
      const scope = parseScope(params.scope, ['sheet', 'selection'] as const, 'sheet');
      const target = await resolveAnalysisTarget(api, scope);
      if (target.logicalRows.length === 0) throw new Error('The requested range contains no data rows');

      const requestedColumnCount = target.columnIndexes.length;
      const columnIndexes = target.columnIndexes.slice(0, MAX_ANALYZED_COLUMNS);
      const requestedRowCount = target.logicalRows.length;
      const rowWorkLimit = Math.max(1, Math.floor(MAX_ANALYZED_CELLS / columnIndexes.length));
      const logicalRows = target.logicalRows.slice(0, Math.min(MAX_ANALYZED_ROWS, rowWorkLimit));
      const headerRows = Array.from({ length: target.info.metadata.headerRowCount }, (_, index) => index);
      const headerCells = headerRows.length > 0
        ? await api.readCells(headerRows, columnIndexes)
        : [];
      const cellRows = await api.readCells(logicalRows, columnIndexes);
      const columns: Array<{
        columnIndex: number;
        column: string;
        label: string;
      } & ReturnType<typeof analyzeColumn>> = [];

      for (let offset = 0; offset < columnIndexes.length; offset += 1) {
        const columnIndex = columnIndexes[offset];
        const cells = cellRows.map((row) => row[offset]);
        columns.push({
          columnIndex,
          column: columnIndexToLetter(columnIndex),
          label: headerLabel(headerCells, offset, columnIndex),
          ...analyzeColumn(cells),
        });
      }

      const flagged = (flag: string) => columns
        .filter((column) => column.flags.includes(flag))
        .map((column) => column.columnIndex);

      return {
        success: true,
        data: {
          scope,
          rowCount: logicalRows.length,
          requestedRowCount,
          analyzedRowCount: logicalRows.length,
          rowsTruncated: requestedRowCount > logicalRows.length,
          requestedColumnCount,
          analyzedColumnCount: columns.length,
          columnsTruncated: requestedColumnCount > columns.length,
          columns,
          quality: {
            columnsWithBlanks: flagged('blanks'),
            mixedTypeColumns: flagged('mixed-types'),
            columnsWithDuplicates: flagged('duplicates'),
            columnsWithOutliers: flagged('outliers'),
          },
          limits: {
            maxAnalyzedColumns: MAX_ANALYZED_COLUMNS,
            maxAnalyzedRows: MAX_ANALYZED_ROWS,
            maxAnalyzedCells: MAX_ANALYZED_CELLS,
            distinctValueSamplePerColumn: DISTINCT_SAMPLE_LIMIT,
            duplicateValueSamplePerColumn: DISTINCT_SAMPLE_LIMIT,
            outlierSamplePerColumn: OUTLIER_SAMPLE_LIMIT,
            sampleTextCharacters: MAX_SAMPLE_TEXT,
          },
        },
      };
    } catch (error) {
      return errorResult(error);
    }
  },
};

function renderFormula(template: string, row: number, column: number): string {
  return template
    .replace(/\{row\}/g, String(row + 1))
    .replace(/\{column\}/g, columnIndexToLetter(column));
}

const applyFormulaTool: ExtensionAITool = {
  name: 'csv-spreadsheet.apply_formula',
  scope: 'global',
  access: { kind: 'editor-write' },
  description: 'Write raw formula text across a data column or the user\'s current visible selection. Use {row} for the 1-based sheet row and {column} for the destination column letter. Formulas are stored raw and evaluated only by the spreadsheet AST engine.',
  inputSchema: {
    type: 'object',
    properties: {
      formula: {
        type: 'string',
        description: 'Formula text beginning with =. Example: =SUM(C{row}:F{row}).',
      },
      scope: {
        type: 'string',
        enum: ['column', 'selection'],
        default: 'column',
        description: 'Apply to one full data column or every cell in the current visible selection.',
      },
      columnIndex: {
        type: 'number',
        description: 'Zero-based target column. Required when scope is column.',
      },
    },
    required: ['formula'],
  },
  async handler(params, context) {
    const api = getEditorAPI(context);
    if (!api) return noEditorError(context);
    try {
      if (typeof params.formula !== 'string' || !params.formula.startsWith('=')) {
        throw new Error('formula must be a string beginning with =');
      }
      if (params.formula.length > MAX_FORMULA_LENGTH) {
        throw new Error(`formula exceeds the ${MAX_FORMULA_LENGTH}-character limit`);
      }

      const scope = parseScope(params.scope, ['column', 'selection'] as const, 'column');
      const info = await api.getSheetInfo();
      let logicalRows: readonly number[];
      let columnIndexes: readonly number[];

      if (scope === 'selection') {
        const selection = assertSelection(await api.getSelection(), info);
        logicalRows = selection.logicalRows.filter((row) => row >= info.metadata.headerRowCount);
        columnIndexes = Array.from(
          { length: selection.range.endCol - selection.range.startCol + 1 },
          (_, offset) => selection.range.startCol + offset,
        );
      } else {
        const columnIndex = assertIndex('columnIndex', params.columnIndex, info.metadata.columnCount);
        logicalRows = Array.from(
          { length: Math.max(0, info.rowCount - info.metadata.headerRowCount) },
          (_, offset) => info.metadata.headerRowCount + offset,
        );
        columnIndexes = [columnIndex];
      }

      if (logicalRows.length === 0 || columnIndexes.length === 0) {
        throw new Error('The requested range contains no writable data cells');
      }
      for (const row of logicalRows) assertIndex('Row index', row, info.rowCount);
      for (const column of columnIndexes) assertIndex('Column index', column, info.metadata.columnCount);

      const targetCellCount = logicalRows.length * columnIndexes.length;
      if (targetCellCount > MAX_FORMULA_TARGET_CELLS) {
        throw new Error(
          `The requested range contains ${targetCellCount} cells; apply_formula is limited to ${MAX_FORMULA_TARGET_CELLS} cells per call`,
        );
      }

      const updates: Array<{ row: number; column: number; value: string }> = [];
      for (const row of logicalRows) {
        for (const column of columnIndexes) {
          const formula = renderFormula(params.formula, row, column);
          if (formula.length > MAX_FORMULA_LENGTH) {
            throw new Error(
              `Rendered formula for ${columnIndexToLetter(column)}${row + 1} exceeds the ${MAX_FORMULA_LENGTH}-character limit`,
            );
          }
          updates.push({ row, column, value: formula });
        }
      }

      const updated = await api.updateCells(updates);
      const samples = updated.slice(0, DISTINCT_SAMPLE_LIMIT).map((cell) => ({
        cell: `${columnIndexToLetter(cell.column)}${cell.row + 1}`,
        raw: String(boundedValue(cell.raw) ?? ''),
        displayed: cell.value,
      }));

      return {
        success: true,
        data: {
          scope,
          updatedCellCount: updates.length,
          rowCount: logicalRows.length,
          columnIndexes,
          formulaTemplate: params.formula,
          samples,
          samplesTruncated: updates.length > samples.length,
          formulaStorage: 'raw',
          limits: {
            maxTargetCells: MAX_FORMULA_TARGET_CELLS,
            maxFormulaCharacters: MAX_FORMULA_LENGTH,
          },
        },
      };
    } catch (error) {
      return errorResult(error);
    }
  },
};

export const aiTools: ExtensionAITool[] = [analyzeDataTool, applyFormulaTool];
