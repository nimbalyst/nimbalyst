/**
 * Cell write tools: `write_range` and `sort`. Each call is one `SheetCommand`
 * with origin `agent` (one undo step), validated in full before anything is
 * written.
 */

import type { ExtensionAITool } from '@nimbalyst/extension-sdk';
import { buildSort } from '../commands/builders';
import { contentRowCount, isFormulaText, type CellWrite } from '../commands/sheetState';
import { columnIndexToLetter } from '../utils/csvParser';
import { getSortKey } from '../utils/formatters';
import { MAX_SHEET_COLUMNS, MAX_SHEET_ROWS, cellName, parseA1Cell, parseColumnLetter, rangeName } from './a1';
import {
  MAX_CELL_TEXT,
  MAX_FORMULA_LENGTH,
  MAX_TOOL_CELLS,
  columnName,
  flashWritten,
  sampleCells,
  usedSize,
  withAgent,
} from './toolSupport';

function cellText(value: unknown, row: number, col: number, valuesOnly: boolean): string {
  const where = cellName(row, col);
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (typeof value === 'boolean') text = value ? 'TRUE' : 'FALSE';
  else if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Value for ${where} is not a finite number`);
    text = String(value);
  } else if (typeof value === 'string') text = value;
  else throw new Error(`Value for ${where} must be a string, number, boolean or null`);

  if (isFormulaText(text)) {
    if (valuesOnly) {
      throw new Error(`Value for ${where} starts with "=" but valuesOnly is set; CSV cannot store literal text that starts with "=", so write it without the "="`);
    }
    if (text.length > MAX_FORMULA_LENGTH) throw new Error(`Formula for ${where} exceeds the ${MAX_FORMULA_LENGTH}-character limit`);
  } else if (text.length > MAX_CELL_TEXT) {
    throw new Error(`Value for ${where} exceeds the ${MAX_CELL_TEXT}-character limit`);
  }
  return text;
}

const writeRangeTool: ExtensionAITool = {
  name: 'csv-spreadsheet.write_range',
  scope: 'global',
  access: { kind: 'editor-write' },
  description: 'Write a 2D block of values and formulas starting at an anchor cell in A1 notation (row 1 is the first line of the file, header rows included). values is rows of cells; strings starting with "=" are formulas, null or "" clears a cell, rows may differ in length. The anchor must be inside the used range or directly after it (to append rows or columns). Rows hidden by a filter are written too. The whole block is one undo step and nothing is written if any cell is invalid. Set valuesOnly to refuse formulas, e.g. when writing imported data.',
  inputSchema: {
    type: 'object',
    properties: {
      anchor: { type: 'string', description: 'Top-left cell, e.g. "B2".' },
      values: {
        type: 'array',
        description: 'Rows of cell values: string, number, boolean or null.',
        items: { type: 'array', description: 'One row of cells.' },
      },
      valuesOnly: { type: 'boolean', default: false, description: 'Reject any value that would be stored as a formula.' },
    },
    required: ['anchor', 'values'],
  },
  handler: (params, context) => withAgent(context, async (agent) => {
    const anchor = parseA1Cell(params.anchor, 'anchor');
    const valuesOnly = params.valuesOnly === true;
    if (!Array.isArray(params.values) || params.values.length === 0) throw new Error('values must be a non-empty array of rows');
    let cellCount = 0;
    let width = 0;
    params.values.forEach((row, r) => {
      if (!Array.isArray(row)) throw new Error(`values[${r}] must be an array of cells`);
      cellCount += row.length;
      width = Math.max(width, row.length);
    });
    if (cellCount === 0) throw new Error('values contains no cells');
    if (cellCount > MAX_TOOL_CELLS) throw new Error(`values contains ${cellCount} cells; write_range is limited to ${MAX_TOOL_CELLS} cells per call`);
    if (anchor.row + params.values.length > MAX_SHEET_ROWS || anchor.col + width > MAX_SHEET_COLUMNS) {
      throw new Error('values extend past the last row or column of the sheet');
    }

    const writes: CellWrite[] = [];
    (params.values as unknown[][]).forEach((row, r) => row.forEach((value, c) => {
      writes.push({ row: anchor.row + r, col: anchor.col + c, value: cellText(value, anchor.row + r, anchor.col + c, valuesOnly) });
    }));

    let changedCells = 0;
    const result = await agent.run((view) => {
      const used = usedSize(view.state);
      if (anchor.row > used.rows || anchor.col > used.cols) {
        throw new Error(`Anchor ${cellName(anchor.row, anchor.col)} is past the end of the sheet; the used range ends at ${cellName(Math.max(0, used.rows - 1), Math.max(0, used.cols - 1))}, so start at row ${used.rows + 1} or column ${columnIndexToLetter(used.cols)} at the latest`);
      }
      changedCells = writes.filter((w) => (view.state.rows[w.row]?.[w.col] ?? '') !== w.value).length;
      return { type: 'setCells', cells: writes };
    });

    const cells = writes.map((w) => ({ row: w.row, column: w.col }));
    await flashWritten(agent, cells);
    return {
      writtenRange: rangeName({
        startRow: anchor.row,
        startCol: anchor.col,
        endRow: anchor.row + params.values.length - 1,
        endCol: anchor.col + width - 1,
      }),
      cellCount: writes.length,
      changedCellCount: result.changed ? changedCells : 0,
      formulaCount: writes.filter((w) => isFormulaText(w.value)).length,
      samples: sampleCells(result.after, cells),
      limits: { maxCells: MAX_TOOL_CELLS, maxFormulaCharacters: MAX_FORMULA_LENGTH, maxCellCharacters: MAX_CELL_TEXT },
    };
  }),
};

const sortTool: ExtensionAITool = {
  name: 'csv-spreadsheet.sort',
  scope: 'global',
  access: { kind: 'editor-write' },
  description: 'Sort the data rows by one column, ascending or descending. Header rows (headerRowCount from describe_sheet) stay in place; blanks sort last in both directions; ties keep their order. Values compare by the column\'s type (numbers, dates, text). Formulas move with their rows and their references are not rewritten.',
  inputSchema: {
    type: 'object',
    properties: {
      column: { type: 'string', description: 'Column letter to sort by, e.g. "C".' },
      direction: { type: 'string', enum: ['asc', 'desc'], default: 'asc' },
    },
    required: ['column'],
  },
  handler: (params, context) => withAgent(context, async (agent) => {
    const col = parseColumnLetter(params.column);
    const direction = params.direction ?? 'asc';
    if (direction !== 'asc' && direction !== 'desc') throw new Error('direction must be "asc" or "desc"');

    let name = '';
    let start = 0;
    let end = 0;
    let usedCols = 0;
    const result = await agent.run((view) => {
      const { state } = view;
      usedCols = usedSize(state).cols;
      if (col >= usedCols) throw new Error(`Column ${params.column} is outside the used columns (A to ${columnIndexToLetter(Math.max(0, usedCols - 1))})`);
      start = state.meta.headerRowCount;
      end = Math.max(start, contentRowCount(state.rows));
      if (end - start < 2) throw new Error('There are fewer than two data rows to sort');
      name = columnName(view, col);
      const format = state.meta.columnFormats[col];
      return buildSort(state, direction, (row) => getSortKey(view.display(row, col), format));
    });

    const cells = [];
    for (let row = start; row < end; row += 1) cells.push({ row, column: col });
    if (result.changed) await flashWritten(agent, cells);
    return {
      column: params.column,
      columnName: name,
      direction,
      sortedRange: rangeName({ startRow: start, endRow: end - 1, startCol: 0, endCol: Math.max(0, usedCols - 1) }),
      headerRowCount: start,
      rowCount: end - start,
      changed: result.changed,
    };
  }),
};

export const writeTools: ExtensionAITool[] = [writeRangeTool, sortTool];
