/**
 * CodeExcerptNode -- the code excerpt block (an ```excerpt fence). It stores
 * the fence body verbatim (`excerptSource.ts` describes the format), so header
 * keys this version does not read survive a save.
 *
 * React-free: `./CodeExcerptNode.tsx` registers the React decorator and
 * re-exports this module; headless graphs (collab worker, CLI) import this one
 * directly. See `nodeDecoratorSlot.ts`.
 */

import type { JSX } from 'react';
import {
  $applyNodeReplacement,
  $getNodeByKey,
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
import { CODE_EXCERPT_FENCE_LANGUAGE } from './excerptFence';

export interface CodeExcerptPayload {
  source?: string;
  key?: NodeKey;
}

export type SerializedCodeExcerptNode = Spread<{ source: string }, SerializedLexicalNode>;

export const CodeExcerptNodeDecorator = createNodeDecoratorSlot<CodeExcerptNode>();

export class CodeExcerptNode extends DecoratorNode<JSX.Element | null> {
  __source: string;

  constructor(source: string, key?: NodeKey) {
    super(key);
    this.__source = source;
  }

  static getType(): string {
    return 'code-excerpt';
  }

  static clone(node: CodeExcerptNode): CodeExcerptNode {
    return new CodeExcerptNode(node.__source, node.__key);
  }

  static importJSON(serializedNode: SerializedCodeExcerptNode): CodeExcerptNode {
    return $createCodeExcerptNode({ source: serializedNode.source });
  }

  exportJSON(): SerializedCodeExcerptNode {
    return { type: 'code-excerpt', version: 1, source: this.__source };
  }

  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const div = document.createElement('div');
    div.className = 'code-excerpt-container';
    return div;
  }

  updateDOM(): boolean {
    return false;
  }

  exportDOM(): DOMExportOutput {
    return exportFencedBlockDOM(CODE_EXCERPT_FENCE_LANGUAGE, this.__source);
  }

  static importDOM(): DOMConversionMap | null {
    return importFencedBlockDOM(CODE_EXCERPT_FENCE_LANGUAGE, (source) => $createCodeExcerptNode({ source }));
  }

  getSource(): string {
    return this.getLatest().__source;
  }

  setSource(source: string): void {
    this.getWritable().__source = source;
  }

  /** The fence body, so diffs and search see the quoted code. */
  getTextContent(): string {
    return this.__source;
  }

  isInline(): false {
    return false;
  }

  decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element | null {
    return CodeExcerptNodeDecorator.decorate(this, editor, config);
  }
}

export function $createCodeExcerptNode(payload?: CodeExcerptPayload): CodeExcerptNode {
  return $applyNodeReplacement(new CodeExcerptNode(payload?.source ?? '', payload?.key));
}

export function $isCodeExcerptNode(node: LexicalNode | null | undefined): node is CodeExcerptNode {
  return node instanceof CodeExcerptNode;
}

/**
 * Write `next` only if the block still holds `expected`, the source the
 * caller read before its async work. A teammate's edit in between wins; the
 * caller rereads instead of overwriting it. Returns whether it wrote.
 */
export function $replaceExcerptSource(key: NodeKey, expected: string, next: string): boolean {
  const node = $getNodeByKey(key);
  if (!$isCodeExcerptNode(node) || node.getSource() !== expected) return false;
  if (next !== expected) node.setSource(next);
  return true;
}
