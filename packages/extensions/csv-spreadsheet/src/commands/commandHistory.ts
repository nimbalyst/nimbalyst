/**
 * Undo/redo stacks of command inverses.
 *
 * An entry holds the command that undoes one user-visible step (a keystroke
 * commit, a paste, one agent tool call). Undoing applies it and stores the
 * inverse it returns as the redo entry, so history never replays a stale copy.
 * Only local origins are recorded; remote collaborator edits never land here.
 */

import type { SheetCommand } from './sheetCommand';

export type CommandOrigin = 'user' | 'agent' | 'remote';

export interface HistoryEntry<Selection> {
  readonly inverse: SheetCommand;
  readonly origin: CommandOrigin;
  /** Selection to restore when this entry is applied. */
  readonly selection: Selection | null;
  /** Rows the sheet had before the step, so undoing a step that grew it can shrink it back. */
  readonly rowCount?: number;
}

const MAX_ENTRIES = 100;

export class CommandHistory<Selection> {
  private undoStack: HistoryEntry<Selection>[] = [];
  private redoStack: HistoryEntry<Selection>[] = [];

  constructor(private readonly onChange?: () => void) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Record a new step. A new step makes the redo stack meaningless. */
  record(entry: HistoryEntry<Selection>): void {
    if (entry.origin === 'remote') return;
    this.undoStack.push(entry);
    if (this.undoStack.length > MAX_ENTRIES) this.undoStack.shift();
    this.redoStack = [];
    this.onChange?.();
  }

  peek(direction: 'undo' | 'redo'): HistoryEntry<Selection> | undefined {
    const stack = direction === 'undo' ? this.undoStack : this.redoStack;
    return stack[stack.length - 1];
  }

  /** Move the top entry of one stack to the other, replaced by its counterpart. */
  complete(direction: 'undo' | 'redo', counterpart: HistoryEntry<Selection>): void {
    const [from, to] = direction === 'undo' ? [this.undoStack, this.redoStack] : [this.redoStack, this.undoStack];
    from.pop();
    to.push(counterpart);
    this.onChange?.();
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.onChange?.();
  }
}
