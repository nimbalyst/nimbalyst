/**
 * A RevoGrid stand-in for node tests: two row sections, `getSource`, `refresh`.
 * Sources are read back as the grid holds them, so a test sees exactly what a
 * whole-source replacement wrote.
 */

import type { RevoGridElement } from '../../revogrid-types';
import type { SheetMeta } from '../sheetState';
import { parseCSV } from '../../utils/csvParser';
import { formattingFromFile } from '../../sheetMeta/formatting';
import { spreadsheetDataToGridSource } from '../../utils/gridOperations';

export type FakeGrid = RevoGridElement & {
  source: Record<string, unknown>[];
  pinnedTopSource: Record<string, unknown>[];
};

/**
 * `staleStore`: `getSource()` keeps returning the rows from load time, like
 * RevoGrid's store before it catches up with a just-assigned `source`.
 */
export function createFakeGrid(
  csv: string,
  bufferRows = 2,
  { staleStore = false } = {},
): { grid: FakeGrid; parsed: ReturnType<typeof parseCSV> } {
  const parsed = parseCSV(csv);
  const data = spreadsheetDataToGridSource(parsed.data, bufferRows);
  let source: Record<string, unknown>[] = data.source;
  let pinnedTopSource: Record<string, unknown>[] = data.pinnedTop;
  const grid = {
    get source() { return source; },
    set source(value) { source = value; },
    get pinnedTopSource() { return pinnedTopSource; },
    set pinnedTopSource(value) { pinnedTopSource = value; },
    getSource: async (type: string) => {
      if (staleStore) return type === 'rowPinStart' ? data.pinnedTop : data.source;
      return type === 'rowPinStart' ? pinnedTopSource : source;
    },
    refresh: async () => undefined,
  } as unknown as FakeGrid;
  return { grid, parsed };
}

/** Column A..n values of every row, pinned rows first. */
export function gridColumn(grid: FakeGrid, letter = 'A'): unknown[] {
  return [...grid.pinnedTopSource, ...grid.source].map((row) => row[letter] ?? '').filter((value) => value !== '');
}

/** Synchronous metadata, as the editor's ref-backed store provides it. */
export function createMetaStore(parsed: ReturnType<typeof parseCSV>, overrides: Partial<SheetMeta> = {}) {
  let meta: SheetMeta = {
    headerRowCount: parsed.data.headerRowCount,
    frozenColumnCount: parsed.data.frozenColumnCount,
    columnCount: parsed.data.columnCount,
    columnFormats: parsed.data.columnFormats,
    columnWidths: parsed.metadata?.columnWidths ?? {},
    cellStyles: parsed.data.cellStyles,
    ...formattingFromFile(parsed.metadata),
    ...overrides,
  };
  return {
    getMeta: () => meta,
    setMeta: (next: SheetMeta) => { meta = next; },
  };
}
