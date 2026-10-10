// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createGridOperations } from '../../utils/gridOperations';
import { createFakeGrid, createMetaStore } from '../../commands/__tests__/fakeGrid';
import { applyCommand } from '../../commands/sheetCommand';
import { CsvMetaBinding } from '../../collab/metaBinding';
import { metaSnapshotOf } from '../../editor/editorUtils';
import { formattingFromFile, EMPTY_FORMATTING, type SheetFormatting } from '../formatting';
import { detectFileLayout, parseCSV } from '../../utils/csvParser';

const FORMATTED: SheetFormatting = {
  cellFormats: { 'B2:B3': { type: 'currency', currency: 'USD', decimals: 2 } },
  conditionalFormats: [{ id: 'cf1', ranges: ['B2:B3'], rule: { kind: 'valueCompare', operator: '>', value: 5 }, style: { fillColor: 'green' } }],
  validation: { 'C2:C3': { kind: 'list', mode: 'reject', options: [{ value: 'Open', color: 'green' }, { value: 'Done' }] } },
  rowHeights: { 2: 48 },
  hiddenRows: [3],
  hiddenCols: [1],
  frozenRowCount: 1,
  wrap: ['A2:A3'],
  borders: { 'A1:C1': { bottom: { style: 'thick' } } },
  namedRanges: { Amounts: 'B2:B3' },
};

function fileWith(formatting: Partial<SheetFormatting>): string {
  const meta = { hasHeaders: true, headerRowCount: 1, frozenColumnCount: 0, ...formatting };
  return `# nimbalyst: ${JSON.stringify(meta)}\nName,Amount,Status\nA,10,Open\nB,3,Done\nC,7,`;
}

function operationsFor(csv: string) {
  const { grid, parsed } = createFakeGrid(csv);
  const store = createMetaStore(parsed);
  const ops = createGridOperations({ current: grid }, { ...store, getDelimiter: () => ',', getFileLayout: () => detectFileLayout(csv) });
  return { ops, store };
}

describe('Phase 3 metadata', () => {
  it('round-trips every formatting field through load and save unchanged', async () => {
    const csv = fileWith(FORMATTED);
    const { ops } = operationsFor(csv);
    expect(await ops.toCSV()).toBe(csv);
  });

  it('loads a file written before the fields existed with defaults, and saves it unchanged', async () => {
    const legacy = '# nimbalyst: {"hasHeaders":true,"headerRowCount":1,"frozenColumnCount":0,"columnWidths":{"0":90}}\nName,Amount\nA,1';
    expect(formattingFromFile(parseCSV(legacy).metadata)).toEqual(EMPTY_FORMATTING);
    expect(formattingFromFile(null)).toEqual(EMPTY_FORMATTING);
    const { ops } = operationsFor(legacy);
    expect(await ops.toCSV()).toBe(legacy);
  });

  it('drops malformed entries instead of failing the load', () => {
    const loaded = formattingFromFile({
      rowHeights: { 1: 30, 2: 'tall', x: 40, 3: 1 },
      hiddenRows: [4, 'x', 2, 2, -1],
      cellFormats: { A1: { type: 'number' }, B1: 'bad' },
      validation: { A1: { kind: 'list', mode: 'nope' } },
      frozenRowCount: 'two',
      wrap: ['A1', 5, 'A1'],
    });
    expect(loaded.rowHeights).toEqual({ 1: 30 });
    expect(loaded.hiddenRows).toEqual([2, 4]);
    expect(loaded.cellFormats).toEqual({ A1: { type: 'number' } });
    expect(loaded.validation).toEqual({});
    expect(loaded.frozenRowCount).toBe(0);
    expect(loaded.wrap).toEqual(['A1']);
  });

  it('shifts every range- and index-keyed field with a structural edit, and undo restores it', async () => {
    const { store } = operationsFor(fileWith(FORMATTED));
    const before = { rows: [['Name'], ['A'], ['B'], ['C']], meta: store.getMeta() };
    const inserted = applyCommand(before, { type: 'structural', edit: { type: 'insertRows', at: 1, count: 1 } });
    const meta = inserted.state.meta;
    expect(meta.cellFormats).toEqual({ 'B3:B4': FORMATTED.cellFormats['B2:B3'] });
    expect(meta.conditionalFormats[0].ranges).toEqual(['B3:B4']);
    expect(Object.keys(meta.validation)).toEqual(['C3:C4']);
    expect(meta.rowHeights).toEqual({ 3: 48 });
    expect(meta.hiddenRows).toEqual([4]);
    expect(meta.wrap).toEqual(['A3:A4']);
    expect(Object.keys(meta.borders)).toEqual(['A1:C1']);
    expect(meta.namedRanges).toEqual({ Amounts: 'B3:B4' });
    // Inserting inside the frozen block grows it.
    expect(meta.frozenRowCount).toBe(2);
    expect(applyCommand(inserted.state, inserted.inverse).state.meta).toEqual(before.meta);

    const deletedCol = applyCommand(before, { type: 'structural', edit: { type: 'deleteCols', at: 0, count: 1 } }).state.meta;
    expect(deletedCol.hiddenCols).toEqual([0]);
    expect(deletedCol.cellFormats).toEqual({ 'A2:A3': FORMATTED.cellFormats['B2:B3'] });
    expect(deletedCol.wrap).toEqual([]);
  });

  it('merges concurrent formatting edits from two collaborators per entry', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const base = { headerRowCount: 1, frozenColumnCount: 0, columnFormats: {}, columnWidths: {}, cellStyles: {} };
    const a = new CsvMetaBinding(docA, { onRemoteMeta: () => {} });
    const b = new CsvMetaBinding(docB, { onRemoteMeta: () => {} });
    // A shared starting point, then two offline edits exchanged afterwards.
    a.publish({ ...base, ...EMPTY_FORMATTING, hiddenCols: [1] });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    a.publish({ ...a.snapshot(), cellFormats: FORMATTED.cellFormats, conditionalFormats: FORMATTED.conditionalFormats, namedRanges: FORMATTED.namedRanges });
    b.publish({ ...b.snapshot(), hiddenCols: [1, 4], rowHeights: { 2: 48 }, namedRanges: { Total: 'B4' } });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

    const merged = b.snapshot();
    expect(a.snapshot()).toEqual(merged);
    expect(merged.hiddenCols).toEqual([1, 4]);
    expect(merged.rowHeights).toEqual({ 2: 48 });
    expect(merged.cellFormats).toEqual(FORMATTED.cellFormats);
    expect(merged.conditionalFormats).toEqual(FORMATTED.conditionalFormats);
    expect(merged.namedRanges).toEqual({ Amounts: 'B2:B3', Total: 'B4' });
    expect(metaSnapshotOf({ ...merged, columnCount: 3, hasHeaders: true })).toEqual(merged);
  });

  it('pins frozen rows below the header rows, moves them back out on unfreeze, and saves the header count unchanged', async () => {
    const { ops, store } = operationsFor(fileWith({ frozenRowCount: 1 }));
    expect(store.getMeta().frozenRowCount).toBe(1);
    const sections = await ops.getData();
    expect(sections.pinnedTop.map((row) => row.A)).toEqual(['Name', 'A']);
    expect(sections.pinnedTop[1]._rowClass).toBeUndefined();

    await ops.setMeta({ frozenRowCount: 0 });
    const after = await ops.getData();
    expect(after.pinnedTop.map((row) => row.A)).toEqual(['Name']);
    expect(after.source[0].A).toBe('A');
    expect(await ops.toCSV()).toBe(fileWith({}));
    await ops.executor.undo();
    expect((await ops.getData()).pinnedTop).toHaveLength(2);
  });
});
