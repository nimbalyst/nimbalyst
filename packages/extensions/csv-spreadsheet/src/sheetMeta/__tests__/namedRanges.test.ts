// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createGridOperations, FormulaViewState } from '../../utils/gridOperations';
import { createFakeGrid, createMetaStore } from '../../commands/__tests__/fakeGrid';
import { parseCSV } from '../../utils/csvParser';
import { evaluateFormula } from '../../utils/formulaEngine';
import { defineNamedRangeCommand, normalizeRangeTarget, rangeNameError, renameNamedRangeCommand } from '../namedRanges';
import { scanFormulaTokens } from '../../formula/referenceScanner';
import { referenceHighlights } from '../../formula/pointMode';

vi.mock('@nimbalyst/extension-sdk', () => ({ copyToClipboard: vi.fn(async () => undefined), readClipboard: vi.fn(async () => '') }));

const CSV = [
  '# nimbalyst: {"hasHeaders":true,"headerRowCount":1,"frozenColumnCount":0,"namedRanges":{"Sales":"B2:B4","Rate":"D1"}}',
  'Item,Amount,,0.5',
  'a,10,=SUM(sales)*Rate',
  'b,20,',
  'c,30,',
].join('\n');

function sheet(csv = CSV) {
  const { grid, parsed } = createFakeGrid(csv, 2);
  const formulaViewState = new FormulaViewState();
  formulaViewState.recalculate(parsed.data, { source: grid.source as never, pinnedTop: grid.pinnedTopSource as never });
  const meta = createMetaStore(parsed);
  const ops = createGridOperations({ current: grid }, { ...meta, getDelimiter: () => ',', formulaViewState });
  return { ops, meta };
}

describe('named ranges', () => {
  it('resolves case-insensitively, recalculates incrementally, and an unknown name is #NAME?', async () => {
    const { ops } = sheet();
    expect(await ops.getCellValue(1, 2)).toBe(30);
    const edited = await ops.executor.execute({ type: 'setCells', cells: [{ row: 3, col: 1, value: '50' }] });
    expect(edited?.recalc?.mode).toBe('incremental');
    expect(await ops.getCellValue(1, 2)).toBe(40);
    expect(evaluateFormula('=SUM(Nope)', parseCSV(CSV).data, 0, 0).error).toBe('#NAME?');
  });

  it('defining a name recalculates formulas that already used it', async () => {
    const { ops } = sheet(CSV.replace('"Rate":"D1"', '"Other":"D1"'));
    expect(await ops.getCellValue(1, 2)).toBe('#NAME?');
    await ops.setMeta((meta) => ({ namedRanges: { ...meta.namedRanges, rate: 'D1' } }));
    expect(await ops.getCellValue(1, 2)).toBe(30);
  });

  it('follows its cells through inserts, and deleting all of them leaves #REF!', async () => {
    const { ops, meta } = sheet();
    await ops.addRow(2);
    expect(meta.getMeta().namedRanges.Sales).toBe('B2:B5');
    await ops.deleteColumn(3);
    expect(meta.getMeta().namedRanges.Rate).toBe('#REF!');
    expect(await ops.getCellValue(1, 2)).toBe('#REF!');
    // The name stays in the formula text; undo brings the range back.
    expect(await ops.getCellRawValue(1, 2)).toBe('=SUM(sales)*Rate');
    await ops.executor.undo();
    expect(await ops.getCellValue(1, 2)).toBe(30);
  });

  it('stays put when the rows are sorted', async () => {
    const { ops, meta } = sheet();
    await ops.sortByColumn(1, 'desc');
    expect(meta.getMeta().namedRanges).toEqual({ Sales: 'B2:B4', Rate: 'D1' });
  });

  it('rename rewrites the formulas that use it, in one undo step', async () => {
    const { ops, meta } = sheet();
    await ops.executor.execute(({ state }) => renameNamedRangeCommand(state, 'SALES', 'Revenue'));
    expect(meta.getMeta().namedRanges).toEqual({ Revenue: 'B2:B4', Rate: 'D1' });
    expect(await ops.getCellRawValue(1, 2)).toBe('=SUM(Revenue)*Rate');
    expect(await ops.getCellValue(1, 2)).toBe(30);
    await ops.executor.undo();
    expect(await ops.getCellRawValue(1, 2)).toBe('=SUM(sales)*Rate');
    expect(meta.getMeta().namedRanges).toEqual({ Sales: 'B2:B4', Rate: 'D1' });
  });

  it('the dialog\'s define renames and repoints in one step', async () => {
    const { ops, meta } = sheet();
    await ops.executor.execute(({ state }) => defineNamedRangeCommand(state, 'Top', 'B2:B3', 'Sales'));
    expect(meta.getMeta().namedRanges).toEqual({ Top: 'B2:B3', Rate: 'D1' });
    expect(await ops.getCellRawValue(1, 2)).toBe('=SUM(Top)*Rate');
    expect(await ops.getCellValue(1, 2)).toBe(15);
    await ops.executor.undo();
    expect(meta.getMeta().namedRanges).toEqual({ Sales: 'B2:B4', Rate: 'D1' });
  });

  it('R4-3: a name shaped like an out-of-bounds cell ref works in formulas, rename included', async () => {
    for (const name of ['Sales2026', 'ABCD1', 'XFE1']) expect(rangeNameError(name, {})).toBeNull();
    const { ops, meta } = sheet(CSV.replace('=SUM(sales)*Rate', '=SUM(ABCD1)*Rate').replace('"Sales"', '"ABCD1"'));
    expect(await ops.getCellValue(1, 2)).toBe(30);
    await ops.executor.execute(({ state }) => renameNamedRangeCommand(state, 'ABCD1', 'Sales2026'));
    expect(meta.getMeta().namedRanges).toEqual({ Sales2026: 'B2:B4', Rate: 'D1' });
    expect(await ops.getCellRawValue(1, 2)).toBe('=SUM(Sales2026)*Rate');
    expect(await ops.getCellValue(1, 2)).toBe(30);
    // The editor's scanner agrees: names, not references, so nothing is outlined.
    expect(scanFormulaTokens('=Sales2026+ABCD1+XFE1+XFD1').filter((token) => token.kind === 'name').map((token) => token.text))
      .toEqual(['Sales2026', 'ABCD1', 'XFE1']);
    expect(referenceHighlights('=SUM(Sales2026)+XFD1').map((highlight) => highlight.reference.text)).toEqual(['XFD1']);
  });

  it('enforces the naming rules', () => {
    const names = { Sales: 'B2:B4' };
    expect(rangeNameError('Tax_2026', names)).toBeNull();
    expect(rangeNameError('sales', names)).toBe('Sales already exists.');
    expect(rangeNameError('SALES', names, 'Sales')).toBeNull();
    for (const bad of ['', '2026tax', 'my name', 'a.b', 'TRUE', 'AB12', 'R1C1', 'x'.repeat(251)]) {
      expect(rangeNameError(bad, names)).not.toBeNull();
    }
    expect(normalizeRangeTarget('$b$2:$a$1')).toBe('A1:B2');
    expect(normalizeRangeTarget('Sheet!A1')).toBeNull();
  });
});
