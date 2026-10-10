/**
 * Pure text logic for formula point mode, reference coloring and the name box.
 *
 * Point mode: while a formula is being edited, clicking a cell or dragging a
 * range writes `B2` / `B2:B4` at the caret instead of moving the selection.
 * Whether a press may do that is decided here from `(text, caret)` alone:
 *
 * - insert: the caret sits after `=`, an operator, `(`, `,` or `:`, and the
 *   text after it cannot fuse with a reference (`=SUM(|)`, `=A1+|`).
 * - replace: the caret is at the end of (or inside) a reference that itself
 *   sits at an insertion point, so `=A1|` + click B2 becomes `=B2`. A live drag
 *   rewrites the same span on every move through this rule.
 * - none: anything else (`=5|`, inside a string, `=SUM|`). The press then
 *   behaves normally; declining beats writing `=5B2`.
 *
 * Nothing here touches the DOM.
 */

import { resolveName } from '../utils/engine/names';
import type { NormalizedSelectionRange } from '../types';
import { columnIndexToLetter } from '../utils/csvParser';
import type { TextEdit } from './formulaAssist';
import { scanFormulaTokens, type FormulaToken, type ScannedReference } from './referenceScanner';

export type PointTarget =
  | { kind: 'insert'; at: number }
  | { kind: 'replace'; start: number; end: number }
  | { kind: 'none' };

/** The text around the span a point gesture owns; every pick rewrites the gap. */
export interface PointSession {
  prefix: string;
  suffix: string;
}

const NONE: PointTarget = { kind: 'none' };

/** `%` is postfix, so a reference after it would read as `A1%B2`. */
function opensOperand(token: FormulaToken | undefined): boolean {
  if (!token) return false;
  if (token.kind === 'operator') return token.text !== '%';
  return token.kind === 'leftParen' || token.kind === 'comma' || token.kind === 'colon';
}

/** What may directly follow an inserted reference without fusing into it. */
function closesOperand(token: FormulaToken | undefined): boolean {
  if (!token) return true;
  return token.kind === 'whitespace'
    || token.kind === 'rightParen'
    || token.kind === 'comma'
    || (token.kind === 'operator' && token.text !== '=');
}

function previousSolid(tokens: FormulaToken[], index: number): FormulaToken | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (tokens[i].kind !== 'whitespace') return tokens[i];
  }
  return undefined;
}

/**
 * Where a picked reference would go for this text and caret. A non-empty
 * selection only qualifies when it is exactly one reference.
 */
export function resolvePointTarget(text: string, caret: number, selectionEnd = caret): PointTarget {
  if (!text.startsWith('=') || caret < 1) return NONE;
  const tokens = scanFormulaTokens(text);

  if (selectionEnd !== caret) {
    const index = tokens.findIndex((token) => token.start === caret && token.end === selectionEnd);
    if (index < 0 || tokens[index].kind !== 'reference') return NONE;
    return opensOperand(previousSolid(tokens, index)) ? { kind: 'replace', start: caret, end: selectionEnd } : NONE;
  }

  // The caret inside or at the end of a token: only a reference can be replaced.
  const holder = tokens.findIndex((token) => token.start < caret && caret <= token.end);
  if (holder < 0) return NONE;
  const token = tokens[holder];
  if (token.kind === 'reference') {
    return opensOperand(previousSolid(tokens, holder)) && closesOperand(tokens[holder + 1])
      ? { kind: 'replace', start: token.start, end: token.end }
      : NONE;
  }

  if (token.end !== caret && token.kind !== 'whitespace') return NONE;
  const before = token.kind === 'whitespace' ? previousSolid(tokens, holder) : token;
  const after = tokens.find((candidate) => candidate.start >= caret);
  return opensOperand(before) && closesOperand(after) ? { kind: 'insert', at: caret } : NONE;
}

/** Start a point gesture at the caret, or null when the caret is not a point target. */
export function beginPointSession(text: string, caret: number, selectionEnd = caret): PointSession | null {
  const target = resolvePointTarget(text, caret, selectionEnd);
  if (target.kind === 'none') return null;
  const start = target.kind === 'insert' ? target.at : target.start;
  const end = target.kind === 'insert' ? target.at : target.end;
  return { prefix: text.slice(0, start), suffix: text.slice(end) };
}

/** `B2` for one cell, `B2:C5` for a range, in A1 rows (row 0 is `1`). */
export function formatRangeReference(range: NormalizedSelectionRange): string {
  const start = `${columnIndexToLetter(range.startCol)}${range.startRow + 1}`;
  if (range.startRow === range.endRow && range.startCol === range.endCol) return start;
  return `${start}:${columnIndexToLetter(range.endCol)}${range.endRow + 1}`;
}

/** The text after a pick: the session's gap holds the picked reference, caret after it. */
export function applyPointPick(session: PointSession, range: NormalizedSelectionRange): TextEdit {
  const reference = formatRangeReference(range);
  return {
    text: session.prefix + reference + session.suffix,
    caret: session.prefix.length + reference.length,
  };
}

/** Grid outline and formula bar tint colors; the Nth distinct reference gets the Nth color. */
export const REFERENCE_COLORS = [
  '#60a5fa', '#f59e0b', '#34d399', '#a78bfa', '#f472b6', '#2dd4bf', '#f87171', '#facc15',
] as const;

export interface ReferenceHighlight {
  start: number;
  end: number;
  color: string;
  reference: ScannedReference;
}

/** The identity two spellings of one reference share: `$a$1` and `A1` color alike. */
function referenceKey(reference: ScannedReference): string {
  return reference.text.replace(/[$\s]/g, '').toUpperCase();
}

/**
 * Every reference in a formula with its color. Repeats of the same reference
 * share a color, so the bar text and the grid outline always agree.
 */
export function referenceHighlights(text: string): ReferenceHighlight[] {
  if (!text.startsWith('=')) return [];
  const colors = new Map<string, string>();
  const highlights: ReferenceHighlight[] = [];
  for (const token of scanFormulaTokens(text)) {
    const reference = token.reference;
    if (!reference) continue;
    const key = referenceKey(reference);
    let color = colors.get(key);
    if (!color) {
      color = REFERENCE_COLORS[colors.size % REFERENCE_COLORS.length];
      colors.set(key, color);
    }
    highlights.push({ start: reference.start, end: reference.end, color, reference });
  }
  return highlights;
}

/** One outline per distinct reference, in A1 rows; open axes (`A:A`) are left open as null. */
export interface ReferenceOutline {
  color: string;
  startRow: number | null;
  endRow: number | null;
  startCol: number | null;
  endCol: number | null;
}

export function referenceOutlines(text: string): ReferenceOutline[] {
  const seen = new Set<string>();
  const outlines: ReferenceOutline[] = [];
  for (const { reference, color } of referenceHighlights(text)) {
    if (seen.has(color)) continue;
    seen.add(color);
    const rows = [reference.from.row, reference.to.row];
    const cols = [reference.from.col, reference.to.col];
    outlines.push({
      color,
      startRow: rows[0] === null || rows[1] === null ? null : Math.min(rows[0], rows[1]),
      endRow: rows[0] === null || rows[1] === null ? null : Math.max(rows[0], rows[1]),
      startCol: cols[0] === null || cols[1] === null ? null : Math.min(cols[0], cols[1]),
      endCol: cols[0] === null || cols[1] === null ? null : Math.max(cols[0], cols[1]),
    });
  }
  return outlines;
}

/**
 * The name box's typed jump target: `B7`, `b2:c5`, `$A$1`, with or without a
 * leading `=`. Whole-column and whole-row ranges are not supported yet.
 */
export function parseNameBoxReference(
  input: string,
  namedRanges: Readonly<Record<string, string>> = {},
): NormalizedSelectionRange | null {
  const typed = input.trim().replace(/^=/, '');
  // A defined name jumps to its range.
  const text = resolveName(namedRanges, typed) ?? typed;
  if (text === '') return null;
  const tokens = scanFormulaTokens(text);
  if (tokens.length !== 1) return null;
  const reference = tokens[0].reference;
  if (!reference || (reference.kind !== 'cell' && reference.kind !== 'range')) return null;
  const { from, to } = reference;
  if (from.row === null || from.col === null || to.row === null || to.col === null) return null;
  return {
    startRow: Math.min(from.row, to.row),
    endRow: Math.max(from.row, to.row),
    startCol: Math.min(from.col, to.col),
    endCol: Math.max(from.col, to.col),
  };
}
