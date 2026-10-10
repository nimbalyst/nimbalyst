// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyCommand, type SheetCommand } from '../sheetCommand';
import { buildFillCopy, buildPaste, buildSeriesFill, buildSort, buildUpdateCells } from '../builders';
import type { SheetMeta, SheetState } from '../sheetState';
import { EMPTY_FORMATTING } from '../../sheetMeta/formatting';

const META: SheetMeta = {
  ...EMPTY_FORMATTING,
  headerRowCount: 1,
  frozenColumnCount: 0,
  columnCount: 3,
  columnFormats: {},
  columnWidths: {},
  cellStyles: {},
};

function sheet(rows: string[][], meta: Partial<SheetMeta> = {}): SheetState {
  return { rows, meta: { ...META, ...meta } };
}

/** Cell contents with trailing blanks dropped, so padding does not count as a change. */
function matrix(state: SheetState): string[][] {
  const rows = state.rows.map((row) => {
    const copy = [...row];
    while (copy.length > 0 && copy[copy.length - 1] === '') copy.pop();
    return copy;
  });
  while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

/** Apply, undo, redo; assert undo restores `state` exactly and redo restores the forward result. */
function roundTrip(state: SheetState, command: SheetCommand) {
  const forward = applyCommand(state, command);
  const undone = applyCommand(forward.state, forward.inverse);
  expect(matrix(undone.state)).toEqual(matrix(state));
  expect(undone.state.meta).toEqual(state.meta);
  const redone = applyCommand(undone.state, undone.inverse);
  expect(matrix(redone.state)).toEqual(matrix(forward.state));
  expect(redone.state.meta).toEqual(forward.state.meta);
  return forward.state;
}

describe('structural commands', () => {
  it('rewrites refs on delete, and undo restores formulas that became #REF!', () => {
    const before = sheet([
      ['Name', 'Qty', 'Total'],
      ['a', '1', '=B2*2'],
      ['b', '2', '=B3+B2'],
      ['c', '3', '=SUM(B2:B4)'],
    ], { cellStyles: { 'A3:C3': { bold: true } } });

    const after = roundTrip(before, { type: 'structural', edit: { type: 'deleteRows', at: 1, count: 1 } });

    expect(matrix(after)).toEqual([
      ['Name', 'Qty', 'Total'],
      ['b', '2', '=B2+#REF!'],
      ['c', '3', '=SUM(B2:B3)'],
    ]);
    expect(after.meta.cellStyles).toEqual({ 'A2:C2': { bold: true } });
  });
});

describe('structural commands (more)', () => {
  it('deleting a header row shrinks headerRowCount in the same step (R1-1)', () => {
    const before = sheet([['Name'], ['Alice'], ['Bob']], { columnCount: 1 });
    const after = roundTrip(before, { type: 'structural', edit: { type: 'deleteRows', at: 0, count: 1 } });
    expect(matrix(after)).toEqual([['Alice'], ['Bob']]);
    expect(after.meta.headerRowCount).toBe(0);
  });

  it('inserts and moves columns with formats, widths, refs and frozen count following', () => {
    const before = sheet([
      ['a', 'b', '=A1&B1'],
      ['1', '2', '=$A$2+B2'],
    ], { frozenColumnCount: 2, columnFormats: { 1: { type: 'number' } }, columnWidths: { 2: 140 } });

    const inserted = roundTrip(before, { type: 'structural', edit: { type: 'insertCols', at: 1, count: 1 } });
    expect(matrix(inserted)).toEqual([['a', '', 'b', '=A1&C1'], ['1', '', '2', '=$A$2+C2']]);
    expect(inserted.meta).toMatchObject({
      columnCount: 4, frozenColumnCount: 3, columnFormats: { 2: { type: 'number' } }, columnWidths: { 3: 140 },
    });

    const moved = roundTrip(before, { type: 'structural', edit: { type: 'moveCols', at: 2, count: 1, to: 0 } });
    expect(matrix(moved)).toEqual([['=B1&C1', 'a', 'b'], ['=$B$2+C2', '1', '2']]);
  });

  it('moves a row block and keeps references pointing at the moved cells', () => {
    const before = sheet([['h'], ['x'], ['y'], ['=A3']], { columnCount: 1 });
    const after = roundTrip(before, { type: 'structural', edit: { type: 'moveRows', at: 2, count: 1, to: 1 } });
    expect(matrix(after)).toEqual([['h'], ['y'], ['x'], ['=A2']]);
  });
});

describe('cell, order and metadata commands', () => {
  it('setCells grows rows and columnCount, and its inverse shrinks columnCount back', () => {
    const before = sheet([['a']], { columnCount: 1 });
    const after = roundTrip(before, { type: 'setCells', cells: [{ row: 2, col: 3, value: 'z' }, { row: 0, col: 0, value: 'b' }] });
    expect(matrix(after)).toEqual([['b'], [], ['', '', '', 'z']]);
    expect(after.meta.columnCount).toBe(4);
  });

  it('reports no change for a no-op so nothing is recorded', () => {
    const before = sheet([['a']]);
    expect(applyCommand(before, { type: 'setCells', cells: [{ row: 0, col: 0, value: 'a' }] }).changed).toBe(false);
    expect(applyCommand(before, { type: 'setMeta', patch: { headerRowCount: 1 } }).changed).toBe(false);
    expect(applyCommand(before, { type: 'reorderRows', start: 0, order: [0] }).changed).toBe(false);
  });

  it('a batch of meta, cells and reorder undoes as one step', () => {
    const before = sheet([['H'], ['b'], ['a']], { columnCount: 1 });
    roundTrip(before, {
      type: 'batch',
      commands: [
        { type: 'reorderRows', start: 1, order: [1, 0] },
        { type: 'setMeta', patch: { headerRowCount: 0, cellStyles: { A1: { bold: true } } } },
        { type: 'setCells', cells: [{ row: 0, col: 0, value: 'Header' }] },
      ],
    });
  });
});

describe('reorderRows metadata (R3-3)', () => {
  it('moves per-row metadata with its row, splits spanning ranges, and undoes exactly', () => {
    // Header + rows c, a, b; sorting ascending takes rows [2, 0, 1] of the block.
    const before = sheet([['H'], ['c'], ['a'], ['b']], {
      columnCount: 2,
      cellFormats: { A2: { type: 'currency' }, 'B2:B4': { type: 'number' } },
      validation: { A3: { kind: 'checkbox', mode: 'warn' } },
      cellStyles: { 'A4:B4': { bold: true }, 'A1:B4': { italic: true } },
      borders: { 'A2:A3': { top: { style: 'thick' }, innerHorizontal: { style: 'thin' } } },
      wrap: ['B3'],
      conditionalFormats: [{ id: 'cf', ranges: ['A2:B2', 'A2:A4'], rule: { kind: 'notEmpty' }, style: {} } as never],
      rowHeights: { 1: 40, 3: 60 },
      hiddenRows: [2],
    });
    const after = roundTrip(before, { type: 'reorderRows', start: 1, order: [1, 2, 0] });

    expect(matrix(after)).toEqual([['H'], ['a'], ['b'], ['c']]);
    expect(after.meta.cellFormats).toEqual({ A4: { type: 'currency' }, 'B2:B4': { type: 'number' } });
    expect(after.meta.validation).toEqual({ A2: { kind: 'checkbox', mode: 'warn' } });
    expect(after.meta.cellStyles).toEqual({ 'A3:B3': { bold: true }, 'A1:B4': { italic: true } });
    // Old row 2 (thick top) lands at row 4; old row 3 keeps the inner line as its top, at row 2.
    expect(after.meta.borders).toEqual({
      A2: { top: { style: 'thin' }, innerHorizontal: { style: 'thin' } },
      A4: { top: { style: 'thick' }, innerHorizontal: { style: 'thin' } },
    });
    expect(after.meta.wrap).toEqual(['B2']);
    expect(after.meta.conditionalFormats[0].ranges).toEqual(['A4:B4', 'A2:A4']);
    expect(after.meta.rowHeights).toEqual({ 3: 40, 2: 60 });
    expect(after.meta.hiddenRows).toEqual([1]);
  });
});

describe('command builders', () => {
  it('validates agent updates before anything is written', () => {
    const state = sheet([['a', 'b'], ['1', '2']], { columnCount: 2 });
    expect(() => buildUpdateCells(state, [{ row: 0, column: 2, value: 'x' }])).toThrow(/Column index 2/);
    expect(() => buildUpdateCells(state, [{ row: 5, column: 0, value: 'x' }])).toThrow(/Row index 5/);
    expect(() => buildUpdateCells(state, [
      { row: 1, column: 0, value: 'x' }, { row: 1, column: 0, value: 'y' },
    ])).toThrow(/Duplicate/);
  });

  it('tiles an internal paste across a multiple-sized selection, shifting formula refs per tile', () => {
    const state = sheet([['1', '=A1*2'], ['', ''], ['', ''], ['', '']], { headerRowCount: 0, columnCount: 2 });
    const result = buildPaste({
      source: { kind: 'internal', values: [['1', '=A1*2']], origin: { row: 0, col: 0 } },
      selection: { startRow: 1, endRow: 3, startCol: 0, endCol: 1 },
      visibleSelectionRows: 3,
      destinationRows: (count) => Array.from({ length: count }, (_, i) => 1 + i),
      columnFormats: {},
    })!;
    const after = applyCommand(state, result.command).state;
    expect(matrix(after)).toEqual([['1', '=A1*2'], ['1', '=A2*2'], ['1', '=A3*2'], ['1', '=A4*2']]);
    expect(result.range).toEqual({ startRow: 1, endRow: 3, startCol: 0, endCol: 1 });
  });

  it('writes a paste into the visible rows only and normalizes typed columns', () => {
    const state = sheet([['', ''], ['hidden', ''], ['', '']], { headerRowCount: 0, columnCount: 2 });
    const result = buildPaste({
      source: { kind: 'text', values: [['a', '1/2/2026'], ['b', '1/3/2026']] },
      selection: { startRow: 0, endRow: 0, startCol: 0, endCol: 0 },
      visibleSelectionRows: 1,
      destinationRows: () => [0, 2],
      columnFormats: { 1: { type: 'date', dateFormat: 'YYYY-MM-DD' } },
    })!;
    const after = applyCommand(state, result.command).state;
    expect(matrix(after)).toEqual([['a', '2026-01-02'], ['hidden'], ['b', '2026-01-03']]);
  });

  it('fill handle continues a series down and up; Ctrl+D copies with shifted refs', () => {
    const state = sheet([['1', 'Mon', '=A1'], ['2', 'Tue', '=A2'], ['', '', ''], ['', '', '']], { headerRowCount: 0 });
    const down = buildSeriesFill(state, { rows: [0, 1], cols: [0, 1, 2] }, { rows: [2, 3], cols: [0, 1, 2] }, 'down');
    expect(matrix(applyCommand(state, down).state).slice(2)).toEqual([['3', 'Wed', '=A3'], ['4', 'Thu', '=A4']]);

    const lower = sheet([[''], ['5'], ['7']], { headerRowCount: 0, columnCount: 1 });
    const up = buildSeriesFill(lower, { rows: [1, 2], cols: [0] }, { rows: [0], cols: [0] }, 'up');
    expect(matrix(applyCommand(lower, up).state)).toEqual([['3'], ['5'], ['7']]);

    const copy = buildFillCopy(state, [0, 1, 2], { startRow: 0, endRow: 2, startCol: 2, endCol: 2 }, 'down');
    expect(matrix(applyCommand(state, copy).state).map((row) => row[2])).toEqual(['=A1', '=A2', '=A3']);
  });

  it('sorts body rows only, sinking blanks, and stays stable', () => {
    const state = sheet([['N'], ['b'], [''], ['a'], ['b2'], [''], ['']], { columnCount: 1 });
    const command = buildSort(state, 'desc', (row) => {
      const value = state.rows[row][0] ?? '';
      return value === '' ? null : value[0];
    });
    expect(matrix(applyCommand(state, command).state)).toEqual([['N'], ['b'], ['b2'], ['a']]);
  });

  it('shifts row-relative refs of formulas that move with their row, and undo restores the text', () => {
    const state = sheet([['N', 'Q', 'T'], ['3', '2', '=A2*B2'], ['1', '5', '=A3*$B$3+SUM(A$2:A3)']], { columnCount: 3 });
    const command = buildSort(state, 'asc', (row) => Number(state.rows[row][0]));
    const sorted = applyCommand(state, command);
    expect(matrix(sorted.state)).toEqual([
      ['N', 'Q', 'T'],
      ['1', '5', '=A2*$B$3+SUM(A$2:A2)'],
      ['3', '2', '=A3*B3'],
    ]);
    expect(matrix(applyCommand(sorted.state, sorted.inverse).state)).toEqual(matrix(state));
  });
});
