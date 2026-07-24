import type {
  MultilineElementTransformer,
  TextMatchTransformer,
} from '@lexical/markdown';

import {
  $createMathBlockNode,
  $isMathBlockNode,
  MathBlockNode,
  type MathBlockDelimiter,
} from './MathBlockNode';
import {
  $createMathInlineNode,
  $isMathInlineNode,
  MathInlineNode,
} from './MathInlineNode';

// Pandoc-style inline math import: opening `$` not followed by whitespace,
// closing `$` not preceded by whitespace and not followed by a digit (so
// currency like `$7M ... $40M` is not collapsed as math on paste/import).
const INLINE_MATH_IMPORT_REGEXP = /\$(?!\$)(?!\s)([^$\n]*?[^$\s])\$(?!\$)(?!\d)/;
// Typing-time shortcut is disabled. Auto-converting `$x$` fired the moment
// the second `$` was typed, before the user could type the digit after it,
// so currency text like "...$40M" was eagerly turned into math. Inline math
// is now inserted via the slash menu instead.
const INLINE_MATH_SHORTCUT_REGEXP = /(?!)/;
const BLOCK_MATH_DELIMITER_REGEXP = /^[ \t]*(\${1,2})[ \t]*$/;

export const INLINE_MATH_TRANSFORMER: TextMatchTransformer = {
  dependencies: [MathInlineNode],
  export: (node) => {
    if (!$isMathInlineNode(node)) {
      return null;
    }

    return `$${node.getSource()}$`;
  },
  importRegExp: INLINE_MATH_IMPORT_REGEXP,
  regExp: INLINE_MATH_SHORTCUT_REGEXP,
  replace: (textNode, match) => {
    const [, source] = match;
    textNode.replace($createMathInlineNode(source));
  },
  trigger: '$',
  type: 'text-match',
};

export const BLOCK_MATH_TRANSFORMER: MultilineElementTransformer = {
  dependencies: [MathBlockNode],
  export: (node) => {
    if (!$isMathBlockNode(node)) {
      return null;
    }

    const delimiter = node.getDelimiter();
    return `${delimiter}\n${node.getSource()}\n${delimiter}`;
  },
  regExpStart: BLOCK_MATH_DELIMITER_REGEXP,
  regExpEnd: {
    regExp: BLOCK_MATH_DELIMITER_REGEXP,
  },
  replace: (_rootNode, _children, _startMatch, _endMatch, _linesInBetween) => {
    return false;
  },
  handleImportAfterStartMatch: ({
    lines,
    rootNode,
    startLineIndex,
    startMatch,
  }) => {
    const delimiter = normalizeDelimiter(startMatch[1]);
    const contentLines: string[] = [];

    for (let lineIndex = startLineIndex + 1; lineIndex < lines.length; lineIndex += 1) {
      const endMatch = lines[lineIndex].match(BLOCK_MATH_DELIMITER_REGEXP);
      if (endMatch && normalizeDelimiter(endMatch[1]) === delimiter) {
        rootNode.append($createMathBlockNode(contentLines.join('\n'), delimiter));
        return [true, lineIndex];
      }

      contentLines.push(lines[lineIndex]);
    }

    return null;
  },
  type: 'multiline-element',
};

function normalizeDelimiter(value: string): MathBlockDelimiter {
  return value === '$' ? '$' : '$$';
}
