/**
 * Page Break transformer for markdown
 */

import { ElementTransformer } from '@lexical/markdown';
import { LexicalNode } from 'lexical';
import { $createPageBreakNode, $isPageBreakNode, PageBreakNode } from './PageBreakNode';

export const PAGE_BREAK_TRANSFORMER: ElementTransformer = {
  dependencies: [PageBreakNode],
  export: (node: LexicalNode) => {
    return $isPageBreakNode(node) ? '<div style="page-break-after: always;"></div>' : null;
  },
  regExp: /^<div style="page-break-after:\s*always;">\s*<\/div>\s*$/,
  replace: (parentNode, _1, _2, isImport) => {
    const pageBreak = $createPageBreakNode();

    if (isImport || parentNode.getNextSibling() != null) {
      parentNode.replace(pageBreak);
    } else {
      parentNode.insertBefore(pageBreak);
    }

    pageBreak.selectNext();
  },
  type: 'element',
};
