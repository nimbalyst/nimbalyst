/**
 * Bootstrap seeding for the CSV collaborative Y.Doc.
 *
 * Shape: a single `Y.Text` named `csv` carrying the canonical CSV text.
 * Cell-grained CRDT was considered and rejected for v1 -- CSV rows have no
 * stable identity (no per-row id in the file format), and the user-visible
 * benefits over text-CRDT (per-cell awareness, finer conflict resolution)
 * don't justify the binding complexity. The same trade-off applies to
 * `y-monaco` and `y-codemirror`, both of which sync source through Y.Text.
 *
 * Determinism: the seed writes the file content verbatim into Y.Text. Two
 * clients racing call `seed()` and write identical content; Y.Text's char-
 * level CRDT merges identical inserts as a no-op (no duplication).
 */

import * as Y from 'yjs';

export const Y_CSV_TEXT = 'csv';

export function getYCsv(yDoc: Y.Doc): Y.Text {
  return yDoc.getText(Y_CSV_TEXT);
}

export function isCsvYDocEmpty(yDoc: Y.Doc): boolean {
  return getYCsv(yDoc).length === 0;
}

export function seedCsvYDoc(yDoc: Y.Doc, content: string | ArrayBuffer): void {
  const text = typeof content === 'string' ? content : decodeBuffer(content);
  if (!text) return;
  const yText = getYCsv(yDoc);
  // Guard: if a concurrent client already seeded during our await gap, the
  // SDK hook's outer `isEmpty` re-check is supposed to bail. Belt-and-
  // suspenders here so we never double-insert.
  if (yText.length > 0) return;
  yText.insert(0, text);
}

function decodeBuffer(buf: ArrayBuffer): string {
  try {
    return new TextDecoder().decode(buf);
  } catch {
    return '';
  }
}
