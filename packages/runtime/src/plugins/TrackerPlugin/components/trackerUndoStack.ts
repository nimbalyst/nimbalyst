export type TrackerUndoChange =
  | {
      kind: 'field';
      itemId: string;
      field: string;
      previousValue: unknown;
      nextValue: unknown;
    }
  | {
      kind: 'archive';
      itemId: string;
      previousArchived: boolean;
      nextArchived: boolean;
    };

export interface TrackerUndoEntry {
  label: string;
  changes: TrackerUndoChange[];
}

export interface TrackerUndoHistory {
  past: TrackerUndoEntry[];
  future: TrackerUndoEntry[];
}

export const MAX_UNDO_DEPTH = 50;

/**
 * Per-entry change cap. The depth cap bounds how many entries are kept, not how
 * large one is -- a paste addresses arbitrarily many cells, so 50 unbounded
 * entries is unbounded memory. An entry past the cap is dropped whole rather
 * than truncated: half-undoing a paste is worse than not undoing it.
 */
export const MAX_UNDO_CHANGES_PER_ENTRY = 2000;

export function createEmptyHistory(): TrackerUndoHistory {
  return { past: [], future: [] };
}

function appendPast(
  past: TrackerUndoEntry[],
  entry: TrackerUndoEntry
): TrackerUndoEntry[] {
  const nextPast = [...past, entry];
  return nextPast.length > MAX_UNDO_DEPTH
    ? nextPast.slice(nextPast.length - MAX_UNDO_DEPTH)
    : nextPast;
}

export function applyRecord(
  history: TrackerUndoHistory,
  entry: TrackerUndoEntry
): TrackerUndoHistory {
  if (entry.changes.length === 0) return history;

  if (entry.changes.length > MAX_UNDO_CHANGES_PER_ENTRY) {
    // The writes still landed, so anything sitting in `future` is stale whether
    // or not this entry is keepable.
    return { past: history.past, future: [] };
  }

  return {
    past: appendPast(history.past, entry),
    future: [],
  };
}

export function applyUndo(history: TrackerUndoHistory): {
  history: TrackerUndoHistory;
  entry: TrackerUndoEntry | null;
} {
  if (history.past.length === 0) {
    return { history, entry: null };
  }

  const entry = history.past[history.past.length - 1];
  return {
    history: {
      past: history.past.slice(0, -1),
      future: [entry, ...history.future],
    },
    entry,
  };
}

export function applyRedo(history: TrackerUndoHistory): {
  history: TrackerUndoHistory;
  entry: TrackerUndoEntry | null;
} {
  if (history.future.length === 0) {
    return { history, entry: null };
  }

  const entry = history.future[0];
  return {
    history: {
      past: appendPast(history.past, entry),
      future: history.future.slice(1),
    },
    entry,
  };
}

export function applyClear(): TrackerUndoHistory {
  return createEmptyHistory();
}

/** A key walk only describes an object whose whole state lives in its own keys. */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Value equality for JSON-shaped tracker field values.
 *
 * This backs the drift guard, so it fails closed: anything it cannot compare
 * field by field (a `Map`, a `Set`, a class instance) reports unequal, which
 * skips the replay rather than overwriting a value it did not actually verify.
 */
export function areTrackerUndoValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }

  // Dates carry their whole value in the timestamp and expose no own keys, so
  // the key walk below would call any two of them equal.
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => areTrackerUndoValuesEqual(value, right[index]));
  }

  if (!isPlainObject(left) || !isPlainObject(right)) return false;

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;

  return leftKeys.every(key =>
    Object.prototype.hasOwnProperty.call(rightRecord, key)
    && areTrackerUndoValuesEqual(leftRecord[key], rightRecord[key])
  );
}

function changeKey(change: TrackerUndoChange): string {
  return change.kind === 'field'
    ? `field\u001f${change.itemId}\u001f${change.field}`
    : `archive\u001f${change.itemId}`;
}

/**
 * Fold changes that address the same cell into one, keeping the *first*
 * `previousValue` and the *last* `nextValue`.
 *
 * A slow batch (a large paste) can still be writing when the user edits one of
 * the same cells by hand, and that edit joins the open batch. Without folding,
 * the entry holds `A -> B` and `B -> C` for one cell: undo skips the first as
 * drifted, applies the second, and lands on a state neither action produced.
 * Folded to `A -> C`, undo restores `A`.
 *
 * A fold that cancels out (`A -> B -> A`) is dropped: there is nothing to
 * reverse, and an entry that writes a value already in place is noise.
 */
export function mergeUndoChanges(
  existing: readonly TrackerUndoChange[],
  incoming: readonly TrackerUndoChange[]
): TrackerUndoChange[] {
  const merged = new Map<string, TrackerUndoChange>();

  for (const change of [...existing, ...incoming]) {
    const key = changeKey(change);
    const prior = merged.get(key);
    if (!prior) {
      merged.set(key, change);
    } else if (prior.kind === 'field' && change.kind === 'field') {
      merged.set(key, { ...change, previousValue: prior.previousValue });
    } else if (prior.kind === 'archive' && change.kind === 'archive') {
      merged.set(key, { ...change, previousArchived: prior.previousArchived });
    }
  }

  return Array.from(merged.values()).filter(change =>
    change.kind === 'field'
      ? !areTrackerUndoValuesEqual(change.previousValue, change.nextValue)
      : change.previousArchived !== change.nextArchived
  );
}

/**
 * Toast copy for a replayed entry. The verb lives in the title and never in the
 * body, so the notification does not read "Undone / Undone — ...".
 */
export function formatTrackerUndoToast(
  direction: 'undo' | 'redo',
  label: string,
  applied: number,
  skipped: number
): { title: string; body: string } {
  const title = direction === 'undo' ? 'Undone' : 'Redone';
  if (skipped === 0) return { title, body: label };

  const total = applied + skipped;
  const noun = total === 1 ? 'change' : 'changes';
  return { title, body: `${applied} of ${total} ${noun} (${skipped} changed since)` };
}
