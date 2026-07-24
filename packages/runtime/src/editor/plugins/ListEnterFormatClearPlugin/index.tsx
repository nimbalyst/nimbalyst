/**
 * Lexical plugin that clears `selection.format` before an Enter inside a list
 * item, when the cursor sits at end-of-line after a whitespace character that
 * follows an inline-formatted span (code, bold, italic).
 *
 * The bug it fixes (#302): pressing Enter in a list item that ends with
 * `\`code\` ` (inline-code span followed by a space) creates a new bullet
 * still in inline-code format. The new line continues to type inside the code
 * style even though the cursor was visually outside the code span.
 *
 * Root cause: Lexical's RangeSelection carries `selection.format` forward
 * when the cursor moves past inline text. When the cursor crosses the
 * code-then-space boundary, `selection.format` retains the code bit because
 * Lexical only clears it on movement between distinct text nodes of
 * different formats, not on the "trailing-whitespace-after-format-span"
 * case. `selection.insertParagraph()` then seeds the new list item's first
 * child TextNode with that stale format, and `@lexical/list`'s node
 * transform at LexicalList.dev.js:1478-1484 propagates the format onto the
 * new ListItemNode itself.
 *
 * The fix is scoped to list-item context per the issue report. The same
 * mechanism also affects regular paragraphs but lives in a different code
 * path that the user did not report against; a broader fix can follow if a
 * maintainer asks for it.
 */

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $isListItemNode } from '@lexical/list';
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_NORMAL,
  INSERT_PARAGRAPH_COMMAND,
  type RangeSelection,
} from 'lexical';
import { useEffect } from 'react';

/**
 * Pure decision + mutation. Inspects the selection and, if the conditions
 * for #302 are met, clears `selection.format` and returns true. Otherwise
 * returns false and leaves `selection.format` untouched.
 *
 * Exported separately from the React plugin so unit tests can exercise it
 * directly against a headless editor without mounting a React tree.
 */
export function $clearFormatForListItemEnter(selection: RangeSelection): boolean {
  if (selection.format === 0) return false;
  if (!selection.isCollapsed()) return false;

  const anchor = selection.anchor;
  if (anchor.type !== 'text') return false;

  const anchorNode = anchor.getNode();
  if (!$isTextNode(anchorNode)) return false;

  // Walk up to confirm we are inside a list item.
  let parent = anchorNode.getParent();
  let insideListItem = false;
  while (parent !== null) {
    if ($isListItemNode(parent)) {
      insideListItem = true;
      break;
    }
    parent = parent.getParent();
  }
  if (!insideListItem) return false;

  // The trailing-whitespace gate: only clear if the character immediately
  // before the cursor is whitespace. This preserves the case where the user
  // types `\`code\`` and then presses Enter with the cursor still inside the
  // code span (no trailing space) - they probably want the new line to keep
  // the code style and our fix should not interfere.
  const offset = anchor.offset;
  if (offset === 0) return false;
  const text = anchorNode.getTextContent();
  const prevChar = text.charAt(offset - 1);
  if (prevChar !== ' ' && prevChar !== '\t' && prevChar !== ' ') return false;

  selection.format = 0;
  return true;
}

export function ListEnterFormatClearPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      INSERT_PARAGRAPH_COMMAND,
      () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;
        $clearFormatForListItemEnter(selection);
        // Always return false: we are not consuming the command, only
        // mutating the selection so the downstream @lexical/list and
        // @lexical/rich-text handlers see a cleared format.
        return false;
      },
      COMMAND_PRIORITY_NORMAL,
    );
  }, [editor]);

  return null;
}

export default ListEnterFormatClearPlugin;
