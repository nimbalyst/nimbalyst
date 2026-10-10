/**
 * Named ranges: `namedRanges` in the sheet metadata maps a name to an A1 range
 * key (`B2`, `A2:A100`), or to `#REF!` once a structural edit deleted every
 * cell it covered.
 *
 * Names follow the Sheets rules and compare case-insensitively; the stored
 * spelling is the one the user typed. The formula engine resolves a name at
 * parse time into the range it names (`resolveName`), so the dependency graph
 * and incremental recalculation see an ordinary range reference.
 *
 * Structural edits move a named range with its cells, like every other
 * range-keyed field. Sorting leaves it where it is: like a multi-row
 * conditional format, a name describes an area, not the rows that happen to be
 * in it.
 */

import { parseRangeKey, rangeKeyOf } from '../cells/rangeMath';
import { shiftRangeKey } from '../conditional/rangeKeys';
import { scanFormulaTokens } from '../formula/referenceScanner';
import type { StructuralEdit } from '../structure/structuralEdit';
import type { SheetCommand } from '../commands/sheetCommand';
import type { CellWrite, SheetState } from '../commands/sheetState';
import { NAMED_RANGE_REF_ERROR, type NamedRangeTable } from '../utils/engine/names';
import { parseCellReference } from '../utils/engine/tokenizer';

export { NAMED_RANGE_REF_ERROR, resolveName } from '../utils/engine/names';
export type NamedRanges = NamedRangeTable;

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const R1C1_LIKE = /^[Rr]\d*[Cc]\d*$/;
const MAX_NAME_LENGTH = 250;

/**
 * Why `name` cannot name a range, or null when it can. `renaming` is the
 * current name of the entry being renamed, which does not collide with itself.
 */
export function rangeNameError(name: string, existing: NamedRanges, renaming?: string): string | null {
  if (name.length === 0) return 'Enter a name.';
  if (name.length > MAX_NAME_LENGTH) return `Names can be at most ${MAX_NAME_LENGTH} characters.`;
  if (!NAME_PATTERN.test(name)) return 'Names can contain only letters, numbers and underscores, and cannot start with a number.';
  if (/^(TRUE|FALSE)$/i.test(name)) return 'TRUE and FALSE cannot be names.';
  // Exactly the words the formula tokenizer reads as cell references, so every accepted name tokenizes as a name.
  if (parseCellReference(name) || R1C1_LIKE.test(name)) return 'A name cannot look like a cell reference.';
  const taken = findName(existing, name);
  if (taken !== undefined && taken.toUpperCase() !== renaming?.toUpperCase()) return `${taken} already exists.`;
  return null;
}

/** The A1 range key for what the user typed (`$A$1:$B$5`, `b2`), or null when it is not a cell range. */
export function normalizeRangeTarget(text: string): string | null {
  const bounds = parseRangeKey(text.replace(/\$/g, '').trim());
  return bounds ? rangeKeyOf(bounds) : null;
}

/** The stored spelling of `name`, matched case-insensitively. */
export function findName(names: NamedRanges, name: string): string | undefined {
  const upper = name.toUpperCase();
  return Object.keys(names).find((key) => key.toUpperCase() === upper);
}

/**
 * Named ranges after a structural edit. A range shrinks with deleted rows or
 * columns and becomes `#REF!` when all of it is deleted; a move that splits it
 * keeps the bounding range of the pieces.
 */
export function shiftNamedRanges(names: NamedRanges, edit: StructuralEdit): Record<string, string> {
  const next: Record<string, string> = {};
  let changed = false;
  for (const [name, range] of Object.entries(names)) {
    next[name] = shiftTarget(range, edit);
    if (next[name] !== range) changed = true;
  }
  return changed ? next : names as Record<string, string>;
}

function shiftTarget(range: string, edit: StructuralEdit): string {
  if (range === NAMED_RANGE_REF_ERROR || !parseRangeKey(range)) return range;
  const pieces = shiftRangeKey(range, edit).map(parseRangeKey).filter((piece) => piece !== null);
  if (pieces.length === 0) return NAMED_RANGE_REF_ERROR;
  return rangeKeyOf({
    startRow: Math.min(...pieces.map((piece) => piece.startRow)),
    startCol: Math.min(...pieces.map((piece) => piece.startCol)),
    endRow: Math.max(...pieces.map((piece) => piece.endRow)),
    endCol: Math.max(...pieces.map((piece) => piece.endCol)),
  });
}

/**
 * `formula` with every use of the name `from` spelled `to`, leaving string
 * literals, function names and everything else as written. Returns the input
 * unchanged when it does not use the name.
 */
export function renameInFormula(formula: string, from: string, to: string): string {
  if (!formula.trimStart().startsWith('=')) return formula;
  const upper = from.toUpperCase();
  let out = '';
  let changed = false;
  for (const token of scanFormulaTokens(formula)) {
    if (token.kind === 'name' && token.text.toUpperCase() === upper) {
      out += to;
      changed = true;
    } else {
      out += token.text;
    }
  }
  return changed ? out : formula;
}

/**
 * Rename a named range and every formula that uses it, as one command (one
 * undo step). `from` matches case-insensitively; null when there is no such name.
 */
export function renameNamedRangeCommand(state: SheetState, from: string, to: string): SheetCommand | null {
  const names = state.meta.namedRanges;
  const current = findName(names, from);
  if (current === undefined) return null;
  const namedRanges: Record<string, string> = {};
  for (const [name, range] of Object.entries(names)) namedRanges[name === current ? to : name] = range;
  const cells: CellWrite[] = [];
  state.rows.forEach((row, rowIndex) => row.forEach((value, col) => {
    const renamed = renameInFormula(value, current, to);
    if (renamed !== value) cells.push({ row: rowIndex, col, value: renamed });
  }));
  return { type: 'batch', commands: [{ type: 'setMeta', patch: { namedRanges } }, { type: 'setCells', cells }] };
}

/**
 * Make `name` refer to `range`, as one command. With `previous`, the entry is
 * renamed first and the formulas that use it follow.
 */
export function defineNamedRangeCommand(state: SheetState, name: string, range: string, previous?: string): SheetCommand {
  const current = state.meta.namedRanges;
  const from = previous === undefined ? undefined : findName(current, previous);
  const renamed = from !== undefined && from !== name ? renameNamedRangeCommand(state, from, name) : null;
  const base = renamed
    ? Object.fromEntries(Object.entries(current).map(([key, value]) => [key === from ? name : key, value]))
    : current;
  const setRange: SheetCommand = { type: 'setMeta', patch: { namedRanges: { ...base, [name]: range } } };
  return renamed ? { type: 'batch', commands: [renamed, setRange] } : setRange;
}
