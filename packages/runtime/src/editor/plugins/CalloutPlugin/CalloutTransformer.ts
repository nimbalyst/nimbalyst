/**
 * Markdown import/export for callouts, in GitHub alert syntax:
 *
 *   > [!WARNING] Optional custom title
 *   > Body markdown, which may hold lists, headings and nested quotes.
 *   >
 *   > - item
 *
 * Parameterized by the transformer set used for the body, like
 * `createTableTransformer`: the editor passes the live extension set, the
 * headless body writer its fixed built-in set. This module imports neither,
 * so it stays loadable without React.
 *
 * A multiline transformer, so it is tried before the element-level QUOTE
 * transformer; a `>` quote without a `[!TYPE]` marker is left to QUOTE.
 */

import type { MultilineElementTransformer, Transformer } from '@lexical/markdown';
import { $createParagraphNode, type LexicalNode } from 'lexical';

import { $convertNodeToEnhancedMarkdownString } from '../../markdown/EnhancedMarkdownExport';
import { $convertFromEnhancedMarkdownString } from '../../markdown/EnhancedMarkdownImport';
import { $createCalloutNode, $isCalloutNode, CalloutNode, type CalloutType } from './CalloutNode';

const CALLOUT_START_REGEX = /^>[ \t]?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+(.*?))?[ \t]*$/i;
const QUOTE_LINE_REGEX = /^>[ \t]?/;

export function createCalloutTransformer(
  getTransformers: () => Transformer[],
): MultilineElementTransformer {
  return {
    dependencies: [CalloutNode],
    export: (node: LexicalNode) => {
      if (!$isCalloutNode(node)) return null;
      const title = node.getTitle();
      const header = `> [!${node.getCalloutType().toUpperCase()}]${title ? ` ${title}` : ''}`;
      const body = $convertNodeToEnhancedMarkdownString(getTransformers(), node);
      if (!body) return header;
      const lines = body.split('\n').map((line) => (line ? `> ${line}` : '>'));
      return [header, ...lines].join('\n');
    },
    regExpStart: CALLOUT_START_REGEX,
    regExpEnd: undefined,
    handleImportAfterStartMatch: ({ lines, rootNode, startLineIndex, startMatch }) => {
      // GitHub reads the marker only on a quote's first line; mid-quote it is text.
      if (startLineIndex > 0 && QUOTE_LINE_REGEX.test(lines[startLineIndex - 1])) return null;
      let endLineIndex = startLineIndex;
      const bodyLines: string[] = [];
      while (endLineIndex + 1 < lines.length && QUOTE_LINE_REGEX.test(lines[endLineIndex + 1])) {
        endLineIndex++;
        bodyLines.push(lines[endLineIndex].replace(QUOTE_LINE_REGEX, ''));
      }

      const callout = $createCalloutNode(
        startMatch[1].toLowerCase() as CalloutType,
        (startMatch[2] ?? '').trim(),
      );
      const body = bodyLines.join('\n').replace(/^\n+|\n+$/g, '');
      if (body) {
        $convertFromEnhancedMarkdownString(body, getTransformers(), callout, true, false);
      }
      if (callout.isEmpty()) callout.append($createParagraphNode());
      rootNode.append(callout);
      return [true, endLineIndex];
    },
    replace: () => false,
    type: 'multiline-element',
  };
}
