// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { RevoGridElement } from '../../revogrid-types';
import { parseCSV, columnIndexToLetter } from '../csvParser';
import {
  createGridOperations,
  FormulaViewState,
  spreadsheetDataToGridSource,
} from '../gridOperations';
import { createSpreadsheetEditorAPI } from '../../editorAPI';
import { aiTools } from '../../aiTools';

vi.mock('@nimbalyst/extension-sdk', () => ({
  copyToClipboard: vi.fn(async () => undefined),
}));

function createFormulaGrid(content: string) {
  const parsed = parseCSV(content);
  const formulaViewState = new FormulaViewState();
  const gridData = spreadsheetDataToGridSource(parsed.data, 0, 0);
  formulaViewState.recalculate(parsed.data, gridData);

  let columnCount = parsed.data.columnCount;
  let source = gridData.source;
  let pinnedTopSource = gridData.pinnedTop;
  let nextRefreshError: Error | null = null;
  const grid = {
    get source() { return source; },
    set source(value) { source = value; },
    get pinnedTopSource() { return pinnedTopSource; },
    set pinnedTopSource(value) { pinnedTopSource = value; },
    getSource(rowType: string) {
      return Promise.resolve(rowType === 'rowPinStart' ? pinnedTopSource : source);
    },
    setDataAt({ row, col, val, rowType, colType }: {
      row: number;
      col: number;
      val: unknown;
      rowType: string;
      colType: string;
    }) {
      const rows = rowType === 'rowPinStart' ? pinnedTopSource : source;
      const absoluteCol = colType === 'rgCol' ? col + parsed.data.frozenColumnCount : col;
      rows[row][columnIndexToLetter(absoluteCol)] = val as string | number;
      return Promise.resolve();
    },
    refresh() {
      if (nextRefreshError) {
        const error = nextRefreshError;
        nextRefreshError = null;
        return Promise.reject(error);
      }
      return Promise.resolve();
    },
  } as unknown as RevoGridElement;

  const operations = createGridOperations({ current: grid }, {
    getHeaderRowCount: () => parsed.data.headerRowCount,
    getColumnCount: () => columnCount,
    setColumnCount: (count) => { columnCount = count; },
    getDelimiter: () => parsed.delimiter,
    getColumnFormats: () => parsed.data.columnFormats,
    getColumnWidths: () => ({}),
    getFrozenColumnCount: () => parsed.data.frozenColumnCount,
    onDirty: () => undefined,
    getUndoPlugin: () => null,
    formulaViewState,
  });

  const api = createSpreadsheetEditorAPI({
    operations,
    getMetadata: () => ({
      columnCount,
      headerRowCount: parsed.data.headerRowCount,
      hasHeaders: parsed.data.hasHeaders,
      frozenColumnCount: parsed.data.frozenColumnCount,
      columnFormats: parsed.data.columnFormats,
      delimiter: parsed.delimiter,
    }),
    getSelection: async () => null,
    getDisplayValue: (model, prop) => formulaViewState.getDisplayValue(model, prop),
  });

  return {
    parsed,
    grid,
    gridData,
    formulaViewState,
    operations,
    api,
    failNextRefresh(error: Error) {
      nextRefreshError = error;
    },
  };
}

function tool(name: string) {
  const match = aiTools.find((candidate) => candidate.name === name);
  if (!match) throw new Error(`Missing tool: ${name}`);
  return match;
}

describe('formula grid wiring', () => {
  it('round-trips raw formulas while deriving their displayed values', async () => {
    const input = [
      '# nimbalyst: {"hasHeaders":true,"headerRowCount":1,"frozenColumnCount":2}',
      'Region,Rep,Q1,Q2,Q3,Q4,Total',
      'North,Alice,100,110,120,130,=SUM(C2:F2)',
    ].join('\n');
    const { gridData, formulaViewState, operations, api } = createFormulaGrid(input);

    expect(gridData.source[0].G).toBe('=SUM(C2:F2)');
    expect(formulaViewState.getDisplayValue(gridData.source[0], 'G')).toBe(460);

    const output = await operations.toCSV();
    expect(output).toContain('=SUM(C2:F2)');
    expect(output).not.toContain(',460');
    expect(parseCSV(output).data.rows[1][6].raw).toBe('=SUM(C2:F2)');

    const result = await tool('csv-spreadsheet.apply_formula').handler({
      formula: '=SUM(C{row}:F{row})+1',
      scope: 'column',
      columnIndex: 6,
    }, { editorAPI: api } as any);

    expect(result.success).toBe(true);
    const { source } = await operations.getData();
    expect(source[0].G).toBe('=SUM(C2:F2)+1');
    expect(formulaViewState.getDisplayValue(source[0], 'G')).toBe(461);

    const formulaOutput = await operations.toCSV();
    expect(formulaOutput).toContain('=SUM(C2:F2)+1');
    expect(formulaOutput).not.toContain(',461');
    expect(parseCSV(formulaOutput).data.rows[1][6].raw).toBe('=SUM(C2:F2)+1');
  });

  it('recalculates dependents after a live edit and exposes cycle errors', async () => {
    const input = [
      'Value,Total',
      '1,=SUM(A2:A4)',
      '2,',
      '3,',
    ].join('\n');
    const { gridData, formulaViewState, operations } = createFormulaGrid(input);

    expect(formulaViewState.getDisplayValue(gridData.source[0], 'B')).toBe(6);

    await operations.updateCell(1, 0, '10');

    expect(gridData.source[0].B).toBe('=SUM(A2:A4)');
    let current = await operations.getData();
    expect(formulaViewState.getDisplayValue(current.source[0], 'B')).toBe(15);

    await operations.updateCell(1, 0, '=B2');
    await operations.updateCell(1, 1, '=A2');

    current = await operations.getData();
    expect(formulaViewState.getDisplayValue(current.source[0], 'A')).toBe('#CIRC!');
    expect(formulaViewState.getDisplayValue(current.source[0], 'B')).toBe('#CIRC!');
  });

  it('rejects an out-of-bounds tool column without changing the sheet', async () => {
    const { api, operations, parsed } = createFormulaGrid('Name,Total\nAlice,1');
    const before = await operations.toCSV();

    const result = await tool('csv-spreadsheet.apply_formula').handler({
      formula: '=1+1',
      columnIndex: parsed.data.columnCount,
    }, { editorAPI: api } as any);

    expect(result.success).toBe(false);
    expect(result.error).toContain('out of bounds');
    expect(await operations.toCSV()).toBe(before);
  });

  it('rolls back the whole apply_formula batch when the grid update fails', async () => {
    const { api, operations, failNextRefresh } = createFormulaGrid('Name,Total\nAlice,1\nBob,2\nCara,3');
    const before = await operations.toCSV();
    failNextRefresh(new Error('grid refresh failed'));

    const result = await tool('csv-spreadsheet.apply_formula').handler({
      formula: '=A{row}',
      columnIndex: 1,
    }, { editorAPI: api } as any);

    expect(result).toMatchObject({ success: false, error: 'grid refresh failed' });
    expect(await operations.toCSV()).toBe(before);
  });

  it('returns compact statistics and quality flags for a small sheet', async () => {
    const input = [
      '# nimbalyst: {"hasHeaders":true,"headerRowCount":1}',
      'Name,Score',
      'A,10',
      'A,11',
      ',12',
      'B,100',
    ].join('\n');
    const { api } = createFormulaGrid(input);

    const result = await tool('csv-spreadsheet.analyze_data').handler({}, { editorAPI: api } as any);
    const data = result.data as any;

    expect(result.success).toBe(true);
    expect(data.rowCount).toBe(4);
    expect(data.columns[0]).toMatchObject({
      label: 'Name',
      detectedType: 'text',
      blankCount: 1,
      duplicates: { duplicateCellCount: 1 },
    });
    expect(data.columns[1]).toMatchObject({
      label: 'Score',
      detectedType: 'number',
      numeric: { min: 10, max: 100, outliers: { count: 1 } },
    });
    expect(data.limits.distinctValueSamplePerColumn).toBe(10);
  });
});
