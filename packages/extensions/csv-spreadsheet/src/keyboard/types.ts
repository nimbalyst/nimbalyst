/**
 * Types for the pure grid keyboard controller.
 *
 * Coordinates are logical grid coordinates: row 0 is the first row the grid
 * shows, header rows included. The controller never touches the DOM or the
 * grid; it maps a keystroke plus the current state to the next state and a
 * list of effects for the host to carry out.
 */

export interface CellCoord {
  readonly row: number;
  readonly col: number;
}

/** Inclusive, normalized (start <= end) rectangle. */
export interface CellRange {
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
}

/**
 * - `none`: navigating, no cell editor open.
 * - `enter`: editor opened by typing. Arrow keys commit and move, like Sheets.
 * - `edit`: editor opened by F2 / double-click. Arrow keys move the caret.
 */
export type EditMode = 'none' | 'enter' | 'edit';

export interface GridKeyState {
  /** The cell that receives typing; always inside the selection. */
  readonly active: CellCoord;
  /** The fixed corner of the selection rectangle. */
  readonly anchor: CellCoord;
  /** The moving corner of the selection rectangle (Shift+arrow moves this). */
  readonly focus: CellCoord;
  readonly mode: EditMode;
  /**
   * Column where a run of Tab commits started. Enter returns there, so typing
   * a row with Tab then pressing Enter lands at the start of the next row.
   */
  readonly tabRunStartCol: number | null;
}

export interface GridKeyEvent {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  /** Mid-IME composition every key belongs to the composition. */
  readonly isComposing?: boolean;
}

export interface GridView {
  readonly rowCount: number;
  readonly colCount: number;
  /** Rows pinned at the top (frozen panes). */
  readonly frozenRowCount?: number;
  readonly frozenColCount?: number;
  /** Header rows are pinned too; paging treats them like frozen rows. */
  readonly headerRowCount?: number;
  /** Number of scrollable rows visible in one page. */
  readonly pageRows: number;
  /** True when the cell has no content. Drives Ctrl/Cmd+arrow data-edge jumps. */
  isEmpty(row: number, col: number): boolean;
  /** True for a column the user hid; plain arrows and Tab step over it. */
  isColHidden?(col: number): boolean;
  /** Bottom-right cell of the used range, for Ctrl/Cmd+End. Defaults to the last grid cell. */
  lastDataCell?(): CellCoord;
}

export interface KeyboardPlatform {
  /** On Mac the primary modifier is Cmd (metaKey); elsewhere it is Ctrl. */
  readonly isMac: boolean;
}

export type GridKeyEffect =
  /** Open the cell editor. `initialText` replaces the content (typing); absent keeps it (F2). */
  | { readonly type: 'beginEdit'; readonly mode: 'enter' | 'edit'; readonly initialText?: string }
  | { readonly type: 'commitEdit' }
  | { readonly type: 'cancelEdit' }
  /** Write the editor's value into every cell of `range`, then close the editor. */
  | { readonly type: 'fillSelection'; readonly range: CellRange }
  /** Insert a line break at the caret of the open editor. */
  | { readonly type: 'insertNewline' }
  | { readonly type: 'clearRange'; readonly range: CellRange }
  /** Copy the top row of `range` down through the rest of it (Ctrl+D). */
  | { readonly type: 'fillDown'; readonly range: CellRange }
  /** Copy the left column of `range` right through the rest of it (Ctrl+R). */
  | { readonly type: 'fillRight'; readonly range: CellRange }
  | { readonly type: 'scrollIntoView'; readonly cell: CellCoord };

export interface GridKeyResult {
  readonly state: GridKeyState;
  readonly effects: readonly GridKeyEffect[];
  /**
   * False when the controller does not own the key (caret keys in edit mode,
   * clipboard shortcuts, unknown accelerators). The host must then leave the
   * event alone; when true it should `preventDefault` and stop propagation.
   */
  readonly handled: boolean;
}
