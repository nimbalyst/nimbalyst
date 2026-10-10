/**
 * QuadrantNode -- the static 2x2 block (a ```2x2 fence). It stores the fence
 * body verbatim; the chart is drawn from it at render time.
 *
 * React-free: `./QuadrantNode.tsx` registers the React decorator and
 * re-exports this module; headless graphs (collab worker, CLI) import this one
 * directly. See `nodeDecoratorSlot.ts`.
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

import { createNodeDecoratorSlot } from '../../nodes/nodeDecoratorSlot';
import { exportFencedBlockDOM, importFencedBlockDOM } from '../fencedBlock/fencedBlockTransformer';

export const QUADRANT_FENCE_LANGUAGE = '2x2';

/** What a new block holds; the format is described in `quadrantFence.ts`. */
export const DEFAULT_QUADRANT_SOURCE = [
  'x: Low -> High',
  'y: Low -> High',
  'quadrants: Top left | Top right | Bottom left | Bottom right',
  '- First: 0.25, 0.75',
  '- Second: 0.7, 0.3 !',
].join('\n');

export interface QuadrantPayload {
  source?: string;
  key?: NodeKey;
}

export type SerializedQuadrantNode = Spread<{ source: string }, SerializedLexicalNode>;

export const QuadrantNodeDecorator = createNodeDecoratorSlot<QuadrantNode>();

export class QuadrantNode extends DecoratorNode<JSX.Element | null> {
  __source: string;

  constructor(source: string, key?: NodeKey) {
    super(key);
    this.__source = source;
  }

  static getType(): string {
    return 'quadrant';
  }

  static clone(node: QuadrantNode): QuadrantNode {
    return new QuadrantNode(node.__source, node.__key);
  }

  static importJSON(serializedNode: SerializedQuadrantNode): QuadrantNode {
    return $createQuadrantNode({ source: serializedNode.source });
  }

  exportJSON(): SerializedQuadrantNode {
    return { type: 'quadrant', version: 1, source: this.__source };
  }

  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const div = document.createElement('div');
    div.className = 'quadrant-container';
    return div;
  }

  updateDOM(): boolean {
    return false;
  }

  exportDOM(): DOMExportOutput {
    return exportFencedBlockDOM(QUADRANT_FENCE_LANGUAGE, this.__source);
  }

  static importDOM(): DOMConversionMap | null {
    return importFencedBlockDOM(QUADRANT_FENCE_LANGUAGE, (source) => $createQuadrantNode({ source }));
  }

  getSource(): string {
    return this.__source;
  }

  setSource(source: string): void {
    this.getWritable().__source = source;
  }

  /** The fence body, so diffs and search see the block's content. */
  getTextContent(): string {
    return this.__source;
  }

  isInline(): false {
    return false;
  }

  decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element | null {
    return QuadrantNodeDecorator.decorate(this, editor, config);
  }
}

export function $createQuadrantNode(payload?: QuadrantPayload): QuadrantNode {
  return $applyNodeReplacement(new QuadrantNode(payload?.source ?? DEFAULT_QUADRANT_SOURCE, payload?.key));
}

export function $isQuadrantNode(node: LexicalNode | null | undefined): node is QuadrantNode {
  return node instanceof QuadrantNode;
}
