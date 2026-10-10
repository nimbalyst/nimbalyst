// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createGridOperations, FormulaViewState } from '../../utils/gridOperations';
import { createFakeGrid, createMetaStore, gridColumn } from './fakeGrid';
import { saveGridContent } from '../../editor/saveGrid';

vi.mock('@nimbalyst/extension-sdk', () => ({ copyToClipboard: vi.fn(async () => undefined), readClipboard: vi.fn(async () => '') }));

function sheet(csv: string, staleStore = false) {
  const { grid, parsed } = createFakeGrid(csv, 2, { staleStore });
  const meta = createMetaStore(parsed);
  const onDirty = vi.fn();
  const ops = createGridOperations({ current: grid }, { ...meta, getDelimiter: () => ',', onDirty });
  return { grid, ops, meta, onDirty };
}

const CSV = [
  '# nimbalyst: {"hasHeaders":true,"headerRowCount":1,"columnWidths":{"1":90}}',
  'Item,Qty,Total',
  'a,1,=B2*2',
  'b,2,=SUM(B2:B3)',
].join('\n');

describe('grid command executor', () => {
  it('undoes and redoes a row insert and a column delete, formulas and metadata included', async () => {
    const { ops, meta } = sheet(CSV);
    const original = await ops.toCSV();

    await ops.addRow(2);
    expect(await ops.toCSV()).toContain('b,2,=SUM(B2:B4)');
    await ops.deleteColumn(0);
    const edited = await ops.toCSV();
    expect(edited).toContain('2,=SUM(A2:A4)');
    expect(meta.getMeta().columnWidths).toEqual({ 0: 90 });

    await ops.executor.undo();
    await ops.executor.undo();
    expect(await ops.toCSV()).toBe(original);
    await ops.executor.redo();
    await ops.executor.redo();
    expect(await ops.toCSV()).toBe(edited);
  });

  // F7: the rows a paste added (and the buffer rows kept below them) stayed
  // behind as blanks after undo.
  it('undoing a paste that grew the sheet removes the rows and columns it added', async () => {
    const { grid, parsed } = createFakeGrid(CSV, 2);
    const meta = createMetaStore(parsed);
    const ops = createGridOperations({ current: grid }, { ...meta, getDelimiter: () => ',', bufferRows: 2 });
    const rowsBefore = grid.pinnedTopSource.length + grid.source.length;
    const columnsBefore = meta.getMeta().columnCount;

    await ops.pasteFromText(3, 2, Array.from({ length: 6 }, (_, i) => `p${i}\tq${i}\tr${i}`).join('\n'));
    expect(grid.pinnedTopSource.length + grid.source.length).toBeGreaterThan(rowsBefore);
    expect(meta.getMeta().columnCount).toBe(5);

    await ops.executor.undo();
    expect(grid.pinnedTopSource.length + grid.source.length).toBe(rowsBefore);
    expect(meta.getMeta().columnCount).toBe(columnsBefore);
    expect(Object.keys(grid.source[grid.source.length - 1]).filter((key) => /^[A-Z]+$/.test(key))).toHaveLength(columnsBefore);

    await ops.executor.redo();
    expect(await ops.getCellRawValue(8, 4)).toBe('r5');
  });

  it('double-click fill continues the series to the end of the adjacent column, in one undo step', async () => {
    const csv = 'Item,N\na,1\nb,2\nc,\nd,\ne,\nf,9\n,\ng,';
    const { grid, parsed } = createFakeGrid(csv, 2);
    const ops = createGridOperations({ current: grid }, { ...createMetaStore(parsed), getDelimiter: () => ',' });
    const original = await ops.toCSV();

    // B2:B3 hold 1,2; column A runs to row 8, but B7 already holds 9: stop above it.
    const filled = await ops.fillDown({ startRow: 1, endRow: 2, startCol: 1, endCol: 1 });
    expect(filled).toEqual({ startRow: 1, endRow: 5, startCol: 1, endCol: 1 });
    expect(await ops.toCSV()).toBe('Item,N\na,1\nb,2\nc,3\nd,4\ne,5\nf,9\n,\ng,');

    await ops.executor.undo();
    expect(await ops.toCSV()).toBe(original);

    // Nothing below the last row in either neighbor: nothing to fill.
    expect(await ops.fillDown({ startRow: 8, endRow: 8, startCol: 1, endCol: 1 })).toBeNull();
  });

  it('records an agent batch as one undo step and a remote command not at all', async () => {
    const { ops, onDirty } = sheet(CSV);
    const original = await ops.toCSV();
    await ops.updateCells([{ row: 1, column: 0, value: 'x' }, { row: 2, column: 0, value: 'y' }], 'agent');
    await ops.executor.execute({ type: 'setCells', cells: [{ row: 1, col: 1, value: '5' }] }, { origin: 'remote' });
    expect(onDirty).toHaveBeenCalledTimes(1);

    await ops.executor.undo();
    // The agent's two cells are gone in one step; the remote edit stays.
    expect(await ops.toCSV()).toBe(original.replace('a,1,', 'a,5,'));
    expect(ops.executor.canUndo).toBe(false);
  });

  // Back-to-back commands read the store before RevoGrid had caught up with
  // the previous write, so the second overwrote the first (seen as a typed
  // Tab/Enter run losing every other cell).
  it('does not lose a write when the next command runs before the grid store catches up', async () => {
    const { grid, ops } = sheet('a,b\n,\n', true);
    await ops.updateCell(1, 0, 'D');
    await ops.updateCell(1, 1, '4');
    expect(grid.source[0]).toMatchObject({ A: 'D', B: '4' });
  });

  it('runs commands in order against the state each one actually sees', async () => {
    const { grid, ops, meta } = sheet('# nimbalyst: {"hasHeaders":true,"headerRowCount":1}\nName\nAlice\nBob');
    // Issued together, as a menu click and a keystroke can be.
    await Promise.all([ops.deleteRow(0), ops.updateCell(0, 0, 'Alicia')]);
    expect(gridColumn(grid)).toEqual(['Alicia', 'Bob']);
    expect(meta.getMeta().headerRowCount).toBe(0);
  });

  it('R2-1 serializes after queued commands, and a save clears dirty only if nothing changed meanwhile', async () => {
    const { ops } = sheet('old,1');
    void ops.updateCell(0, 0, 'new');
    expect(await ops.toCSV()).toBe('new,1');

    let release = () => {};
    const saved: string[] = [];
    const markClean = vi.fn();
    const target = {
      saveContent: (content: string) => { saved.push(content); return new Promise<void>((resolve) => { release = resolve; }); },
      updateDiskContent: vi.fn(),
      markClean,
    };
    const save = saveGridContent(ops, target);
    await vi.waitFor(() => expect(saved).toEqual(['new,1']));
    await ops.updateCell(0, 0, 'newer');
    release();
    await save;
    expect(markClean).not.toHaveBeenCalled();

    const second = saveGridContent(ops, target);
    await vi.waitFor(() => expect(saved).toEqual(['new,1', 'newer,1']));
    release();
    await second;
    expect(markClean).toHaveBeenCalledTimes(1);
  });

  it('re-evaluates only the dependents of an edited cell, and everything after a structural edit', async () => {
    const { grid, parsed } = createFakeGrid('1,=A1*2,=5*2,=C1+1');
    const formulaViewState = new FormulaViewState();
    const ops = createGridOperations({ current: grid }, { ...createMetaStore(parsed), getDelimiter: () => ',', formulaViewState });
    await ops.recalculateFormulas();

    const edited = await ops.executor.execute({ type: 'setCells', cells: [{ row: 0, col: 0, value: '4' }] });
    expect(edited?.recalc).toEqual({ mode: 'incremental', evaluatedFormulas: 1 });
    expect([await ops.getCellValue(0, 1), await ops.getCellValue(0, 3)]).toEqual([8, 11]);

    const inserted = await ops.executor.execute({ type: 'structural', edit: { type: 'insertRows', at: 0, count: 1 } });
    expect(inserted?.recalc).toMatchObject({ mode: 'full', evaluatedFormulas: 3 });
    const undone = await ops.executor.execute({ type: 'setCells', cells: [{ row: 1, col: 2, value: '=7' }] });
    expect(undone?.recalc).toEqual({ mode: 'incremental', evaluatedFormulas: 2 });
    expect(await ops.getCellValue(1, 3)).toBe(8);
  });
});

function transfer() {
  const data = new Map<string, string>();
  return {
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) ?? '',
  } as unknown as DataTransfer;
}

describe('clipboard through grid operations', () => {
  it('copies displayed values as TSV and pastes internal formulas with shifted refs, or values only', async () => {
    const { grid, parsed } = createFakeGrid('a,1,=B1*2\nb,2,');
    const meta = createMetaStore(parsed, { headerRowCount: 0, columnFormats: { 1: { type: 'currency', decimals: 2 } } });
    const formulaViewState = new FormulaViewState();
    const ops = createGridOperations({ current: grid }, { ...meta, getDelimiter: () => ',', formulaViewState });
    await ops.recalculateFormulas();

    const clipboard = transfer();
    const payload = await ops.copySelection({ startRow: 0, endRow: 0, startCol: 1, endCol: 2 }, clipboard);
    expect(payload?.text).toBe('$1.00\t2');
    expect(clipboard.getData('text/plain')).toBe('$1.00\t2');

    await ops.paste({ startRow: 1, endRow: 1, startCol: 1, endCol: 1 }, { transfer: clipboard });
    expect(grid.source[1]).toMatchObject({ B: '1', C: '=B2*2' });

    await ops.paste({ startRow: 1, endRow: 1, startCol: 1, endCol: 1 }, { transfer: clipboard, valuesOnly: true });
    expect(grid.source[1]).toMatchObject({ B: '1', C: '2' });
  });
});
