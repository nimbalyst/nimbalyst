/**
 * Pure grid keyboard controller.
 *
 * `handleGridKey(state, event, view, platform)` maps one keystroke to the next
 * selection/edit state plus a list of effects (commit, clear, fill...) for the
 * host to perform. It owns no DOM and no data, so every Sheets behavior here is
 * a table-driven unit test rather than a manual check. See plan D2: this sits in
 * front of RevoGrid's document-level listener and the grid only renders.
 */

import type {
  CellCoord,
  CellRange,
  GridKeyEffect,
  GridKeyEvent,
  GridKeyResult,
  GridKeyState,
  GridView,
  KeyboardPlatform,
} from './types';

export function createGridKeyState(cell: CellCoord = { row: 0, col: 0 }): GridKeyState {
  return { active: cell, anchor: cell, focus: cell, mode: 'none', tabRunStartCol: null };
}

export function selectionRange(state: Pick<GridKeyState, 'anchor' | 'focus'>): CellRange {
  return normalizeRange(state.anchor, state.focus);
}

export function normalizeRange(a: CellCoord, b: CellCoord): CellRange {
  return {
    startRow: Math.min(a.row, b.row),
    startCol: Math.min(a.col, b.col),
    endRow: Math.max(a.row, b.row),
    endCol: Math.max(a.col, b.col),
  };
}

/**
 * Where Ctrl/Cmd+arrow lands from `from`, moving one axis by `dRow`/`dCol`.
 *
 * Sheets rules: inside a run of filled cells, stop at the last filled cell of
 * the run. Otherwise (current or next cell empty) skip blanks to the next
 * filled cell, or to the sheet edge when there is none.
 */
export function findDataEdge(view: GridView, from: CellCoord, dRow: number, dCol: number): CellCoord {
  const inBounds = (r: number, c: number) => r >= 0 && c >= 0 && r < view.rowCount && c < view.colCount;
  let r = from.row + dRow;
  let c = from.col + dCol;
  if (!inBounds(r, c)) return from;

  if (!view.isEmpty(from.row, from.col) && !view.isEmpty(r, c)) {
    while (inBounds(r + dRow, c + dCol) && !view.isEmpty(r + dRow, c + dCol)) {
      r += dRow;
      c += dCol;
    }
    return { row: r, col: c };
  }

  while (inBounds(r, c)) {
    if (!view.isEmpty(r, c)) return { row: r, col: c };
    r += dRow;
    c += dCol;
  }
  return { row: r - dRow, col: c - dCol };
}

const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

const NOT_HANDLED = (state: GridKeyState): GridKeyResult => ({ state, effects: [], handled: false });

export function handleGridKey(
  state: GridKeyState,
  event: GridKeyEvent,
  view: GridView,
  platform: KeyboardPlatform,
): GridKeyResult {
  if (event.isComposing) return NOT_HANDLED(state);
  if (view.rowCount <= 0 || view.colCount <= 0) return NOT_HANDLED(state);

  const primary = platform.isMac ? !!event.metaKey : !!event.ctrlKey;
  const shift = !!event.shiftKey;
  const alt = !!event.altKey;
  const { key } = event;
  const editing = state.mode !== 'none';

  // --- Keys that act the same in every editing mode --------------------------
  if (editing) {
    if (key === 'Escape') {
      return { state: { ...state, mode: 'none' }, effects: [{ type: 'cancelEdit' }], handled: true };
    }
    if (key === 'Enter' && alt && !primary) {
      return { state, effects: [{ type: 'insertNewline' }], handled: true };
    }
    if (key === 'Enter' && primary) {
      return {
        state: { ...state, mode: 'none', tabRunStartCol: null },
        effects: [{ type: 'fillSelection', range: selectionRange(state) }],
        handled: true,
      };
    }
    if (key === 'Enter' || key === 'Tab') {
      return commitAndAdvance(state, key, shift, view, [{ type: 'commitEdit' }]);
    }
    if (key === 'F2' && state.mode === 'enter') {
      return { state: { ...state, mode: 'edit' }, effects: [], handled: true };
    }
    // Enter mode: a plain arrow commits and moves. Modified arrows stay with
    // the input (word jumps, text selection).
    const arrow = ARROWS[key];
    if (state.mode === 'enter' && arrow && !shift && !primary && !alt) {
      const next = arrowTarget(view, state.active, arrow[0], arrow[1]);
      return collapseTo(next, [{ type: 'commitEdit' }]);
    }
    return NOT_HANDLED(state);
  }

  // --- Navigation mode ------------------------------------------------------
  // Shift extends from the active cell. When Enter/Tab cycled the active cell
  // away from the anchor, re-anchor on it first so the result still holds it.
  if (shift) state = reanchorOnActive(state);
  const arrow = ARROWS[key];
  if (arrow && !alt) {
    const origin = shift ? state.focus : state.active;
    const target = primary
      ? findDataEdge(view, origin, arrow[0], arrow[1])
      : arrowTarget(view, origin, arrow[0], arrow[1]);
    return shift ? extendTo(state, target) : collapseTo(target);
  }

  if (key === 'Home' || key === 'End') {
    const origin = shift ? state.focus : state.active;
    let target: CellCoord;
    if (primary) {
      target = key === 'Home' ? { row: 0, col: 0 } : clampCell(view, view.lastDataCell?.() ?? lastCell(view));
    } else {
      target = { row: origin.row, col: key === 'Home' ? 0 : view.colCount - 1 };
    }
    return shift ? extendTo(state, target) : collapseTo(target);
  }

  if ((key === 'PageDown' || key === 'PageUp') && !primary && !alt) {
    const origin = shift ? state.focus : state.active;
    const page = Math.max(1, view.pageRows);
    const pinned = Math.max(view.frozenRowCount ?? 0, view.headerRowCount ?? 0);
    // Paging up from the scrollable area stops at its first row, not inside
    // the pinned rows above it.
    const floor = origin.row >= pinned ? Math.min(pinned, view.rowCount - 1) : 0;
    const row =
      key === 'PageDown'
        ? Math.min(view.rowCount - 1, origin.row + page)
        : Math.max(floor, origin.row - page);
    const target = { row, col: origin.col };
    return shift ? extendTo(state, target) : collapseTo(target);
  }

  if (key === ' ' && shift && !primary && !event.ctrlKey) {
    const range = selectionRange(state);
    return selectRect(state, { row: range.startRow, col: 0 }, { row: range.endRow, col: view.colCount - 1 });
  }
  // Ctrl+Space selects columns on every platform (Cmd+Space belongs to the OS).
  if (key === ' ' && event.ctrlKey && !event.metaKey) {
    const range = selectionRange(state);
    return selectRect(state, { row: 0, col: range.startCol }, { row: view.rowCount - 1, col: range.endCol });
  }

  if (primary && !alt && isLetter(key, 'a')) {
    return selectRect(state, { row: 0, col: 0 }, lastCell(view));
  }

  if (primary && !alt && (isLetter(key, 'd') || isLetter(key, 'r'))) {
    return fill(state, isLetter(key, 'd') ? 'fillDown' : 'fillRight');
  }

  if (key === 'Enter' || key === 'Tab') {
    const range = selectionRange(state);
    // After a Tab commit, Enter continues the run (next row, run's column)
    // rather than opening the cell the Tab landed on.
    if (key === 'Enter' && !shift && isSingleCell(range) && state.tabRunStartCol === null) {
      return {
        state: { ...state, mode: 'edit' },
        effects: [{ type: 'beginEdit', mode: 'edit' }],
        handled: true,
      };
    }
    return commitAndAdvance(state, key, shift, view, []);
  }

  if (key === 'F2') {
    return {
      state: { ...state, mode: 'edit' },
      effects: [{ type: 'beginEdit', mode: 'edit' }],
      handled: true,
    };
  }

  if (key === 'Delete' || key === 'Backspace') {
    if (primary || alt) return NOT_HANDLED(state);
    return { state, effects: [{ type: 'clearRange', range: selectionRange(state) }], handled: true };
  }

  if (isPrintable(event, platform)) {
    return {
      // The selection survives so Cmd+Enter can fill it with what was typed.
      state: { ...state, mode: 'enter' },
      effects: [{ type: 'beginEdit', mode: 'enter', initialText: key }],
      handled: true,
    };
  }

  return NOT_HANDLED(state);
}

// --- helpers ------------------------------------------------------------------

/**
 * Make the active cell the anchor, keeping the rectangle: the new focus is the
 * corner farthest from the active cell.
 */
function reanchorOnActive(state: GridKeyState): GridKeyState {
  const { active, anchor } = state;
  if (active.row === anchor.row && active.col === anchor.col) return state;
  const range = selectionRange(state);
  const far = (value: number, start: number, end: number) => (value - start >= end - value ? start : end);
  return {
    ...state,
    anchor: active,
    focus: { row: far(active.row, range.startRow, range.endRow), col: far(active.col, range.startCol, range.endCol) },
  };
}

function lastCell(view: GridView): CellCoord {
  return { row: view.rowCount - 1, col: view.colCount - 1 };
}

/** One step sideways, over hidden columns; stays put when only hidden columns lie that way. */
function stepCol(view: GridView, from: CellCoord, delta: number): CellCoord {
  if (delta === 0 || !view.isColHidden) return clampCell(view, { row: from.row, col: from.col + delta });
  let col = from.col + delta;
  while (col >= 0 && col < view.colCount && view.isColHidden(col)) col += delta;
  return col < 0 || col >= view.colCount ? from : { row: from.row, col };
}

/** A plain arrow move: rows clamp, columns step over hidden ones. */
function arrowTarget(view: GridView, from: CellCoord, dRow: number, dCol: number): CellCoord {
  if (dCol !== 0) return stepCol(view, from, dCol);
  return clampCell(view, { row: from.row + dRow, col: from.col });
}

function clampCell(view: GridView, cell: CellCoord): CellCoord {
  return {
    row: Math.max(0, Math.min(view.rowCount - 1, cell.row)),
    col: Math.max(0, Math.min(view.colCount - 1, cell.col)),
  };
}

function isSingleCell(range: CellRange): boolean {
  return range.startRow === range.endRow && range.startCol === range.endCol;
}

function isLetter(key: string, letter: string): boolean {
  return key.length === 1 && key.toLowerCase() === letter;
}

function isPrintable(event: GridKeyEvent, platform: KeyboardPlatform): boolean {
  if ([...event.key].length !== 1) return false;
  if (event.metaKey) return false;
  if (event.ctrlKey) {
    // AltGr on Windows/Linux reports Ctrl+Alt and produces a character.
    return !platform.isMac && !!event.altKey;
  }
  // Option produces characters on Mac; Alt is a menu accelerator elsewhere.
  if (event.altKey) return platform.isMac;
  return true;
}

function collapseTo(cell: CellCoord, before: GridKeyEffect[] = []): GridKeyResult {
  return {
    state: { active: cell, anchor: cell, focus: cell, mode: 'none', tabRunStartCol: null },
    effects: [...before, { type: 'scrollIntoView', cell }],
    handled: true,
  };
}

function extendTo(state: GridKeyState, focus: CellCoord): GridKeyResult {
  return {
    state: { ...state, focus, mode: 'none', tabRunStartCol: null },
    effects: [{ type: 'scrollIntoView', cell: focus }],
    handled: true,
  };
}

function selectRect(state: GridKeyState, anchor: CellCoord, focus: CellCoord): GridKeyResult {
  return { state: { ...state, anchor, focus, tabRunStartCol: null }, effects: [], handled: true };
}

function fill(state: GridKeyState, type: 'fillDown' | 'fillRight'): GridKeyResult {
  let range = selectionRange(state);
  // A one-row (one-column) selection copies from the row above (column left).
  if (type === 'fillDown' && range.startRow === range.endRow) {
    if (range.startRow === 0) return { state, effects: [], handled: true };
    range = { ...range, startRow: range.startRow - 1 };
  }
  if (type === 'fillRight' && range.startCol === range.endCol) {
    if (range.startCol === 0) return { state, effects: [], handled: true };
    range = { ...range, startCol: range.startCol - 1 };
  }
  return { state, effects: [{ type, range }], handled: true };
}

/**
 * Enter / Tab advance (after an optional commit). Inside a multi-cell selection
 * the active cell cycles through the selection and the selection is kept, like
 * Sheets. Otherwise Tab moves right and remembers where its run started, and
 * Enter moves down, returning to that column.
 */
function commitAndAdvance(
  state: GridKeyState,
  key: 'Enter' | 'Tab',
  shift: boolean,
  view: GridView,
  before: GridKeyEffect[],
): GridKeyResult {
  const range = selectionRange(state);
  const { active } = state;

  if (!isSingleCell(range)) {
    const next = cycleWithinRange(range, active, key === 'Enter' ? 'col-major' : 'row-major', shift ? -1 : 1);
    return {
      state: { ...state, active: next, mode: 'none', tabRunStartCol: null },
      effects: [...before, { type: 'scrollIntoView', cell: next }],
      handled: true,
    };
  }

  if (key === 'Tab') {
    const next = stepCol(view, active, shift ? -1 : 1);
    const result = collapseTo(next, before);
    const tabRunStartCol = shift ? state.tabRunStartCol : (state.tabRunStartCol ?? active.col);
    return { ...result, state: { ...result.state, tabRunStartCol } };
  }

  const col = state.tabRunStartCol ?? active.col;
  return collapseTo(clampCell(view, { row: active.row + (shift ? -1 : 1), col }), before);
}

function cycleWithinRange(
  range: CellRange,
  cell: CellCoord,
  order: 'row-major' | 'col-major',
  step: 1 | -1,
): CellCoord {
  const width = range.endCol - range.startCol + 1;
  const height = range.endRow - range.startRow + 1;
  const total = width * height;
  const r = cell.row - range.startRow;
  const c = cell.col - range.startCol;
  const index = order === 'row-major' ? r * width + c : c * height + r;
  const next = (((index + step) % total) + total) % total;
  return order === 'row-major'
    ? { row: range.startRow + Math.floor(next / width), col: range.startCol + (next % width) }
    : { row: range.startRow + (next % height), col: range.startCol + Math.floor(next / height) };
}
