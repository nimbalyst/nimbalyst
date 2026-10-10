/**
 * The block contract for a named fence (```2x2, ```chart, ...): the node keeps
 * the fence body verbatim, so whatever the file said, including keys this
 * version does not model, comes back byte-identical on export. The block
 * parses the body at render time; it never re-serializes a parsed object.
 *
 * React-free, so a block's transformer can sit in the headless transformer set
 * (`headlessBodyTransformers.ts`) the collab worker and CLI load.
 */

import type { MultilineElementTransformer } from '@lexical/markdown';
import type { DOMConversionMap, DOMExportOutput, Klass, LexicalNode } from 'lexical';

export interface FencedBlockTransformerOptions<T extends LexicalNode> {
  /** The fence info string, e.g. `chart` for ```chart. */
  language: string;
  node: Klass<T>;
  isNode: (node: LexicalNode | null | undefined) => node is T;
  getSource: (node: T) => string;
  create: (source: string) => T;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A backtick fence longer than every backtick run in `source`, so no line of
 * the body can close it.
 */
export function fenceDelimiterFor(source: string): string {
  const longest = Math.max(0, ...(source.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * Fences follow CommonMark: the opener is three or more backticks or tildes,
 * and only a line of the same character, at least as long, closes it. The
 * body between is kept verbatim, blank lines included. An unterminated fence
 * runs to the end of the document, as CommonMark (and the code-block
 * transformer) do: a block that renders broken is recoverable, one that
 * vanishes into a code block is not.
 */
export function createFencedBlockTransformer<T extends LexicalNode>(
  options: FencedBlockTransformerOptions<T>,
): MultilineElementTransformer {
  const { language, node, isNode, getSource, create } = options;
  return {
    dependencies: [node],
    export: (candidate) => {
      if (!isNode(candidate)) return null;
      const source = getSource(candidate);
      const fence = fenceDelimiterFor(source);
      return `${fence}${language}\n${source}\n${fence}`;
    },
    regExpStart: new RegExp(`^[ \\t]*(\`{3,}|~{3,})${escapeRegExp(language)}[ \\t]*$`),
    // Unused on import (`handleImportAfterStartMatch` consumes the block); kept for the transformer shape.
    regExpEnd: { optional: true, regExp: /^[ \t]*(`{3,}|~{3,})[ \t]*$/ },
    handleImportAfterStartMatch: ({ lines, rootNode, startLineIndex, startMatch }) => {
      const opener = startMatch[1];
      const closer = new RegExp(`^[ \\t]*${opener[0] === '`' ? '`' : '~'}{${opener.length},}[ \\t]*$`);
      let end = startLineIndex + 1;
      while (end < lines.length && !closer.test(lines[end])) end += 1;
      rootNode.append(create(lines.slice(startLineIndex + 1, end).join('\n')));
      return [true, Math.min(end, lines.length - 1)];
    },
    replace: (rootNode, _children, _startMatch, _endMatch, linesInBetween) => {
      rootNode.append(create((linesInBetween ?? []).join('\n')));
    },
    type: 'multiline-element',
  };
}

/** Copy/paste as HTML: the block is a `pre > code.language-<fence>` holding the body. */
export function exportFencedBlockDOM(language: string, source: string): DOMExportOutput {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = `language-${language}`;
  code.textContent = source;
  pre.appendChild(code);
  return { element: pre };
}

/** The `pre > code.language-<fence>` that `exportFencedBlockDOM` writes, claimed ahead of the plain code-block import. */
export function importFencedBlockDOM(language: string, create: (source: string) => LexicalNode): DOMConversionMap {
  return {
    pre: (domNode: HTMLElement) => (domNode.querySelector(`:scope > code.language-${language}`)
      ? { conversion: (pre: HTMLElement) => ({ node: create(pre.textContent ?? '') }), priority: 2 }
      : null),
  };
}
