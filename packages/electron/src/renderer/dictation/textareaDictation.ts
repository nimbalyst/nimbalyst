/**
 * Pure insertion logic for dictating into a plain textarea (the agent input).
 *
 * Partial text is written into the draft so it shows at the cursor, and the
 * range it occupies is tracked so the next partial or the final replaces it in
 * place. The user can keep typing while dictating: when the tracked range no
 * longer holds our text we look for it again, and if it is gone we start fresh
 * at the cursor instead of overwriting what the user typed.
 */

export interface TextareaDictationState {
  /** Where the pending text starts in the value. */
  start: number;
  /** The exact text we inserted for the current partial ('' when none). */
  pending: string;
}

export interface TextareaDictationResult {
  value: string;
  state: TextareaDictationState;
  /** Caret position after the change. */
  cursor: number;
}

export interface TextareaSelection {
  start: number;
  end: number;
}

const WORD_START = /^[\p{L}\p{N}]/u;
const WORD_END = /[\p{L}\p{N}.,!?;:]$/u;
const WHITESPACE = /\s/;

/** Locate the range our pending text occupies, or null if the user removed it. */
function locatePending(value: string, state: TextareaDictationState): number | null {
  if (value.startsWith(state.pending, state.start)) return state.start;
  const idx = value.indexOf(state.pending);
  return idx >= 0 ? idx : null;
}

function resolveRange(
  value: string,
  state: TextareaDictationState | null,
  selection: TextareaSelection,
): TextareaSelection {
  if (state && state.pending) {
    const at = locatePending(value, state);
    if (at !== null) return { start: at, end: at + state.pending.length };
  }
  const start = Math.max(0, Math.min(selection.start, value.length));
  const end = Math.max(start, Math.min(selection.end, value.length));
  return { start, end };
}

function withSpacing(before: string, after: string, text: string, isFinal: boolean): string {
  if (!text) return '';
  const prev = before.slice(-1);
  let out = text;
  if (prev && !WHITESPACE.test(prev) && WORD_START.test(text)) out = ' ' + out;
  const next = after.charAt(0);
  if (isFinal && next && WORD_START.test(next) && WORD_END.test(text)) out = out + ' ';
  return out;
}

/**
 * Apply a partial (replaces the current pending text) or a final (commits
 * text and clears pending). With no pending text, the text lands at
 * `selection`, replacing any selected range.
 */
export function applyDictationText(
  value: string,
  state: TextareaDictationState | null,
  selection: TextareaSelection,
  text: string,
  kind: 'partial' | 'final',
): TextareaDictationResult {
  const range = resolveRange(value, state, selection);
  const before = value.slice(0, range.start);
  const after = value.slice(range.end);
  const insert = withSpacing(before, after, text, kind === 'final');
  const next = before + insert + after;
  const cursor = range.start + insert.length;
  if (kind === 'partial') {
    return { value: next, state: { start: range.start, pending: insert }, cursor };
  }
  return { value: next, state: { start: cursor, pending: '' }, cursor };
}

/** Remove the pending partial (Esc, or the engine ended without a final). */
export function clearDictationPartial(
  value: string,
  state: TextareaDictationState | null,
): TextareaDictationResult | null {
  if (!state || !state.pending) return null;
  const at = locatePending(value, state);
  if (at === null) return null;
  const next = value.slice(0, at) + value.slice(at + state.pending.length);
  return { value: next, state: { start: at, pending: '' }, cursor: at };
}

/** The range the pending partial occupies, for muted rendering. */
export function pendingRange(
  value: string,
  state: TextareaDictationState | null,
): { start: number; end: number } | null {
  if (!state || !state.pending) return null;
  const at = locatePending(value, state);
  if (at === null) return null;
  return { start: at, end: at + state.pending.length };
}
