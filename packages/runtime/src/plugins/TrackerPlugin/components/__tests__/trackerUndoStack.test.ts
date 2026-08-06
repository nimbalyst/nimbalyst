// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  MAX_UNDO_CHANGES_PER_ENTRY,
  MAX_UNDO_DEPTH,
  applyRecord,
  applyRedo,
  applyUndo,
  areTrackerUndoValuesEqual,
  createEmptyHistory,
  formatTrackerUndoToast,
  mergeUndoChanges,
  type TrackerUndoEntry,
} from '../trackerUndoStack';

function entry(label: string): TrackerUndoEntry {
  return {
    label,
    changes: [
      {
        kind: 'field',
        itemId: label,
        field: 'status',
        previousValue: 'todo',
        nextValue: 'done',
      },
    ],
  };
}

describe('tracker undo stack', () => {
  it('round-trips an entry by identity without mutating its input histories', () => {
    const empty = createEmptyHistory();
    const edit = entry('Edit Status');
    const recorded = applyRecord(empty, edit);
    const undone = applyUndo(recorded);
    const redone = applyRedo(undone.history);

    expect(undone.entry).toBe(edit);
    expect(undone.history.future[0]).toBe(edit);
    expect(redone.entry).toBe(edit);
    expect(redone.history.past[0]).toBe(edit);
    expect(empty).toEqual({ past: [], future: [] });
    expect(recorded).toEqual({ past: [edit], future: [] });
    expect(undone.history).toEqual({ past: [], future: [edit] });

    expect(applyRecord(empty, { label: 'Empty', changes: [] })).toBe(empty);
    const emptyUndo = applyUndo(empty);
    expect(emptyUndo.entry).toBeNull();
    expect(emptyUndo.history).toBe(empty);
  });

  it('clears a redo branch and evicts only the oldest entries beyond the depth cap', () => {
    const first = entry('First');
    const second = entry('Second');
    const recorded = applyRecord(
      applyRecord(createEmptyHistory(), first),
      second
    );
    const undone = applyUndo(recorded).history;
    const branched = applyRecord(undone, entry('Replacement'));

    expect(branched.future).toEqual([]);
    expect(branched.past.map((item) => item.label)).toEqual([
      'First',
      'Replacement',
    ]);

    const entries = Array.from({ length: MAX_UNDO_DEPTH + 3 }, (_, index) =>
      entry(`Edit ${index}`)
    );
    const capped = entries.reduce(applyRecord, createEmptyHistory());

    expect(capped.past).toEqual(entries.slice(-MAX_UNDO_DEPTH));

    // An entry too large to hold is dropped whole rather than truncated -- but
    // its writes still happened, so the redo branch goes with it.
    const huge: TrackerUndoEntry = {
      label: 'Paste everything',
      changes: Array.from({ length: MAX_UNDO_CHANGES_PER_ENTRY + 1 }, (_, index) => ({
        kind: 'field',
        itemId: `item-${index}`,
        field: 'status',
        previousValue: 'todo',
        nextValue: 'done',
      })),
    };
    const afterHuge = applyRecord(applyUndo(recorded).history, huge);
    expect(afterHuge.past.map((item) => item.label)).toEqual(['First']);
    expect(afterHuge.future).toEqual([]);

    // The skipped count reaches the user; the exact copy is not the contract.
    expect(formatTrackerUndoToast('undo', 'Paste 12 cells', 9, 3).body).toContain('3');
  });

  it('fails the drift guard closed and folds repeated writes to one cell', () => {
    // Two Dates expose no own keys, so a plain key walk calls any two equal --
    // which would let a redo overwrite a teammate's newer date.
    expect(areTrackerUndoValuesEqual(new Date('2026-08-01'), new Date('2026-09-01'))).toBe(false);
    expect(areTrackerUndoValuesEqual(new Date('2026-08-01'), new Date('2026-08-01'))).toBe(true);
    // Anything the walk cannot inspect compares unequal, so replay skips it.
    expect(areTrackerUndoValuesEqual(new Set(['a']), new Set(['a']))).toBe(false);
    expect(areTrackerUndoValuesEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);

    const change = (previousValue: unknown, nextValue: unknown) => ({
      kind: 'field' as const,
      itemId: 'item-1',
      field: 'status',
      previousValue,
      nextValue,
    });

    // A hand edit joining a slow paste: keep the first `previousValue` and the
    // last `nextValue` so undo restores the state before either.
    expect(mergeUndoChanges([change('a', 'b')], [change('b', 'c')])).toEqual([
      change('a', 'c'),
    ]);
    // A round trip leaves nothing to reverse.
    expect(mergeUndoChanges([change('a', 'b')], [change('b', 'a')])).toEqual([]);
    expect(
      mergeUndoChanges(
        [{ kind: 'archive', itemId: 'item-1', previousArchived: false, nextArchived: true }],
        [{ kind: 'archive', itemId: 'item-1', previousArchived: true, nextArchived: false }]
      )
    ).toEqual([]);
  });
});
