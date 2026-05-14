/**
 * Nimbalyst markdown transformers.
 *
 * Transformer interface types come from upstream `@lexical/markdown`. The
 * remaining definitions in this file are either Nimbalyst-specific tweaks
 * (HEADING/QUOTE/CODE/LINK with our regexes and CodeNode "plain"-language
 * marker) or thin re-exports of upstream text-format constants kept here for
 * backwards compatibility with existing transformer arrays.
 */

import type {HeadingTagType} from '@lexical/rich-text';

import {$createCodeNode, $isCodeNode, CodeNode} from '@lexical/code';
import {
  $createLinkNode,
  $isAutoLinkNode,
  $isLinkNode,
  LinkNode,
} from '@lexical/link';
import {
  $createHeadingNode,
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
  HeadingNode,
  QuoteNode,
} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createTextNode,
  ElementNode,
  LexicalNode,
} from 'lexical';
import {
  BOLD_ITALIC_STAR as UPSTREAM_BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE as UPSTREAM_BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR as UPSTREAM_BOLD_STAR,
  BOLD_UNDERSCORE as UPSTREAM_BOLD_UNDERSCORE,
  HIGHLIGHT as UPSTREAM_HIGHLIGHT,
  INLINE_CODE as UPSTREAM_INLINE_CODE,
  ITALIC_STAR as UPSTREAM_ITALIC_STAR,
  ITALIC_UNDERSCORE as UPSTREAM_ITALIC_UNDERSCORE,
  STRIKETHROUGH as UPSTREAM_STRIKETHROUGH,
} from '@lexical/markdown';

export type {
  ElementTransformer,
  MultilineElementTransformer,
  TextFormatTransformer,
  TextMatchTransformer,
  Transformer,
} from '@lexical/markdown';
import type {
  ElementTransformer,
  MultilineElementTransformer,
  TextFormatTransformer,
  TextMatchTransformer,
} from '@lexical/markdown';

// Import list transformers from the dedicated module
import {
  UNORDERED_LIST,
  ORDERED_LIST,
  CHECK_LIST,
  setListConfig,
  getListConfig,
  type ListConfig,
} from './ListTransformers';

// Re-export list configuration functions
export { setListConfig, getListConfig, type ListConfig };

const HEADING_REGEX = /^(#{1,6})\s/;
const QUOTE_REGEX = /^>\s/;
const CODE_START_REGEX = /^[ \t]*```([\w-]+)?/;
const CODE_END_REGEX = /[ \t]*```$/;

const createBlockNode = (
  createNode: (match: Array<string>) => ElementNode,
): ElementTransformer['replace'] => {
  return (parentNode, children, match, isImport) => {
    const node = createNode(match);
    node.append(...children);
    parentNode.replace(node);
    if (!isImport) {
      node.select(0, 0);
    }
  };
};

// Configuration for markdown import/export (non-list related)
export interface MarkdownConfig {
  // This now only contains non-list configuration
  // List configuration is handled by ListTransformers
}

// For backward compatibility, proxy list config through the main config
export function setMarkdownConfig(config: Partial<MarkdownConfig & ListConfig>): void {
  // If list-related config is provided, forward it to ListTransformers
  if ('exportIndentSize' in config ||
      'importMinIndentSize' in config ||
      'importMaxIndentSize' in config ||
      'autoDetectIndent' in config) {
    setListConfig(config);
  }
}

export function getMarkdownConfig(): MarkdownConfig & ListConfig {
  return {
    ...getListConfig(),
  };
}

// Removed getIndent function - now handled by ListTransformers

// Removed listReplace function - now handled by ListTransformers

// Removed listExport function - now handled by ListTransformers

export const HEADING: ElementTransformer = {
  dependencies: [HeadingNode],
  export: (node, exportChildren) => {
    if (!$isHeadingNode(node)) {
      return null;
    }
    const level = Number(node.getTag().slice(1));
    return '#'.repeat(level) + ' ' + exportChildren(node);
  },
  regExp: HEADING_REGEX,
  replace: createBlockNode((match) => {
    const tag = ('h' + match[1].length) as HeadingTagType;
    return $createHeadingNode(tag);
  }),
  type: 'element',
};

export const QUOTE: ElementTransformer = {
  dependencies: [QuoteNode],
  export: (node, exportChildren) => {
    if (!$isQuoteNode(node)) {
      return null;
    }

    const lines = exportChildren(node).split('\n');
    const output = [];
    for (const line of lines) {
      output.push('> ' + line);
    }
    return output.join('\n');
  },
  regExp: QUOTE_REGEX,
  replace: (parentNode, children, _match, isImport) => {
    if (isImport) {
      const previousNode = parentNode.getPreviousSibling();
      if ($isQuoteNode(previousNode)) {
        previousNode.splice(previousNode.getChildrenSize(), 0, [
          $createLineBreakNode(),
          ...children,
        ]);
        parentNode.remove();
        return;
      }
    }

    const node = $createQuoteNode();
    node.append(...children);
    parentNode.replace(node);
    if (!isImport) {
      node.select(0, 0);
    }
  },
  type: 'element',
};

// Marker for code blocks without a language specification
// We use 'plain' because undefined/null/empty string all get converted to undefined by CodeNode,
// which Lexical then auto-sets to 'javascript'
const NO_LANGUAGE_MARKER = 'plain';

export const CODE: MultilineElementTransformer = {
  dependencies: [CodeNode],
  export: (node: LexicalNode) => {
    if (!$isCodeNode(node)) {
      return null;
    }
    const textContent = node.getTextContent();
    const language = node.getLanguage();
    // If language is our marker for no language, export without language
    const langOutput = (language === NO_LANGUAGE_MARKER) ? '' : (language || '');
    return (
      '```' +
      langOutput +
      (textContent ? '\n' + textContent : '') +
      '\n' +
      '```'
    );
  },
  regExpEnd: {
    optional: true,
    regExp: CODE_END_REGEX,
  },
  regExpStart: CODE_START_REGEX,
  replace: (
    rootNode,
    children,
    startMatch,
    endMatch,
    linesInBetween,
    isImport,
  ) => {
    let codeBlockNode: CodeNode;
    let code: string;

    if (!children && linesInBetween) {
      if (linesInBetween.length === 1) {
        // Single-line code blocks
        if (endMatch) {
          // End match on same line. Example: ```markdown hello```. markdown should not be considered the language here.
          codeBlockNode = $createCodeNode(NO_LANGUAGE_MARKER);
          code = startMatch[1] + linesInBetween[0];
        } else {
          // No end match. We should assume the language is next to the backticks and that code will be typed on the next line in the future
          codeBlockNode = $createCodeNode(startMatch[1] || NO_LANGUAGE_MARKER);
          code = linesInBetween[0].startsWith(' ')
            ? linesInBetween[0].slice(1)
            : linesInBetween[0];
        }
      } else {
        // Treat multi-line code blocks as if they always have an end match
        codeBlockNode = $createCodeNode(startMatch[1] || NO_LANGUAGE_MARKER);

        if (linesInBetween[0].trim().length === 0) {
          // Filter out all start and end lines that are length 0 until we find the first line with content
          while (linesInBetween.length > 0 && !linesInBetween[0].length) {
            linesInBetween.shift();
          }
        } else {
          // The first line already has content => Remove the first space of the line if it exists
          linesInBetween[0] = linesInBetween[0].startsWith(' ')
            ? linesInBetween[0].slice(1)
            : linesInBetween[0];
        }

        // Filter out all end lines that are length 0 until we find the last line with content
        while (
          linesInBetween.length > 0 &&
          !linesInBetween[linesInBetween.length - 1].length
        ) {
          linesInBetween.pop();
        }

        code = linesInBetween.join('\n');
      }
      const textNode = $createTextNode(code);
      codeBlockNode.append(textNode);
      rootNode.append(codeBlockNode);
    } else if (children) {
      createBlockNode((match) => {
        return $createCodeNode(match && match[1] ? match[1] : NO_LANGUAGE_MARKER);
      })(rootNode, children, startMatch, isImport);
    }
  },
  type: 'multiline-element',
};

// Re-export list transformers from ListTransformers module
export { UNORDERED_LIST, ORDERED_LIST, CHECK_LIST };

// Re-export upstream text-format transformers verbatim. These are pure data
// declarations identical to the values in `@lexical/markdown@0.44.0`; we
// re-export them so existing imports of `BOLD_STAR` etc. from this module
// keep working without dragging in the rest of the upstream surface.
export const INLINE_CODE: TextFormatTransformer = UPSTREAM_INLINE_CODE;
export const HIGHLIGHT: TextFormatTransformer = UPSTREAM_HIGHLIGHT;
export const BOLD_ITALIC_STAR: TextFormatTransformer = UPSTREAM_BOLD_ITALIC_STAR;
export const BOLD_ITALIC_UNDERSCORE: TextFormatTransformer =
  UPSTREAM_BOLD_ITALIC_UNDERSCORE;
export const BOLD_STAR: TextFormatTransformer = UPSTREAM_BOLD_STAR;
export const BOLD_UNDERSCORE: TextFormatTransformer = UPSTREAM_BOLD_UNDERSCORE;
export const STRIKETHROUGH: TextFormatTransformer = UPSTREAM_STRIKETHROUGH;
export const ITALIC_STAR: TextFormatTransformer = UPSTREAM_ITALIC_STAR;
export const ITALIC_UNDERSCORE: TextFormatTransformer =
  UPSTREAM_ITALIC_UNDERSCORE;

// Order of text transformers matters:
//
// - code should go first as it prevents any transformations inside
// - then longer tags match (e.g. ** or __ should go before * or _)
export const LINK: TextMatchTransformer = {
  dependencies: [LinkNode],
  export: (node, exportChildren, exportFormat) => {
    if (!$isLinkNode(node) || $isAutoLinkNode(node)) {
      return null;
    }
    const title = node.getTitle();

    const textContent = exportChildren(node);

    const linkContent = title
      ? `[${textContent}](${node.getURL()} "${title}")`
      : `[${textContent}](${node.getURL()})`;

    return linkContent;
  },
  // Note: These regexes must NOT match:
  // 1. Images like ![alt](src) - handled by negative lookbehind (?<!!)
  // 2. Linked images like [![alt](src)](url) - handled by negative lookahead (?!!\[)
  //
  // The URL capture group accepts a leading `<` and trailing `>` because the
  // CommonMark spec allows `[text](<url>)` to delimit URLs that contain
  // spaces, balanced parens, or special characters (e.g. Obsidian emits this
  // form for timestamp-anchor links like `[Link](<https://example.com/path?t=13m43s>)`).
  // The angle brackets are delimiters per CommonMark, NOT part of the URL,
  // so the captured value is unwrapped in `replace` before being passed to
  // `$createLinkNode`. Without this strip the LinkNode would carry an href
  // of `<https://...>` which browsers reject as malformed, and the editor
  // would render the link text as unclickable raw text. See nimbalyst#86.
  importRegExp:
    /(?<!!)(?:\[(?!!\[)([^\]]+)\])(?:\(([^\s\)]+)(?:\s+"([^"]*)")?\))/,
  regExp:
    /(?<!!)(?:\[(?!!\[)([^\]]+)\])(?:\(([^\s\)]+)(?:\s+"([^"]*)")?\))$/,
  replace: (textNode, match) => {
    const [, linkText, rawUrl, linkTitle] = match;
    // CommonMark `<url>` form: strip the angle-bracket delimiters before
    // constructing the LinkNode so the href is a real URL.
    const linkUrl =
      rawUrl && rawUrl.startsWith('<') && rawUrl.endsWith('>')
        ? rawUrl.slice(1, -1)
        : rawUrl;
    const linkNode = $createLinkNode(linkUrl, {title: linkTitle});
    const linkTextNode = $createTextNode(linkText);
    linkTextNode.setFormat(textNode.getFormat());
    linkNode.append(linkTextNode);
    textNode.replace(linkNode);

    return linkTextNode;
  },
  trigger: ')',
  type: 'text-match',
};

