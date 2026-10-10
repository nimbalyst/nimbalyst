// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import type { Cell, SpreadsheetData } from '../../types';
import {
  recalculateFormulas,
  recalculateFormulasIncremental,
  recalculateFormulasWithState,
  type FormulaCellChange,
  type FormulaRecalcState,
} from '../formulaEngine';

function makeCell(raw: string): Cell {
  if (raw.startsWith('=')) return { raw, computed: null };
  const number = Number(raw);
  return { raw, computed: raw.trim() !== '' && Number.isFinite(number) ? number : raw };
}

function makeSheet(raws: string[][]): SpreadsheetData {
  return {
    rows: raws.map((row) => row.map(makeCell)),
    columnCount: raws[0].length,
    hasHeaders: false,
    headerRowCount: 0,
    frozenColumnCount: 0,
    columnFormats: {},
    cellStyles: {},
  };
}

function edit(state: FormulaRecalcState, edits: Array<FormulaCellChange & { raw: string }>): SpreadsheetData {
  const rows = state.data.rows.slice();
  for (const { row, col, raw } of edits) {
    rows[row] = rows[row].slice();
    rows[row][col] = makeCell(raw);
  }
  return { ...state.data, rows };
}

function results(data: SpreadsheetData): Array<Array<[Cell['computed'], string | undefined]>> {
  return data.rows.map((row) => row.map((cell) => [cell.computed, cell.error]));
}

describe('incremental recalculation', () => {
  it('re-evaluates a whole-column reference when a value cell in that column changes', () => {
    const state = recalculateFormulasWithState(makeSheet([
      ['1', '=SUM(A:A)', '=B1*2'],
      ['2', '=A2+1', '5'],
      ['3', '', ''],
    ]));
    expect(state.data.rows[0][1].computed).toBe(6);

    const next = recalculateFormulasIncremental(state, edit(state, [{ row: 2, col: 0, raw: '10' }]), [{ row: 2, col: 0 }]);

    expect(next.stats).toEqual({ mode: 'incremental', evaluatedFormulas: 2 });
    expect(next.data.rows[0][1].computed).toBe(13);
    expect(next.data.rows[0][2].computed).toBe(26);
    // Untouched rows keep their identity.
    expect(next.data.rows[1]).toBe(state.data.rows[1]);
  });

  it('re-evaluates volatile functions on every pass', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.25);
    try {
      const state = recalculateFormulasWithState(makeSheet([['1', '=RAND()', '=B1*2']]));
      random.mockReturnValue(0.5);
      const next = recalculateFormulasIncremental(state, edit(state, [{ row: 0, col: 0, raw: '2' }]), [{ row: 0, col: 0 }]);
      expect(next.data.rows[0][2].computed).toBe(1);
    } finally {
      random.mockRestore();
    }
  });

  // Property: for random sheets and random edit sequences (values, formulas,
  // formula <-> value toggles, cycles, errors), the incremental result equals
  // a full recalculation of the same sheet.
  it('matches a full recalculation for random sheets and edit sequences', () => {
    const random = mulberry32(0x5eed);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
    const rowCount = 5;
    const colCount = 4;
    const letters = ['A', 'B', 'C', 'D'];
    // Formulas mostly read columns to their left so most sheets stay acyclic
    // (cyclic sheets take the full-recalc fallback); 3% read anywhere.
    let readable = letters;
    const row = () => 1 + Math.floor(random() * rowCount);
    const ref = () => `${pick(readable)}${row()}`;
    const col = () => pick(readable);
    const randomRaw = (targetCol: number): string => {
      if (random() < 0.45) return pick(['', '0', '1', '2', '3.5', '-4', 'abc', 'TRUE']);
      const unconstrained = random() < 0.03;
      if (targetCol === 0 && !unconstrained) return pick(['=1/0', '=SUM(', '=2*3', '=NA()']);
      readable = unconstrained ? letters : letters.slice(0, targetCol);
      return pick([
        ...(unconstrained ? [() => `=MAX(${row()}:${row()})`] : []),
        () => `=${ref()}+${ref()}`,
        () => `=${ref()}*2`,
        () => `=SUM(${ref()}:${ref()})`,
        () => `=SUM(${col()}:${col()})`,
        () => `=COUNTIF(${col()}:${col()},">1")`,
        () => `=IF(${ref()}>1,${ref()},"no")`,
        () => `=IFERROR(${ref()}/${ref()},-1)`,
        () => `=ISERROR(${ref()})`,
        () => `=${ref()}&"x"`,
        () => '=1/0',
        () => '=SUM(',
      ])();
    };

    let incrementalPasses = 0;
    for (let sheetIndex = 0; sheetIndex < 40; sheetIndex += 1) {
      const raws = Array.from({ length: rowCount }, () => Array.from({ length: colCount }, (_, c) => randomRaw(c)));
      let state = recalculateFormulasWithState(makeSheet(raws));
      expect(results(state.data)).toEqual(results(recalculateFormulas(makeSheet(raws))));

      for (let step = 0; step < 25; step += 1) {
        const edits = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
          const target = { row: Math.floor(random() * rowCount), col: Math.floor(random() * colCount) };
          return { ...target, raw: randomRaw(target.col) };
        });
        const next = edit(state, edits);
        state = recalculateFormulasIncremental(state, next, edits);
        if (state.stats.mode === 'incremental') incrementalPasses += 1;
        const context = `sheet ${sheetIndex} step ${step}: ${JSON.stringify(next.rows.map((row) => row.map((c) => c.raw)))}`;
        expect(results(state.data), context).toEqual(results(recalculateFormulas(next)));
      }
    }
    // Most passes must take the incremental path for this to prove anything.
    expect(incrementalPasses).toBeGreaterThan(500);
  });
});

// Timing only, nothing asserted on speed. Run with FORMULA_BENCH=1.
describe.skipIf(!process.env.FORMULA_BENCH)('incremental recalculation benchmark', () => {
  const ROWS = 10_000;
  const scenarios: Array<{ name: string; row: (index: number) => string[] }> = [
    { name: 'independent =A*2+1', row: (i) => ['' + i, `=A${i + 1}*2+1`] },
    // Chains of 100 stay under the 256-deep dependency limit.
    { name: 'chains of 100', row: (i) => ['' + i, i % 100 === 0 ? `=A${i + 1}` : `=B${i}+A${i + 1}`] },
    { name: 'per-row + one =SUM(B:B)', row: (i) => ['' + i, `=A${i + 1}*2`, i === 0 ? '=SUM(B:B)' : ''] },
  ];

  it.each(scenarios)('$name: 10k formulas, single-cell edit', ({ name, row }) => {
    const sheet = makeSheet(Array.from({ length: ROWS }, (_, i) => row(i)));
    const time = (run: () => void, repeat: number) => {
      const samples: number[] = [];
      for (let i = 0; i < repeat; i += 1) {
        const start = performance.now();
        run();
        samples.push(performance.now() - start);
      }
      return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    };

    const full = time(() => recalculateFormulas(sheet), 5);
    const withState = time(() => recalculateFormulasWithState(sheet), 5);
    let state = recalculateFormulasWithState(sheet);
    let evaluated = 0;
    let value = 0;
    const editRow = 5_050;
    const incremental = time(() => {
      value += 1;
      const changes = [{ row: editRow, col: 0, raw: String(value) }];
      state = recalculateFormulasIncremental(state, edit(state, changes), changes);
      evaluated = state.stats.evaluatedFormulas;
    }, 50);
    const formulaEdit = time(() => {
      value += 1;
      const changes = [{ row: editRow, col: 1, raw: `=A${editRow + 1}*${value}` }];
      state = recalculateFormulasIncremental(state, edit(state, changes), changes);
    }, 20);

    expect(results(state.data)).toEqual(results(recalculateFormulas(state.data)));
    console.log(
      `[formula bench] ${name}: full ${full.toFixed(1)}ms, full+state ${withState.toFixed(1)}ms, `
      + `incremental value edit ${incremental.toFixed(2)}ms (${evaluated} evaluated), `
      + `incremental formula edit ${formulaEdit.toFixed(2)}ms`
    );
  });
});

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
