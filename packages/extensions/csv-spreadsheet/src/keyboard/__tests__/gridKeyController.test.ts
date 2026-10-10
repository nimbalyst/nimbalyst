// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createGridKeyState, findDataEdge, handleGridKey, selectionRange } from '../gridKeyController';
import type { CellCoord, GridKeyEvent, GridKeyState, GridView, KeyboardPlatform } from '../types';
import { resolveSheetShortcut, todayIso } from '../sheetShortcuts';

const MAC: KeyboardPlatform = { isMac: true };
const PC: KeyboardPlatform = { isMac: false };

/** Grid built from rows of 'x' (filled) / '.' (empty). */
function view(pattern: string[], extra: Partial<GridView> = {}): GridView {
  return {
    rowCount: pattern.length,
    colCount: pattern[0].length,
    pageRows: 3,
    isEmpty: (r, c) => pattern[r][c] !== 'x',
    ...extra,
  };
}

const at = (row: number, col: number): CellCoord => ({ row, col });
const stateAt = (row: number, col: number, over: Partial<GridKeyState> = {}): GridKeyState => ({
  ...createGridKeyState(at(row, col)),
  ...over,
});

function press(state: GridKeyState, ev: GridKeyEvent | string, v: GridView, p: KeyboardPlatform = MAC) {
  return handleGridKey(state, typeof ev === 'string' ? { key: ev } : ev, v, p);
}

const BLANK = view(['.....', '.....', '.....', '.....', '.....', '.....', '.....', '.....']);

describe('findDataEdge (Ctrl/Cmd+arrow)', () => {
  const row = view(['xxx..x..']);
  it.each([
    [0, 2, 'inside a filled run stops at its last cell'],
    [2, 5, 'from the end of a run skips blanks to the next filled cell'],
    [3, 5, 'from a blank jumps to the next filled cell'],
    [5, 7, 'with nothing filled ahead goes to the sheet edge'],
    [7, 7, 'at the edge stays put'],
  ])('from col %i lands on col %i (%s)', (from, to) => {
    expect(findDataEdge(row, at(0, from), 0, 1)).toEqual(at(0, to));
  });

  it('works leftward and vertically', () => {
    expect(findDataEdge(row, at(0, 7), 0, -1)).toEqual(at(0, 5));
    expect(findDataEdge(row, at(0, 5), 0, -1)).toEqual(at(0, 2));
    const col = view(['x', 'x', '.', 'x']);
    expect(findDataEdge(col, at(0, 0), 1, 0)).toEqual(at(1, 0));
    expect(findDataEdge(col, at(3, 0), -1, 0)).toEqual(at(1, 0));
  });
});

describe('navigation', () => {
  it('arrows move and collapse the selection, clamped at the edges', () => {
    const s = stateAt(0, 0, { focus: at(2, 2) });
    const r = press(s, 'ArrowDown', BLANK);
    expect(r.state.active).toEqual(at(1, 0));
    expect(selectionRange(r.state)).toEqual({ startRow: 1, startCol: 0, endRow: 1, endCol: 0 });
    expect(r.effects).toEqual([{ type: 'scrollIntoView', cell: at(1, 0) }]);
    expect(press(stateAt(0, 0), 'ArrowUp', BLANK).state.active).toEqual(at(0, 0));
  });

  it('arrows, Tab and Enter-mode arrows step over hidden columns, and stay put when only hidden ones remain', () => {
    const hidden = view(['.....'], { isColHidden: (c) => c === 1 || c === 2 || c === 4 });
    expect(press(stateAt(0, 0), 'ArrowRight', hidden).state.active).toEqual(at(0, 3));
    expect(press(stateAt(0, 3), 'ArrowLeft', hidden).state.active).toEqual(at(0, 0));
    expect(press(stateAt(0, 3), 'ArrowRight', hidden).state.active).toEqual(at(0, 3));
    expect(press(stateAt(0, 0), 'Tab', hidden).state.active).toEqual(at(0, 3));
    expect(press(stateAt(0, 0, { mode: 'enter' }), 'ArrowRight', hidden).state.active).toEqual(at(0, 3));
  });

  it('Shift+arrow moves the focus corner and keeps the active cell', () => {
    let s = stateAt(2, 2);
    s = press(s, { key: 'ArrowRight', shiftKey: true }, BLANK).state;
    s = press(s, { key: 'ArrowUp', shiftKey: true }, BLANK).state;
    expect(s.active).toEqual(at(2, 2));
    expect(selectionRange(s)).toEqual({ startRow: 1, startCol: 2, endRow: 2, endCol: 3 });
  });

  it('uses Cmd on Mac and Ctrl elsewhere for data jumps', () => {
    const v = view(['xxx..']);
    expect(press(stateAt(0, 0), { key: 'ArrowRight', metaKey: true }, v, MAC).state.active).toEqual(at(0, 2));
    expect(press(stateAt(0, 0), { key: 'ArrowRight', ctrlKey: true }, v, PC).state.active).toEqual(at(0, 2));
    // Ctrl on Mac is not the primary modifier: a plain one-cell move.
    expect(press(stateAt(0, 0), { key: 'ArrowRight', ctrlKey: true }, v, MAC).state.active).toEqual(at(0, 1));
  });

  it('Ctrl+Shift+arrow extends to the data edge from the focus corner', () => {
    const v = view(['xxx.x']);
    let s = press(stateAt(0, 0), { key: 'ArrowRight', ctrlKey: true, shiftKey: true }, v, PC).state;
    expect(selectionRange(s)).toEqual({ startRow: 0, startCol: 0, endRow: 0, endCol: 2 });
    s = press(s, { key: 'ArrowRight', ctrlKey: true, shiftKey: true }, v, PC).state;
    expect(selectionRange(s).endCol).toBe(4);
    expect(s.active).toEqual(at(0, 0));
  });

  it('Home/End go to the row ends; Cmd+Home/End to the sheet corners', () => {
    expect(press(stateAt(3, 2), 'Home', BLANK).state.active).toEqual(at(3, 0));
    expect(press(stateAt(3, 2), 'End', BLANK).state.active).toEqual(at(3, 4));
    expect(press(stateAt(3, 2), { key: 'Home', metaKey: true }, BLANK).state.active).toEqual(at(0, 0));
    expect(press(stateAt(3, 2), { key: 'End', metaKey: true }, BLANK).state.active).toEqual(at(7, 4));
    const used = { ...BLANK, lastDataCell: () => at(4, 1) };
    expect(press(stateAt(0, 0), { key: 'End', metaKey: true }, used).state.active).toEqual(at(4, 1));
    const ext = press(stateAt(3, 2), { key: 'Home', shiftKey: true }, BLANK).state;
    expect(selectionRange(ext)).toEqual({ startRow: 3, startCol: 0, endRow: 3, endCol: 2 });
  });

  it('PageDown/PageUp move by a page, stopping below pinned rows when coming from the scroll area', () => {
    const pinned = { ...BLANK, headerRowCount: 1 };
    expect(press(stateAt(1, 1), 'PageDown', pinned).state.active).toEqual(at(4, 1));
    expect(press(stateAt(6, 1), 'PageDown', pinned).state.active).toEqual(at(7, 1));
    expect(press(stateAt(2, 1), 'PageUp', pinned).state.active).toEqual(at(1, 1));
    expect(press(stateAt(0, 1), 'PageUp', pinned).state.active).toEqual(at(0, 1));
    const ext = press(stateAt(1, 1), { key: 'PageDown', shiftKey: true }, pinned).state;
    expect(selectionRange(ext)).toEqual({ startRow: 1, startCol: 1, endRow: 4, endCol: 1 });
  });

  it('Shift+Space selects the rows of the selection, Ctrl+Space its columns, Cmd+A everything', () => {
    const s = stateAt(2, 1, { focus: at(3, 2) });
    expect(selectionRange(press(s, { key: ' ', shiftKey: true }, BLANK).state)).toEqual({
      startRow: 2, startCol: 0, endRow: 3, endCol: 4,
    });
    const cols = press(s, { key: ' ', ctrlKey: true }, BLANK, MAC);
    expect(selectionRange(cols.state)).toEqual({ startRow: 0, startCol: 1, endRow: 7, endCol: 2 });
    expect(cols.state.active).toEqual(at(2, 1));
    expect(selectionRange(press(s, { key: 'a', metaKey: true }, BLANK).state)).toEqual({
      startRow: 0, startCol: 0, endRow: 7, endCol: 4,
    });
  });
});

describe('Tab / Enter', () => {
  it('Enter on a single cell opens the editor in edit mode', () => {
    const r = press(stateAt(1, 1), 'Enter', BLANK);
    expect(r.state.mode).toBe('edit');
    expect(r.effects).toEqual([{ type: 'beginEdit', mode: 'edit' }]);
  });

  it('typing across a row with Tab then Enter returns to the column the run started in', () => {
    let s = press(stateAt(2, 1), 'a', BLANK).state;
    s = press(s, 'Tab', BLANK).state;
    s = press(s, 'b', BLANK).state;
    s = press(s, 'Tab', BLANK).state;
    s = press(s, 'c', BLANK).state;
    const r = press(s, 'Enter', BLANK);
    expect(r.effects[0]).toEqual({ type: 'commitEdit' });
    expect(r.state.active).toEqual(at(3, 1));
    expect(r.state.tabRunStartCol).toBeNull();
    expect(r.state.mode).toBe('none');
  });

  it('any other navigation ends the Tab run', () => {
    let s = press(stateAt(0, 0), 'Tab', BLANK).state;
    s = press(s, 'ArrowRight', BLANK).state;
    s = press(press(s, 'x', BLANK).state, 'Enter', BLANK).state;
    expect(s.active).toEqual(at(1, 2));
  });

  it('Shift+Enter / Shift+Tab move up / left', () => {
    expect(press(stateAt(2, 2, { mode: 'edit' }), { key: 'Enter', shiftKey: true }, BLANK).state.active).toEqual(at(1, 2));
    expect(press(stateAt(2, 2), { key: 'Tab', shiftKey: true }, BLANK).state.active).toEqual(at(2, 1));
  });

  it('inside a multi-cell selection Enter cycles down columns and Tab across rows, keeping the selection', () => {
    const sel = stateAt(0, 0, { focus: at(1, 1) });
    let s = press(sel, 'Enter', BLANK).state;
    expect(s.active).toEqual(at(1, 0));
    s = press(s, 'Enter', BLANK).state;
    expect(s.active).toEqual(at(0, 1));
    expect(selectionRange(s)).toEqual({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    expect(press(sel, 'Tab', BLANK).state.active).toEqual(at(0, 1));
    expect(press(sel, { key: 'Tab', shiftKey: true }, BLANK).state.active).toEqual(at(1, 1));
  });
});

describe('selection invariants', () => {
  // R1-5: Enter moved the active cell to A2 inside A1:B2; Shift+Up then
  // shrank the range from the old focus corner and left A2 outside it.
  it('Shift+arrow after cycling with Enter keeps the active cell inside the selection', () => {
    let state: GridKeyState = { ...stateAt(0, 0), focus: at(1, 1) };
    state = press(state, 'Enter', BLANK).state;
    expect(state.active).toEqual(at(1, 0));
    state = press(state, { key: 'ArrowUp', shiftKey: true }, BLANK).state;
    const range = selectionRange(state);
    expect(state.active.row).toBeGreaterThanOrEqual(range.startRow);
    expect(state.active.row).toBeLessThanOrEqual(range.endRow);
    expect(state.active.col).toBeGreaterThanOrEqual(range.startCol);
    expect(state.active.col).toBeLessThanOrEqual(range.endCol);
  });

  // R1-9: B3, type, Tab, Enter without typing in C3 started editing C3.
  it('Enter after a Tab commit moves to the next row of the run instead of editing', () => {
    let state = stateAt(2, 1);
    state = press(state, 'x', BLANK).state;
    state = press(state, 'Tab', BLANK).state;
    const result = press(state, 'Enter', BLANK);
    expect(result.effects.some((effect) => effect.type === 'beginEdit')).toBe(false);
    expect(result.state.active).toEqual(at(3, 1));
  });
});

describe('edit model', () => {
  it('typing a printable key opens enter mode replacing the content', () => {
    const r = press(stateAt(1, 1), 'q', BLANK);
    expect(r.state.mode).toBe('enter');
    expect(r.effects).toEqual([{ type: 'beginEdit', mode: 'enter', initialText: 'q' }]);
  });

  it.each([
    [{ key: 'c', metaKey: true }, MAC, false],
    [{ key: 'c', ctrlKey: true }, MAC, false],
    [{ key: 'å', altKey: true }, MAC, true],
    [{ key: 'f', altKey: true }, PC, false],
    [{ key: '@', ctrlKey: true, altKey: true }, PC, true],
    [{ key: 'Shift', shiftKey: true }, MAC, false],
  ] as const)('printable check %o on %o -> %s', (ev, platform, opens) => {
    expect(press(stateAt(0, 0), ev, BLANK, platform).state.mode).toBe(opens ? 'enter' : 'none');
  });

  it('in enter mode a plain arrow commits and moves; modified arrows stay with the input', () => {
    const s = stateAt(1, 1, { mode: 'enter' });
    const r = press(s, 'ArrowLeft', BLANK);
    expect(r.effects[0]).toEqual({ type: 'commitEdit' });
    expect(r.state).toMatchObject({ active: at(1, 0), mode: 'none' });
    expect(press(s, { key: 'ArrowLeft', shiftKey: true }, BLANK).handled).toBe(false);
    expect(press(s, { key: 'ArrowLeft', altKey: true }, BLANK).handled).toBe(false);
  });

  it('in edit mode caret keys and typing belong to the input', () => {
    const s = stateAt(1, 1, { mode: 'edit' });
    for (const key of ['ArrowLeft', 'ArrowDown', 'Home', 'End', 'Backspace', 'Delete', 'z', ' ']) {
      expect(press(s, key, BLANK)).toEqual({ state: s, effects: [], handled: false });
    }
  });

  it('F2 opens edit mode, and switches enter mode to edit mode', () => {
    expect(press(stateAt(0, 0), 'F2', BLANK).effects).toEqual([{ type: 'beginEdit', mode: 'edit' }]);
    const r = press(stateAt(0, 0, { mode: 'enter' }), 'F2', BLANK);
    expect(r.state.mode).toBe('edit');
    expect(press(r.state, 'ArrowRight', BLANK).handled).toBe(false);
  });

  it('Escape cancels the edit without moving', () => {
    const r = press(stateAt(2, 2, { mode: 'enter' }), 'Escape', BLANK);
    expect(r.effects).toEqual([{ type: 'cancelEdit' }]);
    expect(r.state).toMatchObject({ active: at(2, 2), mode: 'none' });
    expect(press(stateAt(2, 2), 'Escape', BLANK).handled).toBe(false);
  });

  it('Alt/Option+Enter inserts a newline and stays in the editor', () => {
    const s = stateAt(0, 0, { mode: 'enter' });
    expect(press(s, { key: 'Enter', altKey: true }, BLANK)).toEqual({
      state: s, effects: [{ type: 'insertNewline' }], handled: true,
    });
  });

  it('typing into a multi-cell selection then Cmd+Enter fills the whole selection', () => {
    let s = stateAt(1, 1, { focus: at(3, 2) });
    s = press(s, '7', BLANK).state;
    expect(selectionRange(s)).toEqual({ startRow: 1, startCol: 1, endRow: 3, endCol: 2 });
    const r = press(s, { key: 'Enter', ctrlKey: true }, BLANK, PC);
    expect(r.effects).toEqual([{ type: 'fillSelection', range: { startRow: 1, startCol: 1, endRow: 3, endCol: 2 } }]);
    expect(r.state.mode).toBe('none');
  });

  it('IME composition is never handled', () => {
    expect(press(stateAt(0, 0, { mode: 'enter' }), { key: 'Enter', isComposing: true }, BLANK).handled).toBe(false);
    expect(press(stateAt(0, 0), { key: 'あ', isComposing: true }, BLANK).handled).toBe(false);
  });
});

describe('range effects', () => {
  it('Delete and Backspace clear the selection', () => {
    const s = stateAt(3, 3, { anchor: at(3, 3), focus: at(1, 1) });
    const range = { startRow: 1, startCol: 1, endRow: 3, endCol: 3 };
    expect(press(s, 'Delete', BLANK).effects).toEqual([{ type: 'clearRange', range }]);
    expect(press(s, 'Backspace', BLANK).effects).toEqual([{ type: 'clearRange', range }]);
  });

  it('Ctrl+D fills a multi-row selection down; on one row it copies from the row above', () => {
    const multi = stateAt(1, 0, { focus: at(3, 1) });
    expect(press(multi, { key: 'd', ctrlKey: true }, BLANK, PC).effects).toEqual([
      { type: 'fillDown', range: { startRow: 1, startCol: 0, endRow: 3, endCol: 1 } },
    ]);
    expect(press(stateAt(2, 2), { key: 'd', metaKey: true }, BLANK, MAC).effects).toEqual([
      { type: 'fillDown', range: { startRow: 1, startCol: 2, endRow: 2, endCol: 2 } },
    ]);
    const top = press(stateAt(0, 2), { key: 'd', metaKey: true }, BLANK, MAC);
    expect(top).toMatchObject({ effects: [], handled: true });
  });

  it('Ctrl+R fills right, copying from the column left of a one-column selection', () => {
    expect(press(stateAt(2, 2), { key: 'R', ctrlKey: true, shiftKey: true }, BLANK, PC).effects).toEqual([
      { type: 'fillRight', range: { startRow: 2, startCol: 1, endRow: 2, endCol: 2 } },
    ]);
  });

  it('leaves clipboard and unknown accelerators to the host', () => {
    for (const key of ['c', 'v', 'x', 'z', 'b']) {
      expect(press(stateAt(0, 0), { key, metaKey: true }, BLANK).handled).toBe(false);
    }
  });
});

describe('sheet shortcuts', () => {
  it.each([
    [{ key: 'z', metaKey: true }, MAC, 'undo'],
    [{ key: 'Z', metaKey: true, shiftKey: true }, MAC, 'redo'],
    [{ key: 'y', ctrlKey: true }, PC, 'redo'],
    [{ key: 'y', metaKey: true }, MAC, null],
    [{ key: 'b', ctrlKey: true }, PC, 'bold'],
    [{ key: 'b', ctrlKey: true }, MAC, null],
    [{ key: '$', code: 'Digit4', metaKey: true, shiftKey: true }, MAC, 'formatCurrency'],
    [{ key: '%', code: 'Digit5', metaKey: true, shiftKey: true }, MAC, 'formatPercent'],
    [{ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }, PC, 'formatNumber'],
    [{ key: ';', metaKey: true }, MAC, 'insertDate'],
    [{ key: '/', metaKey: true }, MAC, 'showShortcuts'],
    [{ key: 'k', metaKey: true }, MAC, 'insertLink'],
    [{ key: 'k', ctrlKey: true }, PC, 'insertLink'],
    [{ key: 'V', metaKey: true, shiftKey: true }, MAC, 'pasteValues'],
    [{ key: 'b', metaKey: true, altKey: true }, MAC, null],
    [{ key: 'b', metaKey: true, isComposing: true }, MAC, null],
  ] as const)('%o on %o -> %s', (event, platform, expected) => {
    expect(resolveSheetShortcut(event, platform)).toBe(expected);
  });

  it('formats today as an ISO date the fill series understands', () => {
    expect(todayIso(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});
