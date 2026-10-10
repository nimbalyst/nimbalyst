/**
 * ChartNode -- the chart block (a ```chart fence). It stores the fence body
 * verbatim; the body compiles to a Vega-Lite spec at render time
 * (`chartSpec.ts`), so keys this version does not read survive a save.
 *
 * React-free: `./ChartNode.tsx` registers the React decorator and re-exports
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

import { createNodeDecoratorSlot } from '../../nodes/nodeDecoratorSlot';
import { exportFencedBlockDOM, importFencedBlockDOM } from '../fencedBlock/fencedBlockTransformer';

export const CHART_FENCE_LANGUAGE = 'chart';

/** What a new block holds; the format is described in `chartSpec.ts`. */
export const DEFAULT_CHART_SOURCE = [
  'type: bar',
  'title: Sessions per week',
  'x: week',
  'y: [desktop, web]',
  'data: |',
  '  week,desktop,web',
  '  W36,120,14',
  '  W37,131,22',
  '  W38,142,30',
].join('\n');

export interface ChartPayload {
  source?: string;
  key?: NodeKey;
}

export type SerializedChartNode = Spread<{ source: string }, SerializedLexicalNode>;

export const ChartNodeDecorator = createNodeDecoratorSlot<ChartNode>();

export class ChartNode extends DecoratorNode<JSX.Element | null> {
  __source: string;

  constructor(source: string, key?: NodeKey) {
    super(key);
    this.__source = source;
  }

  static getType(): string {
    return 'chart';
  }

  static clone(node: ChartNode): ChartNode {
    return new ChartNode(node.__source, node.__key);
  }

  static importJSON(serializedNode: SerializedChartNode): ChartNode {
    return $createChartNode({ source: serializedNode.source });
  }

  exportJSON(): SerializedChartNode {
    return { type: 'chart', version: 1, source: this.__source };
  }

  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const div = document.createElement('div');
    div.className = 'chart-container';
    return div;
  }

  updateDOM(): boolean {
    return false;
  }

  exportDOM(): DOMExportOutput {
    return exportFencedBlockDOM(CHART_FENCE_LANGUAGE, this.__source);
  }

  static importDOM(): DOMConversionMap | null {
    return importFencedBlockDOM(CHART_FENCE_LANGUAGE, (source) => $createChartNode({ source }));
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
    return ChartNodeDecorator.decorate(this, editor, config);
  }
}

export function $createChartNode(payload?: ChartPayload): ChartNode {
  return $applyNodeReplacement(new ChartNode(payload?.source ?? DEFAULT_CHART_SOURCE, payload?.key));
}

export function $isChartNode(node: LexicalNode | null | undefined): node is ChartNode {
  return node instanceof ChartNode;
}
