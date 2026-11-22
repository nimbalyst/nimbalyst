/**
 * Dictation target for Monaco. The pending partial is injected text at the
 * caret (a decoration, never model content); finals are a single undoable edit.
 */

import type { editor as MonacoEditorType } from 'monaco-editor';
import type { DictationTarget } from '../extensions/editorHost';
import { spaceBefore } from './dictationSpacing';

const PENDING_CLASS = 'dictation-pending-decoration';

export function createMonacoDictationTarget(
  editor: MonacoEditorType.IStandaloneCodeEditor,
): DictationTarget {
  const pending = editor.createDecorationsCollection();
  return {
    kind: 'code',
    hasFocus: () => editor.hasTextFocus(),
    showPartial: (text: string) => {
      const position = editor.getPosition();
      if (!position) return;
      // Injected text renders inline at the caret without entering the model.
      pending.set([
        {
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
          options: { after: { content: text, inlineClassName: PENDING_CLASS } },
        },
      ]);
    },
    clearPartial: () => pending.clear(),
    commitFinal: (text: string) => {
      pending.clear();
      const model = editor.getModel();
      const selection = editor.getSelection();
      if (!model || !selection || !text || editor.getRawOptions().readOnly) return;
      const prevChar = selection.isEmpty() && selection.startColumn > 1
        ? model.getLineContent(selection.startLineNumber).charAt(selection.startColumn - 2)
        : '';
      const insert = selection.isEmpty() ? spaceBefore(prevChar, text) : text;
      editor.pushUndoStop();
      editor.executeEdits('dictation', [{ range: selection, text: insert, forceMoveMarkers: true }]);
      editor.pushUndoStop();
    },
  };
}
