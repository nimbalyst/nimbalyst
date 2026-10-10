/**
 * Pure editing assistance for formula text: function autocomplete, signature
 * help and F4 absolute-reference cycling.
 *
 * Every function takes the full cell text (including the leading `=`) and a
 * caret offset into it, and works on the tolerant `scanFormulaTokens` output,
 * so half-typed formulas (`=SUM(A1, IF(`) are fine. Nothing here touches the
 * DOM; the popover and editors own focus and key handling.
 */

import {
  FUNCTION_CATALOG,
  getFunctionEntry,
  paramIndexForArgument,
  type FunctionCatalogEntry,
} from './functionCatalog';
import {
  formatReference,
  referenceAtCaret,
  scanFormulaTokens,
  type ReferenceEndpoint,
  type ScannedReference,
} from './referenceScanner';

/** Shown ahead of the alphabetical rest when they match the typed prefix. */
const COMMON_FUNCTIONS = [
  'SUM', 'AVERAGE', 'COUNT', 'COUNTA', 'IF', 'VLOOKUP', 'XLOOKUP', 'INDEX', 'MATCH',
  'SUMIF', 'COUNTIF', 'ROUND', 'MIN', 'MAX', 'TODAY', 'CONCATENATE', 'TEXT', 'LEFT',
  'RIGHT', 'LEN', 'IFERROR',
];
const COMMON_RANK = new Map(COMMON_FUNCTIONS.map((name, index) => [name, index]));

export const DEFAULT_AUTOCOMPLETE_LIMIT = 8;

export interface FormulaAutocomplete {
  /** The typed part of the name, from the token start to the caret. */
  prefix: string;
  /** The span an accepted candidate replaces: the whole name token. */
  replaceStart: number;
  replaceEnd: number;
  candidates: FunctionCatalogEntry[];
}

export interface SignatureHelp {
  entry: FunctionCatalogEntry;
  /** Offset of the function name in the text. */
  nameStart: number;
  /** Zero-based argument the caret is in. */
  argIndex: number;
  /** Index into `entry.params`, or -1 when the call has more arguments than the function takes. */
  paramIndex: number;
}

export interface TextEdit {
  text: string;
  caret: number;
}

/** Function names starting with `prefix`, ranked common-first then alphabetically. */
export function getAutocompleteCandidates(
  prefix: string,
  limit = DEFAULT_AUTOCOMPLETE_LIMIT,
): FunctionCatalogEntry[] {
  const upper = prefix.toUpperCase();
  if (upper === '') return [];
  const matches = [...FUNCTION_CATALOG.values()].filter((entry) => entry.name.startsWith(upper));
  const rank = (entry: FunctionCatalogEntry): number => {
    if (entry.name === upper) return -1;
    return COMMON_RANK.get(entry.name) ?? COMMON_FUNCTIONS.length;
  };
  matches.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return matches.slice(0, limit);
}

/** Named ranges starting with `prefix`, as autocomplete entries (no parentheses on accept). */
function namedRangeCandidates(prefix: string, names: Readonly<Record<string, string>>): FunctionCatalogEntry[] {
  const upper = prefix.toUpperCase();
  return Object.entries(names)
    .filter(([name]) => name.toUpperCase().startsWith(upper))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, range]) => ({ name, category: 'named range', params: [], signature: range, description: `Named range: ${range}` }));
}

export function isNamedRangeEntry(entry: FunctionCatalogEntry): boolean {
  return entry.category === 'named range';
}

/**
 * Autocomplete for the name token the caret is in -- named ranges first, then
 * functions -- or null when the caret is not in one (inside a string, on a `$`
 * reference, outside a formula) or nothing matches.
 */
export function getFormulaAutocomplete(
  text: string,
  caret: number,
  limit = DEFAULT_AUTOCOMPLETE_LIMIT,
  namedRanges: Readonly<Record<string, string>> = {},
): FormulaAutocomplete | null {
  if (!text.startsWith('=')) return null;
  const token = scanFormulaTokens(text).find((candidate) => candidate.start < caret && caret <= candidate.end);
  if (!token) return null;
  const isNameLike = token.kind === 'function'
    || token.kind === 'name'
    // `LOG1` scans as a cell reference while the user is still typing `LOG10`.
    || (token.kind === 'reference' && token.reference?.kind === 'cell' && !token.text.includes('$'));
  if (!isNameLike) return null;

  const prefix = text.slice(token.start, caret);
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(prefix)) return null;
  const candidates = [...namedRangeCandidates(prefix, namedRanges), ...getAutocompleteCandidates(prefix, limit)].slice(0, limit);
  if (candidates.length === 0) return null;
  return { prefix, replaceStart: token.start, replaceEnd: token.end, candidates };
}

/**
 * Replace the name token with the accepted function and an opening paren, and
 * put the caret inside it. An existing `(` after the name is reused. A named
 * range (`call: false`) goes in as is, caret after it.
 */
export function applyAutocomplete(
  text: string,
  completion: Pick<FormulaAutocomplete, 'replaceStart' | 'replaceEnd'>,
  functionName: string,
  call = true,
): TextEdit {
  const after = text.slice(completion.replaceEnd);
  if (!call) {
    const head = `${text.slice(0, completion.replaceStart)}${functionName}`;
    return { text: head + after, caret: head.length };
  }
  const existingParen = /^\s*\(/.exec(after);
  const head = `${text.slice(0, completion.replaceStart)}${functionName}`;
  if (existingParen) {
    return { text: head + after, caret: head.length + existingParen[0].length };
  }
  return { text: `${head}(${after}`, caret: head.length + 1 };
}

/**
 * The innermost function call around the caret and which argument the caret is
 * in. Commas inside strings and nested calls do not count. A bare grouping
 * paren (`=SUM((A1+|`) defers to the call outside it. Null when the caret is
 * not inside a known function's parentheses.
 */
export function getSignatureHelp(text: string, caret: number): SignatureHelp | null {
  if (!text.startsWith('=')) return null;
  const stack: Array<{ name: string | null; nameStart: number; argIndex: number }> = [];
  let previous: { kind: string; text: string; start: number } | null = null;

  for (const token of scanFormulaTokens(text)) {
    if (token.start >= caret) break;
    if (token.kind === 'leftParen') {
      const isCall = previous?.kind === 'function';
      stack.push({
        name: isCall ? previous!.text.toUpperCase() : null,
        nameStart: isCall ? previous!.start : token.start,
        argIndex: 0,
      });
    } else if (token.kind === 'rightParen') {
      stack.pop();
    } else if (token.kind === 'comma' && stack.length > 0) {
      stack[stack.length - 1].argIndex += 1;
    }
    if (token.kind !== 'whitespace') previous = token;
  }

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const frame = stack[index];
    if (frame.name === null) continue;
    const entry = getFunctionEntry(frame.name);
    if (!entry) return null;
    return {
      entry,
      nameStart: frame.nameStart,
      argIndex: frame.argIndex,
      paramIndex: paramIndexForArgument(entry, frame.argIndex),
    };
  }
  return null;
}

type AbsoluteState = [colAbsolute: boolean, rowAbsolute: boolean];

/** A1 -> $A$1 -> A$1 -> $A1 -> A1. */
function nextCellState([colAbsolute, rowAbsolute]: AbsoluteState): AbsoluteState {
  if (!colAbsolute && !rowAbsolute) return [true, true];
  if (colAbsolute && rowAbsolute) return [false, true];
  if (!colAbsolute && rowAbsolute) return [true, false];
  return [false, false];
}

function withState(endpoint: ReferenceEndpoint, [colAbsolute, rowAbsolute]: AbsoluteState): ReferenceEndpoint {
  return {
    ...endpoint,
    colAbsolute: endpoint.col === null ? false : colAbsolute,
    rowAbsolute: endpoint.row === null ? false : rowAbsolute,
  };
}

function cycledReference(reference: ScannedReference): string {
  const { from } = reference;
  let next: AbsoluteState;
  if (reference.kind === 'column-range') next = [!from.colAbsolute, false];
  else if (reference.kind === 'row-range') next = [false, !from.rowAbsolute];
  else next = nextCellState([from.colAbsolute, from.rowAbsolute]);
  // A range takes its next state from its first endpoint, so `A1:$B$2` lines up as `$A$1:$B$2`.
  return formatReference({
    kind: reference.kind,
    from: withState(reference.from, next),
    to: withState(reference.to, next),
  });
}

/**
 * F4: cycle the reference at or touching the caret through its absolute forms
 * and leave the caret after it. Null when the caret is not on a reference.
 */
export function cycleReferenceAbsolute(text: string, caret: number): TextEdit | null {
  if (!text.startsWith('=')) return null;
  const reference = referenceAtCaret(text, caret);
  if (!reference) return null;
  const replacement = cycledReference(reference);
  return {
    text: text.slice(0, reference.start) + replacement + text.slice(reference.end),
    caret: reference.start + replacement.length,
  };
}
