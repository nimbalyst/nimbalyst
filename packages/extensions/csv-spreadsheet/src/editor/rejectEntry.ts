/**
 * The reject-mode validation gate for typed values. Every path that commits
 * what the user typed (the cell editor, the formula bar, a commit that landed
 * before the editor mounted) asks here first.
 */

import { rejectedEntry } from '../validation/entry';
import type { EditorCore } from './editorCore';

/** True (and the rule's message shown at the cell) when a reject-mode rule refuses a typed value. */
export function rejectEntry(core: EditorCore, writes: { row: number; col: number; value: string }[]): boolean {
  const rejection = rejectedEntry(core.spreadsheetMetaRef.current.getMetadata().validation, writes);
  if (rejection) core.reportRejectionRef.current?.(rejection);
  return rejection !== null;
}
