/**
 * Headless extension for document comments. Owns the editor-mutation half of
 * the feature: a command that wraps the current selection in a `MarkNode`
 * carrying a comment-thread id. The React `CommentsPlugin` owns the UI half
 * (composer, thread panel, store wiring) and dispatches this command after it
 * has created the thread in the `CommentStore`.
 *
 * `MarkNode` itself is registered in `EditorNodes.ts`.
 */

import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  defineExtension,
  type LexicalCommand,
} from 'lexical';
import { $wrapSelectionInMarkNode } from '@lexical/mark';

/**
 * Wrap the current range selection in a comment `MarkNode`.
 *
 * Payload:
 * - `id`: the comment-thread id to anchor (must match the thread in the store).
 * - `isBackward`: selection direction, captured by the caller before dispatch
 *   so the mark spans the intended range.
 */
export const INSERT_INLINE_COMMENT_COMMAND: LexicalCommand<{
  id: string;
  isBackward: boolean;
}> = createCommand('INSERT_INLINE_COMMENT_COMMAND');

export const CommentsExtension = defineExtension({
  name: '@nimbalyst/editor/comments',
  register: (editor) => {
    return editor.registerCommand(
      INSERT_INLINE_COMMENT_COMMAND,
      ({ id, isBackward }) => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          $wrapSelectionInMarkNode(selection, isBackward, id);
        }
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    );
  },
});
