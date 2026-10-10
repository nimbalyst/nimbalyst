/**
 * 100k rows x 20 columns: load, a single-cell edit, and recalculating 10k
 * formulas, against the Phase 8 targets. Node, no DOM: "open" is the load
 * pipeline up to the grid source the first paint renders (RevoGrid only
 * renders the viewport, so its own share does not grow with the sheet);
 * "edit" is the command path from setCells to the recalculated grid write.
 */

import { describe, expect, it, vi } from 'vitest';
import { parseCSV } from '../src/utils/csvParser';
import { createGridOperations, FormulaViewState, spreadsheetDataToGridSource } from '../src/utils/gridOperations';
import { formattingFromFile } from '../src/sheetMeta/formatting';
import type { SheetMeta } from '../src/commands/sheetState';
import type { RevoGridElement } from '../src/revogrid-types';

vi.mock('@nimbalyst/extension-sdk', () => ({ copyToClipboard: vi.fn(), readClipboard: vi.fn() }));

const ROWS = 100_000;
const COLS = 20;
const FORMULAS = 10_000;

function buildCsv(formulas: number): string {
  const lines = [Array.from({ length: COLS }, (_, c) => `Col${c + 1}`).join(',')];
  for (let r = 1; r <= ROWS; r += 1) {
    const cells = Array.from({ length: COLS }, (_, c) => (c % 3 === 0 ? `item ${r}-${c}` : String((r * 31 + c * 7) % 1000)));
    // Column T: a formula reading two cells of its own row.
    if (r <= formulas) cells[COLS - 1] = `=B${r + 1}*2+C${r + 1}`;
    lines.push(cells.join(','));
  }
  return `${lines.join('\n')}\n`;
}

function time<T>(run: () => T): [T, number] {
  const start = performance.now();
  const result = run();
  return [result, performance.now() - start];
}

async function timeAsync<T>(run: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const result = await run();
  return [result, performance.now() - start];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function open(csv: string) {
  const [parsed, parseMs] = time(() => parseCSV(csv));
  const formulaViewState = new FormulaViewState();
  const [gridData, sourceMs] = time(() => spreadsheetDataToGridSource(parsed.data, 20));
  const [, recalcMs] = time(() => formulaViewState.recalculate(parsed.data, gridData));
  let source = gridData.source;
  let pinnedTopSource = gridData.pinnedTop;
  const grid = {
    get source() { return source; },
    set source(value) { source = value; },
    get pinnedTopSource() { return pinnedTopSource; },
    set pinnedTopSource(value) { pinnedTopSource = value; },
    getSource: async (type: string) => (type === 'rowPinStart' ? pinnedTopSource : source),
    refresh: async () => undefined,
  } as unknown as RevoGridElement;
  let meta: SheetMeta = {
    headerRowCount: parsed.data.headerRowCount,
    frozenColumnCount: 0,
    columnCount: parsed.data.columnCount,
    columnFormats: {},
    columnWidths: {},
    cellStyles: {},
    ...formattingFromFile(parsed.metadata),
  };
  const ops = createGridOperations({ current: grid }, {
    getMeta: () => meta,
    setMeta: (next) => { meta = next; },
    getDelimiter: () => ',',
    formulaViewState,
    bufferRows: 20,
  });
  return { ops, formulaViewState, parsed, gridData, timings: { parseMs, sourceMs, recalcMs } };
}

describe('100k x 20 scale', () => {
  it('measures open, edit and recalc', async () => {
    const report: Record<string, string> = {};
    for (const formulas of [0, FORMULAS]) {
      const csv = buildCsv(formulas);
      const label = formulas === 0 ? 'values only' : `${formulas} formulas`;
      const [sheet, openMs] = await timeAsync(() => open(csv));
      report[`open (${label})`] = `${openMs.toFixed(0)}ms = parse ${sheet.timings.parseMs.toFixed(0)} + grid source ${sheet.timings.sourceMs.toFixed(0)} + recalc ${sheet.timings.recalcMs.toFixed(0)}`;

      // First edit pays the one-time snapshot of the grid; the rest are the steady state.
      const edits: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const [, ms] = await timeAsync(() => sheet.ops.executor.execute({ type: 'setCells', cells: [{ row: 1 + i, col: 1, value: String(500 + i) }] }));
        edits.push(ms);
      }
      report[`edit (${label})`] = `first ${edits[0].toFixed(1)}ms, median of next ${edits.length - 1}: ${median(edits.slice(1)).toFixed(1)}ms (${sheet.formulaViewState.lastStats?.mode})`;

      if (formulas > 0) {
        expect(await sheet.ops.getCellValue(1, COLS - 1)).toBe(500 * 2 + Number(sheet.parsed.data.rows[1][2].raw));
        const full: number[] = [];
        for (let i = 0; i < 3; i += 1) {
          full.push(time(() => sheet.formulaViewState.recalculate(sheet.parsed.data, sheet.gridData))[1]);
        }
        report[`full recalc (${formulas} formulas)`] = `median ${median(full).toFixed(0)}ms`;
      }
    }
    process.stdout.write(`\n[csv perf] ${ROWS} rows x ${COLS} cols, node ${process.version}\n${Object.entries(report).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n`);
  });
});
