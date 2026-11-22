/**
 * Nodes for the Nimbalyst editor that are NOT already registered by an
 * extension's `nodes` list. Block / inline node classes that ship with a
 * dedicated extension (image, mermaid, page break, layout, collapsible,
 * kanban board, list, link, auto-link, horizontal rule) flow through that
 * extension's registration instead.
 */

import type { Klass, LexicalNode } from 'lexical';

// code-core, not @lexical/code: the latter loads prismjs at import time, and
// these classes are the same objects either way.
import { CodeHighlightNode, CodeNode } from '@lexical/code-core';
import { HashtagNode } from '@lexical/hashtag';
import { MarkNode } from '@lexical/mark';
import { OverflowNode } from '@lexical/overflow';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table';

import { EmojiNode } from '../plugins/EmojisPlugin/EmojiNode';
import { TextColorNode } from '../plugins/TextColorPlugin/TextColorNode';

const EditorNodes: Array<Klass<LexicalNode>> = [
  HeadingNode,
  QuoteNode,
  CodeNode,
  CodeHighlightNode,
  TableNode,
  TableCellNode,
  TableRowNode,
  HashtagNode,
  OverflowNode,
  EmojiNode,
  MarkNode,
  TextColorNode,
];

export default EditorNodes;
