/**
 * MathTransformers - Handles markdown import/export for math notation
 *
 * Block math:  $$\n...\n$$
 * Inline math: $...$
 */

import { MultilineElementTransformer, TextMatchTransformer } from '@lexical/markdown';
import { $createMathNode, $isMathNode, MathNode } from './MathNode';
import {
  $createInlineMathNode,
  $isInlineMathNode,
  InlineMathNode,
} from './InlineMathNode';
import { TextNode } from 'lexical';

// ---------------------------------------------------------------------------
// Block math transformer ($$...$$)
// ---------------------------------------------------------------------------

const MATH_BLOCK_START_REGEX = /^\$\$/;
const MATH_BLOCK_END_REGEX = /^\$\$$/;

export const MATH_BLOCK_TRANSFORMER: MultilineElementTransformer = {
  dependencies: [MathNode],
  export: (node) => {
    if (!$isMathNode(node)) {
      return null;
    }
    const equation = node.getEquation();
    return '$$\n' + equation + '\n$$';
  },
  regExpStart: MATH_BLOCK_START_REGEX,
  regExpEnd: MATH_BLOCK_END_REGEX,
  replace: (rootNode, children, startMatch, endMatch, linesInBetween) => {
    const equation = linesInBetween ? linesInBetween.join('\n').trim() : '';
    if (!equation) {
      return;
    }
    const mathNode = $createMathNode({ equation });
    rootNode.append(mathNode);
  },
  type: 'multiline-element',
};

// ---------------------------------------------------------------------------
// Inline math transformer ($...$)
// ---------------------------------------------------------------------------

export const MATH_INLINE_TRANSFORMER: TextMatchTransformer = {
  dependencies: [InlineMathNode],
  export: (node) => {
    if (!$isInlineMathNode(node)) {
      return null;
    }
    return `$${node.getEquation()}$`;
  },
  // Match $...$ but NOT $$...$$ (negative lookbehind/lookahead for $)
  // Also don't match empty $ $ or strings that are just whitespace
  importRegExp: /(?<!\$)\$(?!\$)([^\$\n]+?)\$(?!\$)/,
  regExp: /(?<!\$)\$(?!\$)([^\$\n]+?)\$(?!\$)$/,
  replace: (textNode: TextNode, match: RegExpMatchArray) => {
    const equation = match[1];
    if (!equation || !equation.trim()) {
      return;
    }
    const mathNode = $createInlineMathNode({ equation });
    textNode.replace(mathNode);
  },
  trigger: '$',
  type: 'text-match',
};
