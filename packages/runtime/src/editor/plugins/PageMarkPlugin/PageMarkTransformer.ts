/**
 * Markdown transformer for `PageMarkNode`.
 *
 * Import: Lexical finds the earliest text-match among all transformers with
 * `String.prototype.match(importRegExp)`. A regex cannot balance brackets, so
 * `importRegExp` is a RegExp whose `exec` runs the mark scanner from
 * `pageMarkSyntax.ts`. `replace` wraps the sentence's text in a mark and
 * returns that text node, so Lexical keeps importing the links, emphasis and
 * citations inside it.
 *
 * Must precede the core LINK transformer: a mark that opens with a link
 * (`[[Flagship](x) is ours]{decided}`) starts at the same offset as that link,
 * and Lexical keeps the first transformer on a tie.
 *
 * React-, DOM- and CSS-free (headless body transformers load it).
 */

import type { TextMatchTransformer } from '@lexical/markdown';
import { $createTextNode, $findMatchingParent, type ElementNode, type LexicalNode, type TextNode } from 'lexical';

import { $createPageMarkNode, $isPageMarkNode, PageMarkNode } from './PageMarkNode';
import { findInlinePageMark, formatPageMarkMarkdown, type PageMarkAttrs } from '../../../core/pageMarkSyntax';

interface PageMarkExecArray extends RegExpExecArray {
  pageMarkAttrs?: PageMarkAttrs;
}

/** `exec` finds the next balanced mark; groups: 1 = sentence, 2 = attribute block. */
class PageMarkRegExp extends RegExp {
  constructor() {
    // The pattern only documents the shape; `exec` does the matching.
    super(String.raw`\[(.+)\](\{(?:decided|open)[^}]*\})`);
  }

  exec(text: string): PageMarkExecArray | null {
    const match = findInlinePageMark(text, 0);
    if (!match) return null;
    const result = [
      text.slice(match.start, match.end),
      text.slice(match.innerStart, match.innerEnd),
      match.rawAttrs,
    ] as unknown as PageMarkExecArray;
    result.index = match.start;
    result.input = text;
    result.pageMarkAttrs = match.attrs;
    return result;
  }
}

const PAGE_MARK_IMPORT_REGEXP = new PageMarkRegExp();
/** Never fires while typing: marks are made from the toolbar, not typed. */
const NEVER = /(?!)/;

export const PAGE_MARK_TRANSFORMER: TextMatchTransformer = {
  dependencies: [PageMarkNode],
  export: (node: LexicalNode, exportChildren: (node: ElementNode) => string) => {
    if (!$isPageMarkNode(node)) return null;
    return formatPageMarkMarkdown(exportChildren(node), node.getAttrs(), node.getRawAttrs());
  },
  importRegExp: PAGE_MARK_IMPORT_REGEXP,
  regExp: NEVER,
  replace: (textNode: TextNode, match: RegExpMatchArray) => {
    // Marks do not nest; the inner text then stays literal.
    if ($findMatchingParent(textNode, $isPageMarkNode)) return;
    const attrs = (match as PageMarkExecArray).pageMarkAttrs ?? findInlinePageMark(match[0])?.attrs;
    if (!attrs) return;
    const inner = $createTextNode(match[1]);
    inner.setFormat(textNode.getFormat());
    const mark = $createPageMarkNode(attrs, match[2]);
    mark.append(inner);
    textNode.replace(mark);
    return inner;
  },
  trigger: '}',
  type: 'text-match',
};
