/**
 * Read tools: `read_range` (cells as stored and as shown) and `describe_sheet`
 * (shape, columns, filters and the user's selection).
 */

import type { ExtensionAITool } from '@nimbalyst/extension-sdk';
import type { ColumnFilter, ColumnFilterState } from '../types';
import { isFormulaText } from '../commands/sheetState';
import { columnIndexToLetter } from '../utils/csvParser';
import { detectColumnType } from '../utils/formatters';
import { parseA1Range, rangeName, resolveRange } from './a1';
import {
  MAX_TOOL_CELLS,
  clipText,
  columnName,
  getEditor,
  usedSize,
  withAgent,
} from './toolSupport';
import { validationIn } from './validationTools';

const MAX_DESCRIBED_COLUMNS = 200;
const TYPE_SAMPLE_ROWS = 500;
const FILTER_VALUE_SAMPLE = 20;
const MAX_HIDDEN_ROWS_LISTED = 200;

const readRangeTool: ExtensionAITool = {
  name: 'csv-spreadsheet.read_range',
  scope: 'global',
  access: { kind: 'editor-read' },
  description: 'Read a range of the spreadsheet in A1 notation (row 1 is the first line of the file, header rows included). Returns each cell\'s raw stored text (formulas as written) and its displayed value (formula results), plus column names and formats and the validation rules that touch the range. Accepts "B2", "A1:C10", whole columns "B:D" and whole rows "2:5"; open ranges stop at the used range. Large ranges are truncated to the first rows that fit the cell limit; check truncated and returnedRange. Rows hidden by a filter are included and listed in hiddenRows.',
  inputSchema: {
    type: 'object',
    properties: {
      range: { type: 'string', description: 'A1 range, e.g. "A1:F50", "C:C" or "1:1".' },
    },
    required: ['range'],
  },
  handler: (params, context) => withAgent(context, async (agent) => {
    const requested = parseA1Range(params.range);
    const view = await agent.read();
    const used = usedSize(view.state);
    const bounds = resolveRange(requested, used.rows, used.cols);
    const rowCount = bounds.endRow - bounds.startRow + 1;
    const colCount = bounds.endCol - bounds.startCol + 1;
    const returnedCols = Math.min(colCount, MAX_TOOL_CELLS);
    const returnedRows = Math.min(rowCount, Math.max(1, Math.floor(MAX_TOOL_CELLS / returnedCols)));
    const returned = {
      ...bounds,
      endRow: bounds.startRow + returnedRows - 1,
      endCol: bounds.startCol + returnedCols - 1,
    };

    const cols = Array.from({ length: returnedCols }, (_, i) => returned.startCol + i);
    const raw: string[][] = [];
    const display: (string | number | null)[][] = [];
    let formulaCount = 0;
    for (let row = returned.startRow; row <= returned.endRow; row += 1) {
      raw.push(cols.map((col) => {
        const text = view.state.rows[row]?.[col] ?? '';
        if (isFormulaText(text)) formulaCount += 1;
        return clipText(text);
      }));
      display.push(cols.map((col) => clipText(view.display(row, col))));
    }

    const visible = new Set(view.visibleRows);
    const hiddenRows: number[] = [];
    for (let row = Math.max(returned.startRow, view.state.meta.headerRowCount); row <= Math.min(returned.endRow, used.rows - 1); row += 1) {
      if (!visible.has(row)) hiddenRows.push(row + 1);
    }

    return {
      requestedRange: rangeName(bounds),
      returnedRange: rangeName(returned),
      truncated: returnedRows < rowCount || returnedCols < colCount,
      usedRange: rangeName({ startRow: 0, startCol: 0, endRow: Math.max(0, used.rows - 1), endCol: Math.max(0, used.cols - 1) }),
      headerRowCount: view.state.meta.headerRowCount,
      columns: cols.map((col) => ({
        column: columnIndexToLetter(col),
        name: columnName(view, col),
        ...(view.state.meta.columnFormats[col] ? { format: view.state.meta.columnFormats[col] } : {}),
      })),
      raw,
      display,
      formulaCount,
      ...validationIn(view.state.meta.validation, returned),
      hiddenRows: hiddenRows.slice(0, MAX_HIDDEN_ROWS_LISTED),
      hiddenRowsTruncated: hiddenRows.length > MAX_HIDDEN_ROWS_LISTED,
      limits: { maxCells: MAX_TOOL_CELLS },
    };
  }),
};

function describeFilter(filter: ColumnFilter): Record<string, unknown> {
  if (filter.kind !== 'values') return { ...filter };
  const values = [...filter.values];
  return { kind: 'values', values: values.slice(0, FILTER_VALUE_SAMPLE), valuesTruncated: values.length > FILTER_VALUE_SAMPLE };
}

function describeFilters(filters: ColumnFilterState | null) {
  if (!filters) return null;
  return [...filters.entries()].map(([col, filter]) => ({ column: columnIndexToLetter(col), ...describeFilter(filter) }));
}

const describeSheetTool: ExtensionAITool = {
  name: 'csv-spreadsheet.describe_sheet',
  scope: 'global',
  access: { kind: 'editor-read' },
  description: 'Describe the spreadsheet before reading or editing it: used range (A1), header row count, frozen columns, every column\'s letter, header name, configured format and detected type, data row count, active filters and how many rows they hide, validation rules, and the user\'s current selection. Call this first, then read_range for cell contents.',
  inputSchema: { type: 'object', properties: {} },
  handler: (_params, context) => withAgent(context, async (agent) => {
    const editor = getEditor(context);
    const view = await agent.read();
    const { meta } = view.state;
    const used = usedSize(view.state);
    const bodyRows = Array.from(
      { length: Math.max(0, Math.min(used.rows, meta.headerRowCount + TYPE_SAMPLE_ROWS) - meta.headerRowCount) },
      (_, i) => meta.headerRowCount + i,
    );
    const describedCols = Math.min(used.cols, MAX_DESCRIBED_COLUMNS);
    const columns = Array.from({ length: describedCols }, (_, col) => {
      const values = bodyRows.map((row) => view.display(row, col));
      const format = meta.columnFormats[col];
      return {
        column: columnIndexToLetter(col),
        name: columnName(view, col),
        format: format ?? null,
        detectedType: detectColumnType(values),
        nonBlankSampled: values.filter((value) => value !== null && String(value).trim() !== '').length,
      };
    });

    const hiddenRowCount = Math.max(0, used.rows - meta.headerRowCount)
      - view.visibleRows.filter((row) => row >= meta.headerRowCount && row < used.rows).length;
    const selection = editor ? await editor.getSelection() : null;
    const filters = describeFilters(agent.getColumnFilters());

    return {
      usedRange: rangeName({ startRow: 0, startCol: 0, endRow: Math.max(0, used.rows - 1), endCol: Math.max(0, used.cols - 1) }),
      rowCount: used.rows,
      headerRowCount: meta.headerRowCount,
      dataRowCount: Math.max(0, used.rows - meta.headerRowCount),
      columnCount: used.cols,
      frozenColumnCount: meta.frozenColumnCount,
      delimiter: editor?.getMetadata().delimiter ?? ',',
      columns,
      columnsTruncated: used.cols > describedCols,
      typeSampleRows: bodyRows.length,
      filters: {
        hiddenRowCount,
        // null: this editor does not expose its filter definitions, only their effect.
        columns: filters,
      },
      selection: selection
        ? { range: rangeName(selection.range), visibleRowCount: selection.logicalRows.length }
        : null,
      styledRangeCount: Object.keys(meta.cellStyles ?? {}).length,
      formattedColumnCount: Object.keys(meta.columnFormats).length,
      // Usable in formulas in place of a range: =SUM(Sales).
      namedRanges: meta.namedRanges ?? {},
      ...validationIn(meta.validation, { startRow: 0, startCol: 0, endRow: Number.MAX_SAFE_INTEGER, endCol: Number.MAX_SAFE_INTEGER }),
    };
  }),
};

export const readTools: ExtensionAITool[] = [readRangeTool, describeSheetTool];
