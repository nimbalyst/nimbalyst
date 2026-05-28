/**
 * Math extension entry.
 *
 * Owns LaTeX math rendering for Nimbalyst in both the transcript and the
 * Lexical editor.
 */

import './styles.css';

import {
  $getSelection,
  $isRangeSelection,
  $insertNodes,
} from 'lexical';

import { TranscriptMathHost } from './TranscriptMathHost';
import {
  $createMathBlockNode,
  $createMathInlineNode,
  BLOCK_MATH_TRANSFORMER,
  INLINE_MATH_TRANSFORMER,
  MathLexicalExtension,
} from './lexical';

export async function activate(): Promise<void> {
  // Registration happens inside TranscriptMathHost so it follows the host
  // component's mount/unmount lifecycle; there is no work to do here.
}

export async function deactivate(): Promise<void> {
  // Same -- the host component cleans up its own contributions on unmount.
}

export const transformers = {
  BLOCK_MATH_TRANSFORMER,
  INLINE_MATH_TRANSFORMER,
};

export const lexicalExtensions = {
  MathLexicalExtension,
};

export const hostComponents = {
  TranscriptMathHost,
};

// Slash command handlers run inside an editor command listener context,
// so the Lexical `$` helpers operate on the active editor.
export const slashCommandHandlers = {
  insertInlineMath: () => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    $insertNodes([$createMathInlineNode('x')]);
  },
  insertBlockMath: () => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    $insertNodes([$createMathBlockNode('x = y', '$$')]);
  },
};
