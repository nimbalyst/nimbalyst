/**
 * Editor-level keys for when focus is in the editor but not on the grid (the
 * editor root after a menu closes, for example): undo/redo, select-all, clear,
 * and Escape. Keys aimed at the grid are handled first by `useGridKeyboard`,
 * which stops the ones it owns; copy/cut/paste are native events
 * (`useGridClipboard`). Text fields such as the formula bar keep their own
 * undo, select-all and delete.
 */

import { useCallback } from 'react';
import type { EditorCore } from './editorCore';
import type { Selection } from './useSelection';

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable);
}

export function useEditorKeyDown(
  core: EditorCore,
  isActive: boolean,
  { updateSelection, selectAll }: Pick<Selection, 'updateSelection' | 'selectAll'>,
) {
  const { editorRef, gridOpsRef, editingLockedRef, selectionRangeRef } = core;

  return useCallback(
    (event: React.KeyboardEvent) => {
      if (!isActive) return;
      const editor = editorRef.current;
      if (!editor || !editor.contains(document.activeElement)) return;
      if (event.key === 'Escape') {
        void updateSelection(null, null);
        return;
      }
      if (isTextField(event.target)) return;

      const isMac = /mac/i.test(navigator.platform);
      const cmdOrCtrl = isMac ? event.metaKey : event.ctrlKey;
      const gridOps = gridOpsRef.current;
      // Selection and find stay live while locked; anything that writes does not.
      const locked = editingLockedRef.current;
      const key = event.key.toLowerCase();

      if (cmdOrCtrl && !event.altKey) {
        if (key === 'z' || (key === 'y' && !isMac)) {
          event.preventDefault();
          if (locked) return;
          const redo = key === 'y' || event.shiftKey;
          void (redo ? gridOps?.executor.redo() : gridOps?.executor.undo());
          return;
        }
        if (key === 'a' && !event.shiftKey) {
          event.preventDefault();
          selectAll();
        }
        return;
      }

      if (!locked && (event.key === 'Delete' || event.key === 'Backspace')) {
        const range = selectionRangeRef.current;
        if (range && gridOps) {
          event.preventDefault();
          void gridOps.clearCells(range);
        }
      }
    },
    [isActive, updateSelection, selectAll, editorRef, gridOpsRef, editingLockedRef, selectionRangeRef]
  );
}
