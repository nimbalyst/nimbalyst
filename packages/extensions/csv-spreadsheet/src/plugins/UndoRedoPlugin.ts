/**
 * RevoGrid plugin for undo/redo functionality
 *
 * This plugin tracks cell changes via RevoGrid events and provides
 * undo/redo capabilities by reverting changes through setDataAt().
 */

import { BasePlugin } from '@revolist/revogrid';
import type { PluginProviders, DimensionRows, BeforeSaveDataDetails, AfterEditEvent, BeforeRangeSaveDataDetails } from '@revolist/revogrid';

interface CellChange {
  rowIndex: number;
  colIndex: number;
  prop: string;
  oldValue: unknown;
  newValue: unknown;
  rowType: DimensionRows;
}

export interface SelectionState {
  // Focus cell (in grid coordinates)
  focus: { x: number; y: number } | null;
  // Selection range end (in grid coordinates)
  end: { x: number; y: number } | null;
  // Row type for the selection
  rowType: DimensionRows;
}

interface UndoEntry {
  changes: CellChange[];
  timestamp: number;
  // Selection state before the change (to restore on undo)
  selectionBefore: SelectionState | null;
  // Selection state after the change (to restore on redo)
  selectionAfter: SelectionState | null;
}

// Maximum undo stack size to prevent memory issues
const MAX_UNDO_STACK_SIZE = 100;

// Batch timeout in milliseconds - rapid edits within this window are batched together
const BATCH_TIMEOUT_MS = 50;

/**
 * UndoRedoPlugin tracks cell changes and provides undo/redo functionality.
 *
 * Usage:
 * ```typescript
 * const plugin = new UndoRedoPlugin(gridElement, gridElement.providers);
 * // Later:
 * plugin.undo();
 * plugin.redo();
 * // Cleanup:
 * plugin.destroy();
 * ```
 */
export class UndoRedoPlugin extends BasePlugin {
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private pendingChanges: CellChange[] = [];
  private batchTimeoutId: ReturnType<typeof setTimeout> | null = null;

  // Track the value before edit starts
  private pendingOldValue: { rowIndex: number; colIndex: number; prop: string; value: unknown; rowType: DimensionRows } | null = null;

  // Track selection state before changes
  private selectionBeforeChange: SelectionState | null = null;

  // Flag to prevent recording changes caused by undo/redo itself
  private isUndoRedoOperation = false;

  // Callback for state change notifications (canUndo/canRedo changed)
  private onStateChange?: () => void;

  // Callback to restore selection after undo/redo
  private onRestoreSelection?: (selection: SelectionState) => void;

  constructor(
    revogrid: HTMLRevoGridElement,
    providers: PluginProviders,
    options?: {
      onStateChange?: () => void;
      onRestoreSelection?: (selection: SelectionState) => void;
    }
  ) {
    super(revogrid, providers);

    this.onStateChange = options?.onStateChange;
    this.onRestoreSelection = options?.onRestoreSelection;

    // Listen for cell edit events
    this.addEventListener('beforeedit', this.handleBeforeEdit.bind(this));
    this.addEventListener('afteredit', this.handleAfterEdit.bind(this));

    // Listen for range edits (paste operations)
    this.addEventListener('beforerangeedit', this.handleBeforeRangeEdit.bind(this));

    // Listen for clear operations
    this.addEventListener('clearregion', this.handleClearRegion.bind(this));
  }

  /**
   * Capture the current selection state from the grid
   */
  private captureSelectionState(): SelectionState | null {
    try {
      const selection = this.providers?.selection;
      if (!selection) return null;

      const focus = selection.focused;
      const range = selection.selectedRange;

      if (!focus) return null;

      return {
        focus: { x: focus.x, y: focus.y },
        end: range ? { x: range.x1, y: range.y1 } : { x: focus.x, y: focus.y },
        rowType: 'rgRow', // Default, may need adjustment for pinned rows
      };
    } catch {
      return null;
    }
  }

  /**
   * Capture the old value before edit starts
   */
  private handleBeforeEdit(e: CustomEvent<BeforeSaveDataDetails>): void {
    if (this.isUndoRedoOperation || !e.detail) return;

    const detail = e.detail;
    const rowIndex = detail.rowIndex ?? 0;
    const colIndex = detail.colIndex ?? 0;
    const prop = String(detail.prop ?? '');
    const model = detail.model;
    const type = detail.type;

    // Capture selection state before the edit
    if (this.selectionBeforeChange === null) {
      this.selectionBeforeChange = this.captureSelectionState();
    }

    // Capture the current value before edit
    const oldValue = model?.[prop];
    const rowType: DimensionRows = (type as DimensionRows) || 'rgRow';

    this.pendingOldValue = {
      rowIndex,
      colIndex,
      prop,
      value: oldValue,
      rowType,
    };
  }

  /**
   * After edit completes, record the change with old and new values
   */
  private handleAfterEdit(e: CustomEvent<AfterEditEvent>): void {
    if (this.isUndoRedoOperation || !e.detail) return;

    // AfterEditEvent can be BeforeSaveDataDetails or BeforeRangeSaveDataDetails
    const detail = e.detail as BeforeSaveDataDetails;
    const rowIndex = detail.rowIndex ?? 0;
    const colIndex = detail.colIndex ?? 0;
    const prop = String(detail.prop ?? '');
    const val = detail.val;
    const type = detail.type;
    const rowType: DimensionRows = (type as DimensionRows) || 'rgRow';

    // Get the old value from our pending capture
    let oldValue: unknown = '';
    if (
      this.pendingOldValue &&
      this.pendingOldValue.rowIndex === rowIndex &&
      this.pendingOldValue.colIndex === colIndex &&
      this.pendingOldValue.prop === prop
    ) {
      oldValue = this.pendingOldValue.value;
    }
    this.pendingOldValue = null;

    // Don't record if value didn't actually change
    if (oldValue === val) return;

    this.recordChange({
      rowIndex,
      colIndex,
      prop,
      oldValue,
      newValue: val,
      rowType,
    });
  }

  /**
   * Handle range edits (paste operations)
   * RevoGrid fires this before applying pasted data
   */
  private handleBeforeRangeEdit(e: CustomEvent<BeforeRangeSaveDataDetails>): void {
    if (this.isUndoRedoOperation || !e.detail) return;

    // Range edits contain multiple cell changes
    // We'll capture these in the afteredit events that follow
    // For now, just ensure we commit any pending batch before the range edit
    this.commitBatch();
  }

  /**
   * Handle clear region events (delete key, cut operations)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleClearRegion(e: CustomEvent<any>): void {
    if (this.isUndoRedoOperation || !e.detail) return;

    // The data contains the old values before clearing
    // We need to record these for undo
    const { data, range, type } = e.detail;
    const rowType: DimensionRows = (type as DimensionRows) || 'rgRow';

    // Capture selection before the clear
    const selectionBefore = this.captureSelectionState();

    // Commit any pending changes first
    this.commitBatch();

    const changes: CellChange[] = [];

    // Record each cell in the cleared range
    for (let rowOffset = 0; rowOffset <= range.y1 - range.y; rowOffset++) {
      const rowData = data[rowOffset];
      if (!rowData) continue;

      for (let colOffset = 0; colOffset <= range.x1 - range.x; colOffset++) {
        // Column props are A, B, C, etc.
        const colIndex = range.x + colOffset;
        const prop = String.fromCharCode(65 + colIndex); // A = 65

        const oldValue = rowData[prop];
        if (oldValue !== '' && oldValue !== undefined) {
          changes.push({
            rowIndex: range.y + rowOffset,
            colIndex,
            prop,
            oldValue,
            newValue: '',
            rowType,
          });
        }
      }
    }

    if (changes.length > 0) {
      this.undoStack.push({
        changes,
        timestamp: Date.now(),
        selectionBefore,
        selectionAfter: selectionBefore, // Selection stays the same after clear
      });
      this.redoStack = [];
      this.trimUndoStack();
      this.notifyStateChange();
    }
  }

  /**
   * Record a single cell change, batching rapid changes together
   */
  private recordChange(change: CellChange): void {
    this.pendingChanges.push(change);

    // Clear existing timeout
    if (this.batchTimeoutId !== null) {
      clearTimeout(this.batchTimeoutId);
    }

    // Set new timeout to commit batch
    this.batchTimeoutId = setTimeout(() => {
      this.commitBatch();
    }, BATCH_TIMEOUT_MS);
  }

  /**
   * Commit pending changes as a single undo entry
   */
  private commitBatch(): void {
    if (this.batchTimeoutId !== null) {
      clearTimeout(this.batchTimeoutId);
      this.batchTimeoutId = null;
    }

    if (this.pendingChanges.length === 0) {
      this.selectionBeforeChange = null;
      return;
    }

    // Capture current selection as the "after" state
    const selectionAfter = this.captureSelectionState();

    this.undoStack.push({
      changes: [...this.pendingChanges],
      timestamp: Date.now(),
      selectionBefore: this.selectionBeforeChange,
      selectionAfter,
    });
    this.redoStack = []; // Clear redo stack on new changes
    this.pendingChanges = [];
    this.selectionBeforeChange = null;

    this.trimUndoStack();
    this.notifyStateChange();
  }

  /**
   * Trim undo stack to max size
   */
  private trimUndoStack(): void {
    while (this.undoStack.length > MAX_UNDO_STACK_SIZE) {
      this.undoStack.shift();
    }
  }

  /**
   * Notify listeners that undo/redo state changed
   */
  private notifyStateChange(): void {
    this.onStateChange?.();
  }

  /**
   * Undo the last change
   * @returns true if undo was performed, false if nothing to undo
   */
  public undo(): boolean {
    // Commit any pending changes first
    this.commitBatch();

    const entry = this.undoStack.pop();
    if (!entry) return false;

    this.isUndoRedoOperation = true;

    try {
      // Revert changes in reverse order
      for (const change of [...entry.changes].reverse()) {
        this.revogrid.setDataAt({
          row: change.rowIndex,
          col: change.colIndex,
          val: change.oldValue,
          rowType: change.rowType,
          colType: 'rgCol',
        });
      }

      // Restore selection to before state
      if (entry.selectionBefore && this.onRestoreSelection) {
        this.onRestoreSelection(entry.selectionBefore);
      } else if (entry.changes.length > 0) {
        // Fallback: focus on the first changed cell
        const firstChange = entry.changes[0];
        this.revogrid.setCellsFocus(
          { x: firstChange.colIndex, y: firstChange.rowIndex },
          { x: firstChange.colIndex, y: firstChange.rowIndex },
          undefined,
          firstChange.rowType
        );
      }

      // Move to redo stack
      this.redoStack.push({
        ...entry,
        timestamp: Date.now(),
      });

      this.notifyStateChange();
      return true;
    } finally {
      this.isUndoRedoOperation = false;
    }
  }

  /**
   * Redo the last undone change
   * @returns true if redo was performed, false if nothing to redo
   */
  public redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;

    this.isUndoRedoOperation = true;

    try {
      // Re-apply changes in original order
      for (const change of entry.changes) {
        this.revogrid.setDataAt({
          row: change.rowIndex,
          col: change.colIndex,
          val: change.newValue,
          rowType: change.rowType,
          colType: 'rgCol',
        });
      }

      // Restore selection to after state
      if (entry.selectionAfter && this.onRestoreSelection) {
        this.onRestoreSelection(entry.selectionAfter);
      } else if (entry.changes.length > 0) {
        // Fallback: focus on the last changed cell
        const lastChange = entry.changes[entry.changes.length - 1];
        this.revogrid.setCellsFocus(
          { x: lastChange.colIndex, y: lastChange.rowIndex },
          { x: lastChange.colIndex, y: lastChange.rowIndex },
          undefined,
          lastChange.rowType
        );
      }

      // Move back to undo stack
      this.undoStack.push({
        ...entry,
        timestamp: Date.now(),
      });

      this.notifyStateChange();
      return true;
    } finally {
      this.isUndoRedoOperation = false;
    }
  }

  /**
   * Check if undo is available
   */
  public get canUndo(): boolean {
    return this.undoStack.length > 0 || this.pendingChanges.length > 0;
  }

  /**
   * Check if redo is available
   */
  public get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Clear all undo/redo history
   */
  public clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.pendingChanges = [];
    this.pendingOldValue = null;
    if (this.batchTimeoutId !== null) {
      clearTimeout(this.batchTimeoutId);
      this.batchTimeoutId = null;
    }
    this.notifyStateChange();
  }

  /**
   * Record a manual change (for operations outside of normal edit flow)
   * This is useful for programmatic changes like delete key, paste, etc.
   */
  public recordManualChange(
    changes: Array<{
      rowIndex: number;
      colIndex: number;
      prop: string;
      oldValue: unknown;
      newValue: unknown;
      rowType?: DimensionRows;
    }>,
    selectionBefore?: SelectionState | null
  ): void {
    if (this.isUndoRedoOperation) return;

    this.commitBatch();

    const normalizedChanges: CellChange[] = changes
      .filter(c => c.oldValue !== c.newValue)
      .map(c => ({
        ...c,
        rowType: c.rowType || 'rgRow',
      }));

    if (normalizedChanges.length > 0) {
      const selection = selectionBefore ?? this.captureSelectionState();
      this.undoStack.push({
        changes: normalizedChanges,
        timestamp: Date.now(),
        selectionBefore: selection,
        selectionAfter: selection, // For manual changes, selection typically stays the same
      });
      this.redoStack = [];
      this.trimUndoStack();
      this.notifyStateChange();
    }
  }

  /**
   * Destroy the plugin and clean up
   */
  public override destroy(): void {
    if (this.batchTimeoutId !== null) {
      clearTimeout(this.batchTimeoutId);
      this.batchTimeoutId = null;
    }
    super.destroy();
  }
}
