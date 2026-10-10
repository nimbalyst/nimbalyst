/**
 * Whether a code excerpt still matches the file it quotes. Pure: the host
 * reads the file, this decides what the badge says.
 *
 * - `unchanged`: the range holds exactly the snapshot.
 * - `moved`: the snapshot is intact elsewhere in the file (code above it was
 *   added or removed); `movedTo` is the new range.
 * - `changed`: the snapshot is not in the file; `current` is what the range
 *   holds now.
 * - `missing`: the file is gone.
 */

import { type LineRange, splitLines } from './excerptSource';

export type ExcerptDrift =
  | { state: 'unchanged' }
  | { state: 'moved'; movedTo: LineRange }
  | { state: 'changed'; current: string }
  | { state: 'missing' };

function normalize(lines: string[]): string[] {
  return lines.map((line) => line.replace(/\s+$/, ''));
}

function matchesAt(file: string[], snapshot: string[], index: number): boolean {
  for (let offset = 0; offset < snapshot.length; offset += 1) {
    if (file[index + offset] !== snapshot[offset]) return false;
  }
  return true;
}

export function classifyExcerptDrift(snapshot: string, fileText: string | null, range: LineRange): ExcerptDrift {
  if (fileText === null) return { state: 'missing' };
  // Trailing whitespace is not drift: editors strip it and it does not show.
  const file = normalize(splitLines(fileText));
  const quoted = normalize(splitLines(snapshot));
  const current = file.slice(range.start - 1, range.end);
  const currentText = splitLines(fileText).slice(range.start - 1, range.end).join('\n');
  if (quoted.length === 0 || (quoted.length === 1 && quoted[0] === '')) {
    return { state: 'changed', current: currentText };
  }
  if (current.length === quoted.length && matchesAt(current, quoted, 0)) return { state: 'unchanged' };

  // Nearest intact copy of the snapshot wins when it appears more than once.
  let best: number | null = null;
  for (let index = 0; index + quoted.length <= file.length; index += 1) {
    if (!matchesAt(file, quoted, index)) continue;
    if (best === null || Math.abs(index + 1 - range.start) < Math.abs(best + 1 - range.start)) best = index;
  }
  if (best !== null) return { state: 'moved', movedTo: { start: best + 1, end: best + quoted.length } };
  return { state: 'changed', current: currentText };
}

export interface LineDiffOp {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/** Line diff from `before` to `after` (LCS). Inputs are excerpt-sized. */
export function diffLines(before: string, after: string): LineDiffOp[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: LineDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: 'removed', text: a[i] });
      i += 1;
    } else {
      ops.push({ kind: 'added', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ kind: 'removed', text: a[i++] });
  while (j < b.length) ops.push({ kind: 'added', text: b[j++] });
  return ops;
}
