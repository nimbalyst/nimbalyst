/**
 * Markdown transformer for `TextColorNode`.
 *
 * Import: Lexical finds the earliest text-match among all transformers with
 * `String.prototype.match(importRegExp)`. A regex cannot balance nested
 * spans, so `importRegExp` is a RegExp whose `exec` runs the span scanner from
 * `textColorSyntax.ts`. `replace` wraps the span's content in a TextColorNode
 * and returns that text node, so Lexical keeps importing the emphasis, links
 * and code inside it (upstream applies a text match that wraps a text format
 * before the format).
 *
 * The span starts before the `#` of a hex color in its style attribute, so it
 * wins over the hashtag transformer for that offset.
 *
 * React-, DOM- and CSS-free (headless body transformers load it).
 */

import type { TextMatchTransformer } from '@lexical/markdown';
import { $createTextNode, type ElementNode, type LexicalNode, type TextNode } from 'lexical';

import { $createTextColorNode, $isTextColorNode, TextColorNode } from './TextColorNode';
import {
  findInlineColorSpan,
  formatTextColorSpan,
  type InlineColorSpan,
} from '../../../core/textColorSyntax';

interface ColorSpanExecArray extends RegExpExecArray {
  colorSpan?: InlineColorSpan;
}

/** `exec` finds the next balanced colored span; group 1 = the span's content. */
class ColorSpanRegExp extends RegExp {
  constructor() {
    // The pattern only documents the shape; `exec` does the matching.
    super(String.raw`<span\s+style="[^"]*">(.+)</span>`);
  }

  exec(text: string): ColorSpanExecArray | null {
    const span = findInlineColorSpan(text, 0);
    if (!span) return null;
    const result = [
      text.slice(span.start, span.end),
      text.slice(span.innerStart, span.innerEnd),
    ] as unknown as ColorSpanExecArray;
    result.index = span.start;
    result.input = text;
    result.colorSpan = span;
    return result;
  }
}

const COLOR_SPAN_IMPORT_REGEXP = new ColorSpanRegExp();
/** Never fires while typing: colors are set from the toolbar, not typed. */
const NEVER = /(?!)/;

export const TEXT_COLOR_TRANSFORMER: TextMatchTransformer = {
  dependencies: [TextColorNode],
  export: (node: LexicalNode, exportChildren: (node: ElementNode) => string) => {
    if (!$isTextColorNode(node)) return null;
    return formatTextColorSpan(exportChildren(node), node.getTextColorStyle(), node.getRawOpenTag());
  },
  importRegExp: COLOR_SPAN_IMPORT_REGEXP,
  regExp: NEVER,
  replace: (textNode: TextNode, match: RegExpMatchArray) => {
    const span = (match as ColorSpanExecArray).colorSpan ?? findInlineColorSpan(match[0]);
    if (!span) return;
    const inner = $createTextNode(match[1]);
    inner.setFormat(textNode.getFormat());
    const colored = $createTextColorNode(span.style, span.openTag);
    colored.append(inner);
    textNode.replace(colored);
    return inner;
  },
  trigger: '>',
  type: 'text-match',
};
