/**
 * What a keystroke should do while a cell editor is open.
 *
 * RevoGrid binds its key handling to a document-level `keydown` listener
 * (Stencil listener metadata `[4,"keydown","onKeyDown"]` -- document target,
 * bubble phase), and while a cell is in edit mode its `KeyboardService` acts on
 * Escape and Tab only. Arrow keys navigating away mid-edit was therefore not
 * RevoGrid overreaching: the editor committed the value *first*, which closed
 * edit mode, so by the time the same keystroke reached the document the grid saw
 * an ordinary out-of-edit arrow press and moved the selection.
 *
 * The fix is to decide, per key, whether the input owns it or the grid does. The
 * decision lives here rather than in the handler so it can be read -- and
 * tested -- as a table instead of as a pile of DOM side effects.
 */

export type EditorKeyAction =
  /** The input owns it: caret movement, text selection, IME. Keep the grid out. */
  | 'caret'
  /** Commit, then move the selection one cell in the named direction. */
  | 'commitDown'
  | 'commitUp'
  | 'commitRight'
  | 'commitLeft'
  /** Abandon the edit and restore the cell's previous value. */
  | 'cancel'
  /** Not ours -- ordinary typing, shortcuts, anything the grid may want. */
  | 'passthrough';

export interface EditorKeyEvent {
  readonly key: string;
  readonly shiftKey?: boolean;
  /**
   * Mid-IME-composition, every key belongs to the composition. Enter commits the
   * candidate, not the cell, so the grid must not see it.
   */
  readonly isComposing?: boolean;
}

/**
 * Keys whose default action is to move the caret inside the input. `Home`/`End`
 * are here for the same reason as the arrows: RevoGrid treats them as selection
 * movement once edit mode has closed.
 */
const CARET_KEYS: ReadonlySet<string> = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
]);

export function resolveEditorKeyAction(event: EditorKeyEvent): EditorKeyAction {
  if (event.isComposing) return 'caret';
  if (CARET_KEYS.has(event.key)) return 'caret';
  if (event.key === 'Escape') return 'cancel';
  if (event.key === 'Enter') return event.shiftKey ? 'commitUp' : 'commitDown';
  if (event.key === 'Tab') return event.shiftKey ? 'commitLeft' : 'commitRight';
  return 'passthrough';
}

/**
 * Whether a keystroke typed into one of the editor's *own* text inputs -- the
 * formula bar, the find bar -- has to be kept away from the grid.
 *
 * The same document-level listener that made arrows navigate mid-edit also never
 * checks where the event came from, so while a cell is focused RevoGrid reads
 * typing anywhere in the app as grid input: a letter opens the cell editor
 * (`change(e.key)`), Backspace and Delete wipe the selected range
 * (`clearCell()`), and the arrows move the selection out from under whatever the
 * user is actually editing.
 *
 * Modified keystrokes are deliberately let through, so app-level accelerators
 * (Cmd+S, Cmd+F) still reach the host while a text field has focus.
 */
export function shouldIsolateFromGrid(event: {
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
}): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey;
}
