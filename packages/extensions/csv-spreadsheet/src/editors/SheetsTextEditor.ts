/**
 * Custom text editor that behaves like a real spreadsheet cell.
 *
 * RevoGrid passes `save()` and `close()` callbacks to the editor constructor.
 * Which keystrokes reach either of them -- and which are left to the input so the
 * caret can move -- is decided by `resolveEditorKeyAction`; see the header of
 * editorKeyActions.ts for why the grid used to navigate on every arrow press.
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
  editInput: HTMLInputElement | null = null;
  element: Element | null = null;
  editCell?: EditCell = undefined;

  /**
   * Set by Escape. The grid runs with `applyOnClose`, so `revogr-edit` saves
   * whatever `getValue()` returns when it unmounts unless `beforeAutoSave` vetoes
   * it -- without this flag, Escape committed the edit it was supposed to abandon.
   */
  private cancelled = false;

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
      this.editInput?.focus();
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
        this.cancelled = true;
        this.close(false);
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

  /** Blur first: the built-in editor does the same to avoid a scroll jump. */
  private commit(preventFocus: boolean): void {
    this.editInput?.blur();
    this.save(this.getValue(), preventFocus);
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
    return !this.cancelled;
  }

  /**
   * Get value from input - RevoGrid calls this when editor closes
   */
  getValue() {
    return this.editInput?.value ?? '';
  }

  /**
   * Render the editor input
   */
  render(createElement: HyperFunc<VNode>): VNode | VNode[] {
    return createElement('input', {
      type: 'text',
      enterKeyHint: 'enter',
      value: this.editCell?.val ?? '',
      ref: (el: HTMLInputElement | null) => {
        this.editInput = el;
      },
      onKeyDown: this.handleKeyDown,
    });
  }
}
