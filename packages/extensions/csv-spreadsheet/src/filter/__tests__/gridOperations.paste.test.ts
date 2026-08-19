// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { RevoGridElement } from '../../revogrid-types';
import { columnIndexToLetter } from '../../utils/csvParser';
import { createGridOperations } from '../../utils/gridOperations';

describe('filtered paste', () => {
  it('writes the pasted block to visible rows and leaves hidden rows untouched', async () => {
    const source: Record<string, unknown>[] = [
      { A: 'visible 0' },
      { A: 'hidden 1' },
      { A: 'visible 2' },
      { A: 'hidden 3' },
      { A: 'visible 4' },
    ];
    const grid = {
      getSource: async (rowType: string) => rowType === 'rgRow' ? source : [],
      setDataAt: async ({ row, col, val }: { row: number; col: number; val: unknown }) => {
        source[row][columnIndexToLetter(col)] = val;
      },
    } as unknown as RevoGridElement;
    const operations = createGridOperations({ current: grid }, {
      getHeaderRowCount: () => 0,
      getColumnCount: () => 1,
      setColumnCount: () => undefined,
      getDelimiter: () => ',',
      getColumnFormats: () => ({}),
      getColumnWidths: () => ({}),
      getCellStyles: () => ({}),
      getFrozenColumnCount: () => 0,
      onDirty: () => undefined,
      getUndoPlugin: () => null,
      getTrimmedRows: () => ({ 1: true, 3: true }),
    });

    await operations.pasteFromText(0, 0, 'one\ntwo\nthree');

    expect(source.map((row) => row.A)).toEqual(['one', 'hidden 1', 'two', 'hidden 3', 'three']);
  });
});
