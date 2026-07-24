/**
 * MermaidTransformer - Handles markdown import/export for Mermaid diagrams
 */

import { MultilineElementTransformer } from '@lexical/markdown';
import { $createMermaidNode, $isMermaidNode, MermaidNode } from './MermaidNode';

const MERMAID_START_REGEX = /^[ \t]*```mermaid/;
const MERMAID_END_REGEX = /[ \t]*```$/;

export const MERMAID_TRANSFORMER: MultilineElementTransformer = {
  dependencies: [MermaidNode],
  export: (node) => {
    if (!$isMermaidNode(node)) {
      return null;
    }

    const content = node.getContent();
    return '```mermaid\n' + content + '\n```';
  },
  regExpStart: MERMAID_START_REGEX,
  regExpEnd: {
    optional: true,
    regExp: MERMAID_END_REGEX,
  },
  replace: (rootNode, children, startMatch, endMatch, linesInBetween) => {
    // Join all the lines between the start and end markers
    const content = linesInBetween ? linesInBetween.join('\n').trim() : '';
    const mermaidNode = $createMermaidNode({ content });
    rootNode.append(mermaidNode);
  },
  type: 'multiline-element',
};