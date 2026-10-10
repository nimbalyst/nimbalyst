/**
 * ActionButtonNode -- a button block from an ```action fence (start an agent
 * session) or a ```new-item fence (create a typed page under this page). One
 * class for both: they share everything but the fence name and what a click
 * asks the host to do. The fence body is kept verbatim
 * (`actionButtonSource.ts` describes the keys).
 *
 * React-free: `./ActionButtonNode.tsx` registers the React decorator and
 * re-exports this module; headless graphs (collab worker, CLI) import this one
 * directly. See `nodeDecoratorSlot.ts`.
 */

import type { JSX } from 'react';
import type { MultilineElementTransformer } from '@lexical/markdown';
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
import {
  createFencedBlockTransformer,
  exportFencedBlockDOM,
  importFencedBlockDOM,
} from '../fencedBlock/fencedBlockTransformer';
import {
  ACTION_FENCE_BY_KIND,
  type ActionButtonKind,
  NEW_ITEM_ACTION_FENCE,
  SESSION_ACTION_FENCE,
} from './actionButtonFences';

export interface ActionButtonPayload {
  kind: ActionButtonKind;
  source?: string;
  key?: NodeKey;
}

export type SerializedActionButtonNode = Spread<{ kind: ActionButtonKind; source: string }, SerializedLexicalNode>;

export const ActionButtonNodeDecorator = createNodeDecoratorSlot<ActionButtonNode>();

export class ActionButtonNode extends DecoratorNode<JSX.Element | null> {
  __kind: ActionButtonKind;
  __source: string;

  constructor(kind: ActionButtonKind, source: string, key?: NodeKey) {
    super(key);
    this.__kind = kind;
    this.__source = source;
  }

  static getType(): string {
    return 'action-button';
  }

  static clone(node: ActionButtonNode): ActionButtonNode {
    return new ActionButtonNode(node.__kind, node.__source, node.__key);
  }

  static importJSON(serializedNode: SerializedActionButtonNode): ActionButtonNode {
    return $createActionButtonNode({
      kind: serializedNode.kind === 'new-item' ? 'new-item' : 'session',
      source: serializedNode.source,
    });
  }

  exportJSON(): SerializedActionButtonNode {
    return { type: 'action-button', version: 1, kind: this.__kind, source: this.__source };
  }

  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const div = document.createElement('div');
    div.className = 'action-button-container';
    return div;
  }

  updateDOM(): boolean {
    return false;
  }

  exportDOM(): DOMExportOutput {
    return exportFencedBlockDOM(ACTION_FENCE_BY_KIND[this.__kind], this.__source);
  }

  static importDOM(): DOMConversionMap | null {
    const session = importFencedBlockDOM(SESSION_ACTION_FENCE, (source) => $createActionButtonNode({ kind: 'session', source }));
    const newItem = importFencedBlockDOM(NEW_ITEM_ACTION_FENCE, (source) => $createActionButtonNode({ kind: 'new-item', source }));
    return { pre: (domNode: HTMLElement) => session.pre!(domNode) ?? newItem.pre!(domNode) };
  }

  getKind(): ActionButtonKind {
    return this.getLatest().__kind;
  }

  getSource(): string {
    return this.getLatest().__source;
  }

  setSource(source: string): void {
    this.getWritable().__source = source;
  }

  getTextContent(): string {
    return this.__source;
  }

  isInline(): false {
    return false;
  }

  decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element | null {
    return ActionButtonNodeDecorator.decorate(this, editor, config);
  }
}

export function $createActionButtonNode(payload: ActionButtonPayload): ActionButtonNode {
  return $applyNodeReplacement(new ActionButtonNode(payload.kind, payload.source ?? '', payload.key));
}

export function $isActionButtonNode(node: LexicalNode | null | undefined): node is ActionButtonNode {
  return node instanceof ActionButtonNode;
}

function transformerFor(kind: ActionButtonKind): MultilineElementTransformer {
  return createFencedBlockTransformer({
    language: ACTION_FENCE_BY_KIND[kind],
    node: ActionButtonNode,
    isNode: (node): node is ActionButtonNode => $isActionButtonNode(node) && node.getKind() === kind,
    getSource: (node) => node.getSource(),
    create: (source) => $createActionButtonNode({ kind, source }),
  });
}

export const ACTION_BUTTON_TRANSFORMERS: MultilineElementTransformer[] = [
  transformerFor('session'),
  transformerFor('new-item'),
];
