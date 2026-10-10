/**
 * Custom text editor that behaves like a real spreadsheet cell.
 *
 * RevoGrid passes `save()` and `close()` callbacks to the editor constructor.
 * In the editor the grid key controller (`keyboard/`) sits in front of this and
 * drives `commit` / `cancel` / `insertText` for Enter, Tab, Escape, arrows in
 * enter mode and Alt+Enter. The `resolveEditorKeyAction` table below only sees
 * the keys the controller leaves alone, and still keeps caret keys away from
 * RevoGrid's document listener; see editorKeyActions.ts.
 *
 * The input is a textarea so a cell can hold line breaks (Alt/Option+Enter).
 */

import type { EditCell, EditorBase, ColumnDataSchemaModel, VNode, HyperFunc } from '@revolist/revogrid';
import { resolveEditorKeyAction } from './editorKeyActions';

/** The sliver of the grid element this editor needs to move focus itself. */
interface FocusableGrid extends Element {
  setCellsFocus?: (
    cellStart: { x: number; y: number },
    cellEnd: { x: number; y: number },
    colType: string,
    rowType: string
  ) => Promise<void>;
}

export class SheetsTextEditor implements EditorBase {
  editInput: HTMLTextAreaElement | null = null;
  element: Element | null = null;
  editCell?: EditCell = undefined;

  /**
   * Set by Escape. The grid runs with `applyOnClose`, so `revogr-edit` saves
   * whatever `getValue()` returns when it unmounts unless `beforeAutoSave` vetoes
   * it -- without this flag, Escape committed the edit it was supposed to abandon.
   */
  private cancelled = false;

  /**
   * The keyboard edit session this editor was opened for (see `editSessionRef`
   * in editorCore), or null when the host does not track sessions. An editor
   * RevoGrid builds after its edit was already committed belongs to an older
   * session and must not receive the keys of the current one.
   */
  editSession: number | null = null;

  /** Replaces the cell's value when the editor was opened by typing. */
  initialText: string | null = null;

  /** Set by an explicit commit, so the close that follows does not save again. */
  private committed = false;

  constructor(
    public data: ColumnDataSchemaModel,
    private save: (value: any, preventFocus?: boolean) => void,
    private close: (focusNext?: boolean) => void,
  ) {}

  /**
   * Callback triggered on cell editor render
   */
  async componentDidRender(): Promise<void> {
    if (this.editInput) {
      // Small delay to ensure DOM is ready
      await new Promise(resolve => setTimeout(resolve, 0));
      const input = this.editInput;
      input?.focus();
      // Caret at the end, as Sheets does for both typing and F2.
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    const action = resolveEditorKeyAction(e);
    if (action === 'passthrough') return;

    switch (action) {
      case 'caret':
        // The caret move *is* the default action, so only the grid is blocked.
        // Its keydown listener sits on `document` in the bubble phase, so
        // stopping propagation here is enough to keep it from navigating.
        e.stopPropagation();
        return;

      case 'cancel':
        e.preventDefault();
        e.stopPropagation();
        this.cancel();
        return;

      case 'commitDown':
        // `preventFocus: false` lets RevoGrid's own `focusNext()` move down.
        // Propagation still has to stop: by the time the event reached the
        // document the edit would be closed, and the grid answers a plain Enter
        // by reopening the editor on the newly focused cell.
        e.preventDefault();
        e.stopPropagation();
        this.commit(false);
        return;

      case 'commitUp':
        e.preventDefault();
        e.stopPropagation();
        this.commit(true);
        this.moveFocusByRow(-1);
        return;

      case 'commitLeft':
      case 'commitRight':
        // Tab is the one key RevoGrid handles correctly from inside edit mode
        // (`KeyboardService.keyDown` -> `keyChangeSelection`, which reads
        // `shiftKey` for the direction), so it commits here and navigates there.
        this.commit(true);
        return;
    }
  };

  /**
   * Save the value. Blur first: the built-in editor does the same to avoid a
   * scroll jump. `preventFocus` keeps RevoGrid from moving the selection, for
   * callers that move it themselves.
   */
  commit(preventFocus = true): void {
    this.editInput?.blur();
    this.save(this.getValue(), preventFocus);
    // RevoGrid leaves the editor open on a `preventFocus` save; close it
    // without moving focus, or the grid stays in edit mode and ignores typing.
    if (preventFocus) {
      this.committed = true;
      this.close(false);
    }
  }

  /** Close without saving. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.close(false);
  }

  /** Insert text at the caret (Alt+Enter's line break, Cmd+; date). */
  insertText(text: string): void {
    const input = this.editInput;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.setRangeText(text, start, end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * Move the selection vertically after a commit that suppressed RevoGrid's own
   * focus move. Only used by Shift+Enter, the one direction the grid has no
   * built-in for -- `focusNext()` always goes down.
   *
   * Indices here are section-local, which is what `setCellsFocus` expects. A
   * move that would leave the section is dropped rather than guessed at, so
   * Shift+Enter on the top body row simply stays put instead of jumping into a
   * frozen header row.
   */
  private moveFocusByRow(delta: number): void {
    const { rowIndex, colIndex, colType, type } = this.data;
    const targetRow = rowIndex + delta;
    if (targetRow < 0) return;

    const grid = this.editInput?.closest('revo-grid') as FocusableGrid | null;
    if (!grid?.setCellsFocus) return;

    // Let the commit close the editor first; focusing into a cell that is still
    // in edit mode is ignored.
    setTimeout(() => {
      void grid.setCellsFocus?.(
        { x: colIndex, y: targetRow },
        { x: colIndex, y: targetRow },
        colType,
        type
      );
    }, 0);
  }

  /**
   * Veto `revogr-edit`'s save-on-close for a cancelled edit. Any other close
   * (clicking another cell, scrolling away) still commits, which is what
   * `applyOnClose` is for.
   */
  beforeAutoSave(): boolean {
    return !this.cancelled && !this.committed;
  }

  /**
   * Get value from input - RevoGrid calls this when editor closes.
   *
   * A fast typed run can commit an editor that is built but not rendered yet;
   * the typed text already moved from the key controller into `initialText`,
   * so it is the value then, not ''.
   */
  getValue() {
    return this.editInput?.value ?? this.startingValue();
  }

  /** What the textarea starts with: the typed text, or the cell's value. */
  private startingValue(): string {
    const existing = this.editCell?.val ?? (this.data?.model as Record<string, unknown> | undefined)?.[String(this.data?.prop)];
    return this.initialText ?? String(existing ?? '');
  }

  /**
   * Render the editor input
   */
  render(createElement: HyperFunc<VNode>): VNode | VNode[] {
    // The live text once mounted: Stencil re-applies `value` on every render
    // whenever it differs from the DOM, so rendering the starting value again
    // would wipe out what was typed or pointed in since (point mode writes the
    // DOM directly).
    const value = this.editInput?.value ?? this.startingValue();
    return createElement('textarea', {
      class: 'csv-cell-editor',
      enterKeyHint: 'enter',
      rows: Math.max(1, value.split('\n').length),
      spellcheck: false,
      value,
      ref: (el: HTMLTextAreaElement | null) => {
        this.editInput = el;
      },
      onKeyDown: this.handleKeyDown,
    });
  }
}
