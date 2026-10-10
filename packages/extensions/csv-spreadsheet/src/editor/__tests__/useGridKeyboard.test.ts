import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useGridKeyboard } from '../useGridKeyboard';
import { createRowIndexMapping } from '../../filter/rowIndexMapping';
import { EMPTY_FORMATTING } from '../../sheetMeta/formatting';
import type { EditorCore } from '../editorCore';
import type { GridKeyState } from '../../keyboard';

/** The refs the key controller reads, with the grid's editor never mounting (a fast typed run). */
function fakeCore() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const execute = vi.fn(async (_command: { cells: unknown[] }) => null);
  const at = { row: 4, col: 0 };
  const meta = { ...EMPTY_FORMATTING, headerRowCount: 1, frozenColumnCount: 0, columnCount: 2, columnFormats: {}, columnWidths: {}, cellStyles: {} };
  const core = {
    gridContainerRef: { current: container },
    revoGridRef: { current: { pinnedTopSource: [{}], source: [], setCellEdit: vi.fn(async () => undefined) } },
    rowSpaceRef: { current: createRowIndexMapping({ rowCount: 20, headerRowCount: 1 }) },
    spreadsheetMetaRef: { current: { getMetadata: () => meta } },
    zoomRef: { current: 1 },
    keyStateRef: { current: { active: at, anchor: at, focus: at, mode: 'none', tabRunStartCol: null } as GridKeyState },
    activeEditorRef: { current: null },
    pendingEditTextRef: { current: null },
    editSessionRef: { current: 0 },
    openingEditSessionRef: { current: null },
    editingLockedRef: { current: false },
    gridOpsRef: { current: { executor: { execute } } },
    selectionRangeRef: { current: null },
    selectedCellRef: { current: null },
    reportRejectionRef: { current: null },
  } as unknown as EditorCore;
  return { core, container, execute };
}

const press = (target: Element, key: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('useGridKeyboard', () => {
  it('commits a char typed right after a Tab even when the Tab commit\'s deferred selection lands in between', async () => {
    const { core, container, execute } = fakeCore();
    const identity = (row: number) => row;
    renderHook(() => useGridKeyboard(
      core,
      { toVisibleRow: identity, toLogicalRow: identity },
      { selectFromKeyboard: (state) => { core.keyStateRef.current = state; }, selectAll: () => {} },
      { enabled: true, displayColumnCount: 2 },
    ));

    press(container, 'D');
    press(container, 'Tab');
    press(container, '4');
    // The Tab commit shows its selection a tick later, after "4" opened an edit.
    await new Promise((resolve) => setTimeout(resolve, 0));
    press(container, 'Enter');

    const writes = execute.mock.calls.map(([command]) => command.cells[0]);
    expect(writes).toEqual([{ row: 4, col: 0, value: 'D' }, { row: 4, col: 1, value: '4' }]);
  });

  it('never drives an editor RevoGrid built late for an edit already committed past', () => {
    const { core, container, execute } = fakeCore();
    const identity = (row: number) => row;
    renderHook(() => useGridKeyboard(
      core,
      { toVisibleRow: identity, toLogicalRow: identity },
      { selectFromKeyboard: (state) => { core.keyStateRef.current = state; }, selectAll: () => {} },
      { enabled: true, displayColumnCount: 2 },
    ));

    press(container, 'D');
    press(container, 'Tab');
    // The editor for the "D" edit mounts only now, starting from A5's old value.
    const stale = { editSession: 1, editInput: null, commit: vi.fn(), cancel: vi.fn(), insertText: vi.fn(), getValue: () => '' };
    (core.activeEditorRef as { current: unknown }).current = stale;
    press(container, '4');
    press(container, 'Enter');

    expect(stale.commit).not.toHaveBeenCalled();
    expect(stale.insertText).not.toHaveBeenCalled();
    const writes = execute.mock.calls.map(([command]) => command.cells[0]);
    expect(writes).toEqual([{ row: 4, col: 0, value: 'D' }, { row: 4, col: 1, value: '4' }]);
  });
});
