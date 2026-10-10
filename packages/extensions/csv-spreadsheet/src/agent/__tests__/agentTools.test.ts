// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { AIToolContext } from '@nimbalyst/extension-sdk';
import { aiTools } from '../../aiTools';
import { createSpreadsheetEditorAPI } from '../../editorAPI';
import { createGridOperations, FormulaViewState } from '../../utils/gridOperations';
import { createFakeGrid, createMetaStore } from '../../commands/__tests__/fakeGrid';
import { parseA1Range, parseColumnLetter } from '../a1';
import { renderValueCell, URL_CELL_ATTRIBUTE, type HyperFunc } from '../../cells/cellRendering';

vi.mock('@nimbalyst/extension-sdk', () => ({ copyToClipboard: vi.fn(async () => undefined), readClipboard: vi.fn(async () => '') }));

const CSV = [
  '# nimbalyst: {"hasHeaders":true,"headerRowCount":1}',
  'Name,Qty,Price,Total',
  'Pears,3,2,=B2*C2',
  'Apples,10,1,=B3*C3',
  'Plums,,5,=SUM(B2:B4)',
].join('\n');

function setup(csv = CSV) {
  const { grid, parsed } = createFakeGrid(csv);
  const metaStore = createMetaStore(parsed);
  const formulaViewState = new FormulaViewState();
  const operations = createGridOperations({ current: grid }, { ...metaStore, getDelimiter: () => ',', formulaViewState });
  const flashed: { row: number; column: number }[][] = [];
  const api = createSpreadsheetEditorAPI({
    operations,
    getMetadata: () => {
      const meta = metaStore.getMeta();
      return { ...meta, hasHeaders: meta.headerRowCount > 0, delimiter: ',' };
    },
    getSelection: async () => null,
    getDisplayValue: (model, prop) => formulaViewState.getDisplayValue(model as Record<string, unknown>, prop),
    flashCells: (cells) => { flashed.push([...cells]); },
  });
  const context = { editorAPI: api, extensionContext: {} } as unknown as AIToolContext;
  const call = async (name: string, params: Record<string, unknown> = {}) => {
    const tool = aiTools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool.handler(params, context) as Promise<{ success: boolean; data?: any; error?: string }>;
  };
  return { api, operations, metaStore, flashed, call };
}

describe('spreadsheet agent tools', () => {
  it('write_range writes values and formulas as one undoable agent step and flashes them', async () => {
    const { call, operations, flashed } = setup();
    await operations.recalculateFormulas();

    const result = await call('csv-spreadsheet.write_range', { anchor: 'B4', values: [[4, 3, '=B4*C4'], [1, 1, null]] });
    expect(result.error).toBeUndefined();
    expect(result.data.writtenRange).toBe('B4:D5');
    expect(result.data.samples[2]).toMatchObject({ cell: 'D4', raw: '=B4*C4', displayed: 12 });
    expect(flashed.at(-1)).toHaveLength(6);

    const read = await call('csv-spreadsheet.read_range', { range: 'A4:D5' });
    expect(read.data.raw).toEqual([['Plums', '4', '3', '=B4*C4'], ['', '1', '1', '']]);

    expect(await operations.executor.undo()).toBe(true);
    const undone = await call('csv-spreadsheet.read_range', { range: 'B4:D4' });
    expect(undone.data.raw).toEqual([['', '5', '=SUM(B2:B4)']]);
    expect(operations.executor.canUndo).toBe(false);
  });

  it('rejects an invalid write without writing anything or recording an undo step', async () => {
    const { call, operations } = setup();
    const before = await operations.toCSV();
    const failures = [
      [{ anchor: 'A2', values: [['ok', '=1+1']], valuesOnly: true }, /B2 starts with "="/],
      [{ anchor: 'A9', values: [['x']] }, /past the end of the sheet/],
      [{ anchor: 'A2', values: [[{}]] }, /A2 must be a string, number, boolean or null/],
      [{ anchor: 'A2', values: Array.from({ length: 101 }, () => Array(100).fill(1)) }, /limited to 10000 cells/],
      [{ anchor: 'A0', values: [[1]] }, /Row numbers start at 1/],
    ] as const;
    for (const [params, message] of failures) {
      const result = await call('csv-spreadsheet.write_range', params as unknown as Record<string, unknown>);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(message);
    }
    expect(await operations.toCSV()).toBe(before);
    expect(operations.executor.canUndo).toBe(false);
  });

  it('parses A1 ranges with multi-letter columns, whole rows and whole columns', () => {
    expect(parseColumnLetter('AA')).toBe(26);
    expect(parseColumnLetter('xfd')).toBe(16383);
    expect(() => parseColumnLetter('XFE')).toThrow(/past the last column/);
    expect(parseA1Range('$C$10:AB2')).toEqual({ startRow: 1, endRow: 9, startCol: 2, endCol: 27 });
    expect(parseA1Range('B:D')).toEqual({ startRow: null, endRow: null, startCol: 1, endCol: 3 });
    expect(parseA1Range('3:2')).toEqual({ startRow: 1, endRow: 2, startCol: null, endCol: null });
    expect(() => parseA1Range('A1:C')).toThrow(/mixes a cell/);
    expect(() => parseA1Range('B')).toThrow(/write a whole column as "B:B"/);
  });

  it('inserts and deletes rows and columns with formulas rewritten, one undo step each', async () => {
    const { call, operations, metaStore } = setup();
    const inserted = await call('csv-spreadsheet.insert_rows', { row: 3, count: 2 });
    expect(inserted.data).toMatchObject({ inserted: '3:4', formulasRewritten: 2, formulasBrokenToRef: 0, headerRowCount: 1 });
    let read = await call('csv-spreadsheet.read_range', { range: 'D:D' });
    expect(read.data.raw.map((row: string[]) => row[0])).toEqual(['Total', '=B2*C2', '', '', '=B5*C5', '=SUM(B2:B6)']);

    const deleted = await call('csv-spreadsheet.delete_cols', { column: 'B' });
    expect(deleted.data).toMatchObject({ deleted: 'B:B', formulasBrokenToRef: 3, columnCount: 3 });
    expect((await call('csv-spreadsheet.read_range', { range: 'C2' })).data.raw[0][0]).toContain('#REF!');

    await operations.executor.undo();
    await operations.executor.undo();
    read = await call('csv-spreadsheet.read_range', { range: 'A1:D4' });
    expect(read.data.raw[3]).toEqual(['Plums', '', '5', '=SUM(B2:B4)']);
    expect(metaStore.getMeta().columnCount).toBe(4);
    expect(operations.executor.canUndo).toBe(false);

    const outOfRange = await call('csv-spreadsheet.delete_rows', { row: 4, count: 3 });
    expect(outOfRange.error).toMatch(/Cannot delete rows 4:6; the sheet ends at row 4/);
  });

  it('sorts data rows by display value with the header fixed and blanks last', async () => {
    const { call, operations } = setup();
    await operations.recalculateFormulas();
    const result = await call('csv-spreadsheet.sort', { column: 'D', direction: 'desc' });
    expect(result.data).toMatchObject({ columnName: 'Total', sortedRange: 'A2:D4', rowCount: 3, changed: true });
    const read = await call('csv-spreadsheet.read_range', { range: 'A:A' });
    // Totals: Pears 6, Apples 10, Plums SUM(B2:B4) = 13.
    expect(read.data.raw.map((row: string[]) => row[0])).toEqual(['Name', 'Plums', 'Apples', 'Pears']);
    expect((await call('csv-spreadsheet.sort', { column: 'Q' })).error).toMatch(/outside the used columns \(A to D\)/);
  });

  it('sets a column format and a range style as one undo step and validates fields', async () => {
    const { call, operations, metaStore } = setup();
    const result = await call('csv-spreadsheet.set_format', {
      columns: 'C:D',
      format: { type: 'currency', currency: 'EUR', decimals: 2 },
      range: 'A1:D1',
      style: { bold: true, fillColor: 'blue' },
    });
    expect(result.data).toMatchObject({ changed: true, formattedColumns: 'C:D', styledRange: 'A1:D1' });
    expect(metaStore.getMeta().columnFormats[3]).toEqual({ type: 'currency', currency: 'EUR', decimals: 2 });
    expect(metaStore.getMeta().cellStyles['A1:D1']).toEqual({ bold: true, fillColor: 'blue' });

    await operations.executor.undo();
    expect(metaStore.getMeta().columnFormats[3]).toBeUndefined();
    expect(metaStore.getMeta().cellStyles['A1:D1']).toBeUndefined();

    expect((await call('csv-spreadsheet.set_format', { columns: 'C', format: { type: 'money' } })).error).toMatch(/format.type must be text, number/);
    expect((await call('csv-spreadsheet.set_format', { range: 'A1', style: { blink: true } })).error).toMatch(/style.blink is not a known field/);
    expect((await call('csv-spreadsheet.set_format', { columns: 'C', format: { decimals: 1 } })).error).toMatch(/format.type is required/);
  });

  it('describes the sheet and truncates large reads to the cell limit', async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => `${i},${i * 2},x,2026-01-0${(i % 9) + 1}`);
    const { call } = setup(['# nimbalyst: {"hasHeaders":true,"headerRowCount":1}', 'Id,Double,Tag,When', ...rows].join('\n'));
    const described = await call('csv-spreadsheet.describe_sheet');
    expect(described.data).toMatchObject({ usedRange: 'A1:D3001', headerRowCount: 1, dataRowCount: 3000, columnCount: 4 });
    expect(described.data.columns.map((c: { name: string; detectedType: string }) => [c.name, c.detectedType]))
      .toEqual([['Id', 'number'], ['Double', 'number'], ['Tag', 'text'], ['When', 'date']]);

    const read = await call('csv-spreadsheet.read_range', { range: 'A:D' });
    expect(read.data).toMatchObject({ requestedRange: 'A1:D3001', returnedRange: 'A1:D2500', truncated: true });
  });

  it('R4-5: a HYPERLINK in an unformatted cell reads, copies and renders as its label', async () => {
    const { call, api, operations } = setup(CSV.replace('Pears,3,2,=B2*C2', 'Pears,3,2,"=HYPERLINK(""https://a.test"",""Docs"")"'));
    await operations.recalculateFormulas();
    expect((await call('csv-spreadsheet.read_range', { range: 'D2' })).data.display).toEqual([['Docs']]);
    expect((await api.readCells([1], [3]))[0][0].value).toBe('Docs');
    expect((await operations.copySelection({ startRow: 1, endRow: 1, startCol: 3, endCol: 3 }))?.text).toBe('Docs');

    const h = ((tag: string, props: Record<string, unknown>, children?: unknown) => ({ tag, props, children })) as unknown as HyperFunc;
    const displayed = (await operations.getCellValue(1, 3)) as string;
    expect(renderValueCell(h, displayed, undefined)).toMatchObject({ props: { [URL_CELL_ATTRIBUTE]: 'https://a.test' }, children: 'Docs' });
    expect(renderValueCell(h, displayed, { type: 'number', decimals: 2 })).toMatchObject({ children: 'Docs' });
    expect(renderValueCell(h, 12, { type: 'number', decimals: 2 })).toMatchObject({ children: '12.00' });
  });

  it('R3-5: keeps frozen data rows as logical rows for getSheetInfo and readCells', async () => {
    const { api } = setup(CSV.replace('"headerRowCount":1}', '"headerRowCount":1,"frozenRowCount":2}'));
    const info = await api.getSheetInfo();
    expect(info.rowCount).toBe(4);
    const cells = await api.readCells([1, 2, 3], [0]);
    expect(cells.map((row) => row[0].raw)).toEqual(['Pears', 'Apples', 'Plums']);
  });

  it('R3-6: refuses an insert that would push the sheet past the last column', async () => {
    const { call, metaStore, operations } = setup();
    metaStore.setMeta({ ...metaStore.getMeta(), columnCount: 16_384 });
    const result = await call('csv-spreadsheet.insert_cols', { column: 'B', count: 1 });
    expect(result.error).toMatch(/past the last column/);
    expect(operations.executor.canUndo).toBe(false);
  });

  it('set_validation sets, reports and clears rules as one undo step each, all-or-nothing', async () => {
    const { call, operations, metaStore, flashed } = setup();
    const set = await call('csv-spreadsheet.set_validation', {
      range: 'B2:B4', rule: { kind: 'numberRange', min: 1, max: 5, mode: 'reject', integerOnly: true },
    });
    expect(set.data).toMatchObject({ changed: true, range: 'B2:B4', existingInvalidCount: 1, existingInvalid: [{ cell: 'B3', raw: '10' }] });
    expect(metaStore.getMeta().validation['B2:B4']).toEqual({ kind: 'numberRange', mode: 'reject', min: 1, max: 5, integerOnly: true });
    expect(flashed.at(-1)).toHaveLength(3);

    await call('csv-spreadsheet.set_validation', { range: 'A2:A4', rule: { kind: 'list', options: ['Pears', { value: 'Plums', color: 'purple' }] } });
    const read = await call('csv-spreadsheet.read_range', { range: 'A3:B3' });
    expect(read.data.validation.map((entry: { range: string }) => entry.range)).toEqual(['B2:B4', 'A2:A4']);
    expect((await call('csv-spreadsheet.describe_sheet')).data.validation).toHaveLength(2);

    const cleared = await call('csv-spreadsheet.set_validation', { range: 'B3', rule: null });
    expect(cleared.data.changed).toBe(true);
    expect(Object.keys(metaStore.getMeta().validation)).toEqual(['B2', 'B4', 'A2:A4']);
    await operations.executor.undo();
    expect(Object.keys(metaStore.getMeta().validation)).toEqual(['B2:B4', 'A2:A4']);

    const before = metaStore.getMeta();
    const failures = [
      [{ range: 'C2', rule: { kind: 'regex' } }, /rule.kind must be list, checkbox/],
      [{ range: 'C2', rule: { kind: 'numberRange' } }, /needs min, max or both/],
      [{ range: 'C2', rule: { kind: 'dateRange', min: '2026-02-30' } }, /real date as YYYY-MM-DD/],
      [{ range: 'C2', rule: { kind: 'textLength', min: 5, max: 2 } }, /min must not be greater/],
      [{ range: 'C2', rule: { kind: 'list', options: ['a', 'a'] } }, /lists "a" twice/],
      [{ range: 'C2', rule: { kind: 'checkbox', options: ['x'] } }, /rule.options is not a known field for checkbox/],
      [{ range: 'C2', rule: { kind: 'checkbox', mode: 'block' } }, /mode must be reject or warn/],
      [{ range: 'C2' }, /rule is required/],
    ] as const;
    for (const [params, message] of failures) {
      const result = await call('csv-spreadsheet.set_validation', params as unknown as Record<string, unknown>);
      expect(result.error).toMatch(message);
    }
    expect(metaStore.getMeta()).toBe(before);
  });

  it('reports a missing editor instead of throwing', async () => {
    const tool = aiTools.find((candidate) => candidate.name === 'csv-spreadsheet.read_range')!;
    const result = await tool.handler({ range: 'A1' }, { activeFilePath: '/x.csv', extensionContext: {} } as unknown as AIToolContext);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('/x.csv') });
  });
});
