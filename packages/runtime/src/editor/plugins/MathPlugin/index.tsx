/**
 * MathPlugin - Main plugin component for math rendering
 */

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $insertNodes,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  LexicalCommand,
} from 'lexical';
import { useEffect } from 'react';
import { $createMathNode, MathNode, MathBlockPayload } from './MathNode';
import { $createInlineMathNode, InlineMathNode, InlineMathPayload } from './InlineMathNode';
import { mergeRegister } from '@lexical/utils';

export const INSERT_MATH_COMMAND: LexicalCommand<MathBlockPayload | undefined> =
  createCommand('INSERT_MATH_COMMAND');

export const INSERT_INLINE_MATH_COMMAND: LexicalCommand<InlineMathPayload | undefined> =
  createCommand('INSERT_INLINE_MATH_COMMAND');

export default function MathPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editor.hasNodes([MathNode])) {
      throw new Error('MathPlugin: MathNode not registered on editor');
    }
    if (!editor.hasNodes([InlineMathNode])) {
      throw new Error('MathPlugin: InlineMathNode not registered on editor');
    }

    return mergeRegister(
      editor.registerCommand(
        INSERT_MATH_COMMAND,
        (payload?: MathBlockPayload) => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const mathNode = $createMathNode(payload);
            $insertNodes([mathNode]);
          }
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
      editor.registerCommand(
        INSERT_INLINE_MATH_COMMAND,
        (payload?: InlineMathPayload) => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const mathNode = $createInlineMathNode(payload);
            $insertNodes([mathNode]);
          }
          return true;
        },
        COMMAND_PRIORITY_EDITOR,
      ),
    );
  }, [editor]);

  return null;
}

// Export everything needed for the plugin
export { MathNode, $createMathNode, $isMathNode } from './MathNode';
export type { MathBlockPayload, SerializedMathNode } from './MathNode';
export { InlineMathNode, $createInlineMathNode, $isInlineMathNode } from './InlineMathNode';
export type { InlineMathPayload, SerializedInlineMathNode } from './InlineMathNode';
export { MATH_BLOCK_TRANSFORMER, MATH_INLINE_TRANSFORMER } from './MathTransformers';
