/**
 * Dictation target for the Lexical markdown editor, registered through
 * `EditorHost.registerDictationTarget` so dictated speech lands at its cursor.
 * Monaco's lives in monacoDictationTarget.ts so Monaco does not pull in Lexical.
 * Committed text goes through the editor's own edit path (undoable, marks the
 * document dirty like typing); pending partials are never document content.
 */

import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  type LexicalEditor,
} from 'lexical';
import type { DictationTarget } from '../extensions/editorHost';
import { spaceBefore } from './dictationSpacing';

export function createLexicalDictationTarget(editor: LexicalEditor): DictationTarget {
  return {
    kind: 'rich-text',
    hasFocus: () => {
      const root = editor.getRootElement();
      return !!root && root.contains(document.activeElement);
    },
    getCaretRect: () => {
      const selection = window.getSelection();
      const root = editor.getRootElement();
      if (!selection || selection.rangeCount === 0 || !root) return null;
      const range = selection.getRangeAt(0);
      if (!root.contains(range.startContainer)) return null;
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
      if (rect && (rect.width > 0 || rect.height > 0)) return rect;
      // Collapsed caret on an empty line has no rect; use its block instead.
      const el = range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
      return el?.getBoundingClientRect() ?? null;
    },
    clearPartial: () => {
      // The host paints the partial; nothing in the document to remove.
    },
    commitFinal: (text: string) => {
      if (!text) return;
      editor.update(() => {
        let selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          $getRoot().selectEnd();
          selection = $getSelection();
        }
        if (!$isRangeSelection(selection)) return;
        const anchor = selection.anchor;
        let prevChar = '';
        const node = anchor.getNode();
        if ($isTextNode(node) && anchor.offset > 0) {
          prevChar = node.getTextContent().charAt(anchor.offset - 1);
        }
        selection.insertText(selection.isCollapsed() ? spaceBefore(prevChar, text) : text);
      });
    },
  };
}
