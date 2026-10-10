/**
 * TocNode -- the inline table of contents (a ```toc fence). The node keeps the
 * fence body verbatim (`depth: 2`, plus any key a later version adds); the
 * heading list is read live from the editor at render time.
 *
 * React-free: `./TocNode.tsx` registers the React decorator and re-exports
 * this module; headless graphs (collab worker, CLI) import this one directly.
 * See `nodeDecoratorSlot.ts`.
 */

import type { JSX } from 'react';
import {
  $applyNodeReplacement,
  DecoratorNode,
  type DOMConversionMap,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import type { MultilineElementTransformer } from '@lexical/markdown';

import { createNodeDecoratorSlot } from '../../nodes/nodeDecoratorSlot';
import {
  createFencedBlockTransformer,
  exportFencedBlockDOM,
  importFencedBlockDOM,
} from '../fencedBlock/fencedBlockTransformer';

export const TOC_FENCE_LANGUAGE = 'toc';
export const DEFAULT_TOC_DEPTH = 3;

const DEPTH_LINE_REGEX = /^depth:[ \t]*(\S*)[ \t]*$/m;

/** The deepest heading level listed: `depth: N` in the body, 1-6, default 3. */
export function parseTocDepth(source: string): number {
  const value = Number(source.match(DEPTH_LINE_REGEX)?.[1]);
  return Number.isInteger(value) && value >= 1 && value <= 6 ? value : DEFAULT_TOC_DEPTH;
}

/** Rewrites only the `depth:` line, so other keys and their order survive. */
export function setTocDepth(source: string, depth: number): string {
  const line = `depth: ${depth}`;
  if (DEPTH_LINE_REGEX.test(source)) return source.replace(DEPTH_LINE_REGEX, line);
  return source ? `${line}\n${source}` : line;
}

export type SerializedTocNode = Spread<{ source: string }, SerializedLexicalNode>;

export const TocNodeDecorator = createNodeDecoratorSlot<TocNode>();

export class TocNode extends DecoratorNode<JSX.Element | null> {
  __source: string;

  constructor(source: string = '', key?: NodeKey) {
    super(key);
    this.__source = source;
  }

  static getType(): string {
    return 'toc';
  }

  static clone(node: TocNode): TocNode {
    return new TocNode(node.__source, node.__key);
  }

  static importJSON(serializedNode: SerializedTocNode): TocNode {
    return $createTocNode(serializedNode.source ?? '');
  }

  exportJSON(): SerializedTocNode {
    return { type: 'toc', version: 1, source: this.__source };
  }

  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const div = document.createElement('div');
    div.className = 'toc-container';
    return div;
  }

  updateDOM(): boolean {
    return false;
  }

  exportDOM(): DOMExportOutput {
    return exportFencedBlockDOM(TOC_FENCE_LANGUAGE, this.__source);
  }

  static importDOM(): DOMConversionMap | null {
    return importFencedBlockDOM(TOC_FENCE_LANGUAGE, $createTocNode);
  }

  isInline(): false {
    return false;
  }

  getSource(): string {
    return this.getLatest().__source;
  }

  setSource(source: string): this {
    const self = this.getWritable();
    self.__source = source;
    return self;
  }

  getTextContent(): string {
    return this.__source;
  }

  decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element | null {
    return TocNodeDecorator.decorate(this, editor, config);
  }
}

export function $createTocNode(source: string = ''): TocNode {
  return $applyNodeReplacement(new TocNode(source));
}

export function $isTocNode(node: LexicalNode | null | undefined): node is TocNode {
  return node instanceof TocNode;
}

const FENCED_TOC_TRANSFORMER = createFencedBlockTransformer({
  language: TOC_FENCE_LANGUAGE,
  node: TocNode,
  isNode: $isTocNode,
  getSource: (node) => node.getSource(),
  create: $createTocNode,
});

/** A bare fence with no options exports as two lines, not with a blank body line. */
export const TOC_TRANSFORMER: MultilineElementTransformer = {
  ...FENCED_TOC_TRANSFORMER,
  export: (node, traverseChildren) => {
    if ($isTocNode(node) && !node.getSource()) return `\`\`\`${TOC_FENCE_LANGUAGE}\n\`\`\``;
    return FENCED_TOC_TRANSFORMER.export?.(node, traverseChildren) ?? null;
  },
};
