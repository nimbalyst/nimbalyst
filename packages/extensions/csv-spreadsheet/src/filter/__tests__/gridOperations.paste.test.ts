// @vitest-environment node
import { EMPTY_FORMATTING } from '../../sheetMeta/formatting';
import { describe, expect, it } from 'vitest';
import type { RevoGridElement } from '../../revogrid-types';
import type { SheetMeta } from '../../commands/sheetState';
import { createGridOperations } from '../../utils/gridOperations';
import { createFakeGrid, createMetaStore } from '../../commands/__tests__/fakeGrid';

describe('filtered paste', () => {
  it('writes the pasted block to visible rows and leaves hidden rows untouched', async () => {
    const source: Record<string, unknown>[] = [
      { A: 'visible 0' },
      { A: 'hidden 1' },
      { A: 'visible 2' },
      { A: 'hidden 3' },
      { A: 'visible 4' },
    ];
    let pinnedTopSource: Record<string, unknown>[] = [];
    const grid = {
      source,
      get pinnedTopSource() { return pinnedTopSource; },
      set pinnedTopSource(value) { pinnedTopSource = value; },
      getSource: async (rowType: string) => (rowType === 'rgRow' ? grid.source : pinnedTopSource),
      refresh: async () => undefined,
    } as unknown as RevoGridElement & { source: Record<string, unknown>[] };
    let meta: SheetMeta = {
      ...EMPTY_FORMATTING,
      headerRowCount: 0, frozenColumnCount: 0, columnCount: 1, columnFormats: {}, columnWidths: {}, cellStyles: {},
    };
    const operations = createGridOperations({ current: grid }, {
      getMeta: () => meta,
      setMeta: (next) => { meta = next; },
      getDelimiter: () => ',',
      getTrimmedRows: () => ({ 1: true, 3: true }),
    });

    await operations.pasteFromText(0, 0, 'one\ntwo\nthree');
    expect(grid.source.map((row) => row.A)).toEqual(['one', 'hidden 1', 'two', 'hidden 3', 'three']);

    // One paste is one undo step.
    await operations.executor.undo();
    expect(grid.source.map((row) => row.A)).toEqual(['visible 0', 'hidden 1', 'visible 2', 'hidden 3', 'visible 4']);
  });
});

describe('filtered fill and copy shift formulas by logical distance', () => {
  function filtered(csv: string, hidden: number[]) {
    const { grid, parsed } = createFakeGrid(csv, 2);
    const meta = createMetaStore(parsed, { headerRowCount: 0 });
    const trimmed = Object.fromEntries(hidden.map((row) => [row, true]));
    const ops = createGridOperations({ current: grid }, { ...meta, getDelimiter: () => ',', getTrimmedRows: () => trimmed });
    return { grid, ops };
  }
  const columnA = (grid: { source: Record<string, unknown>[] }) => grid.source.slice(0, 5).map((row) => row.A);
  const one = (row: number) => ({ startRow: row, endRow: row, startCol: 0, endCol: 0 });

  it('R2-2 fills the visible rows when the first target row is hidden', async () => {
    const { grid, ops } = filtered('=B1,1\n,2\n,3\n,4\n,5', [1]);
    await ops.fillSeries(one(0), { ...one(0), endRow: 3 });
    expect(columnA(grid)).toEqual(['=B1', '', '=B3', '=B4', '']);
  });

  it('R2-2 shifts a filled formula by the rows it actually moved', async () => {
    const { grid, ops } = filtered('=B1,1\n,2\n,3\n,4\n,5', [2]);
    await ops.fillSeries(one(0), { ...one(0), endRow: 3 });
    expect(columnA(grid)).toEqual(['=B1', '=B2', '', '=B4', '']);
  });

  it('R2-3 pastes copied filtered rows relative to each row they came from', async () => {
    const { grid, ops } = filtered('=B1,1\nhidden,2\n=B3,3\n,4\n,5', [1]);
    const clipboard = new Map<string, string>();
    const transfer = {
      setData: (type: string, value: string) => { clipboard.set(type, value); },
      getData: (type: string) => clipboard.get(type) ?? '',
    } as unknown as DataTransfer;
    await ops.copySelection({ ...one(0), endRow: 2 }, transfer);
    await ops.paste(one(3), { transfer });
    expect(columnA(grid)).toEqual(['=B1', 'hidden', '=B3', '=B4', '=B5']);
  });
});
