/**
 * Markdown transformer for `CitationNode`: a human citation link or a link
 * titled `cite` (see `core/citationSyntax.ts`, which owns every citation URL).
 *
 * A source citation is shaped like any other link, so a plain regex would
 * claim ordinary links too, and Lexical leaves a claimed link it cannot
 * replace as literal text. `importRegExp` is therefore a RegExp whose `exec`
 * returns only links that parse as citations.
 *
 * Must precede the core LINK transformer and the reference transformers.
 * React-, DOM- and CSS-free (headless body transformers load it).
 */

import type { TextMatchTransformer } from '@lexical/markdown';
import type { LexicalNode, TextNode } from 'lexical';

import { $createCitationNode, $isCitationNode, CitationNode } from './CitationNodeCore';
import { findInlineCitation, formatCitationMarkdown, type InlineCitationMatch } from '../../../core/citationSyntax';

interface CitationExecArray extends RegExpExecArray {
  citationMatch?: InlineCitationMatch;
}

class CitationRegExp extends RegExp {
  constructor() {
    // The pattern only documents the shape; `exec` does the matching.
    super(String.raw`\[[^\]]*\]\([^)]*\)`);
  }

  exec(text: string): CitationExecArray | null {
    const match = findInlineCitation(text, 0);
    if (!match) return null;
    const result = [text.slice(match.start, match.end)] as unknown as CitationExecArray;
    result.index = match.start;
    result.input = text;
    result.citationMatch = match;
    return result;
  }
}

/** Never fires while typing: citations come from markdown, not keystrokes. */
const NEVER = /(?!)/;

export const CITATION_TRANSFORMER: TextMatchTransformer = {
  dependencies: [CitationNode],
  export: (node: LexicalNode) => {
    if (!$isCitationNode(node)) return null;
    return formatCitationMarkdown(node.getCitation(), node.getRawTitle(), node.getRawHref());
  },
  importRegExp: new CitationRegExp(),
  regExp: NEVER,
  replace: (textNode: TextNode, match: RegExpMatchArray) => {
    const found = (match as CitationExecArray).citationMatch ?? findInlineCitation(match[0]);
    if (!found) return;
    textNode.replace($createCitationNode(found.citation, found.rawTitle, found.rawHref));
  },
  trigger: ')',
  type: 'text-match',
};
