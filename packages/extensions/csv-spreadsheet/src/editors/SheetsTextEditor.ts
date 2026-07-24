/**
 * Custom text editor that behaves like Google Sheets.
 *
 * RevoGrid passes save() and close() callbacks to the editor constructor.
 * We call save() on Enter/Tab/Arrow keys, and close() on Escape.
 */

import type { EditCell, EditorBase, ColumnDataSchemaModel, VNode, HyperFunc } from '@revolist/revogrid';

export class SheetsTextEditor implements EditorBase {
  editInput: HTMLInputElement | null = null;
  element: Element | null = null;
  editCell?: EditCell = undefined;

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

  /**
   * Handle key events
   *
   * For navigation keys (Tab, Enter, Arrows), we save the value and let
   * the event bubble up to RevoGrid which handles the navigation.
   */
  private handleKeyDown = (e: KeyboardEvent) => {
    const key = e.key;

    // Enter - save and let RevoGrid move down
    if (key === 'Enter') {
      this.save(this.getValue(), false);
      // Don't stop propagation - let RevoGrid handle navigation
      return;
    }

    // Tab - save but prevent default focus change, let RevoGrid handle navigation
    if (key === 'Tab') {
      this.save(this.getValue(), true);
      return;
    }

    // Escape - close without saving
    if (key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close(false);
      return;
    }

    // Arrow keys - save and let RevoGrid handle navigation
    if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
      this.save(this.getValue(), false);
      // Don't stop propagation - let RevoGrid handle navigation
      return;
    }
  };

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
