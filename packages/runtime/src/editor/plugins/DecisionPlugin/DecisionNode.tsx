/**
 * `DecisionNode` -- an in-document decision: the ask, the answers, and the
 * sealed outcome, as one block that round-trips to a ```decision markdown fence.
 *
 * The node stores the **fence body verbatim**, not a parsed object. That is
 * deliberate: the markdown is the record, so anything the node cannot model
 * still survives a load/save cycle, and the serialization path has no chance to
 * invent a shape the file did not have. Parsing happens in the decorator, where
 * a malformed fence can be shown as a broken block instead of throwing inside a
 * Lexical transform.
 */

import type { JSX } from 'react';
import {
  $applyNodeReplacement,
  DecoratorNode,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { addClassNamesToElement } from '@lexical/utils';
import React from 'react';

export interface DecisionPayload {
  /** The fence body: YAML, without the surrounding ``` lines. */
  content: string;
  key?: NodeKey;
}

export type SerializedDecisionNode = Spread<
  {
    content: string;
  },
  SerializedLexicalNode
>;

/**
 * Pulls the block id out of a fence without a full YAML parse.
 *
 * `updateDOM` runs on every node update, including every vote, so it must not
 * pay for a parse. The id is the only thing it needs and it is always a plain
 * scalar on its own line.
 */
export function readDecisionIdFromFence(content: string): string {
  const match = /^[ \t]*id:[ \t]*(.+)$/m.exec(content);
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
}

export class DecisionNode extends DecoratorNode<JSX.Element> {
  __content: string;

  constructor(content: string, key?: NodeKey) {
    super(key);
    this.__content = content;
  }

  static getType(): string {
    return 'decision';
  }

  static clone(node: DecisionNode): DecisionNode {
    return new DecisionNode(node.__content, node.__key);
  }

  static importJSON(serializedNode: SerializedDecisionNode): DecisionNode {
    return $createDecisionNode({ content: serializedNode.content ?? '' });
  }

  exportJSON(): SerializedDecisionNode {
    return {
      content: this.__content,
      type: 'decision',
      version: 1,
    };
  }

  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const div = document.createElement('div');
    addClassNamesToElement(div, 'decision-container');
    return div;
  }

  /**
   * Recreate the DOM only when this is a different decision.
   *
   * Returning `true` makes Lexical destroy and rebuild the container, which
   * unmounts the React subtree and throws away everything it was holding -- an
   * open reorder drag, a half-typed `editText` proposal, the expanded state of
   * a sealed block. Votes and seals change `__content` constantly, and none of
   * them make this a different block, so only a changed id qualifies. Everything
   * else reaches the UI through the ordinary decorator re-render.
   */
  updateDOM(prevNode: DecisionNode, _dom: HTMLElement): boolean {
    return readDecisionIdFromFence(prevNode.__content) !== readDecisionIdFromFence(this.__content);
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const element = document.createElement('div');
    element.classList.add('decision-container');
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.classList.add('language-decision');
    code.textContent = this.__content;
    pre.appendChild(code);
    element.appendChild(pre);
    return { element };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode: HTMLElement) => {
        if (!domNode.classList.contains('decision-container')) return null;
        return { conversion: convertDecisionElement, priority: 1 };
      },
    };
  }

  getContent(): string {
    return this.__content;
  }

  /**
   * The diff system compares nodes by text content, so a block whose vote tally
   * or sealed outcome changed has to report the change here or the diff will
   * call two different decisions identical.
   */
  getTextContent(): string {
    return this.__content;
  }

  setContent(content: string): void {
    const writable = this.getWritable();
    writable.__content = content;
  }

  decorate(_editor: LexicalEditor, config: EditorConfig): JSX.Element {
    const embedBlockTheme = config.theme.embedBlock || {};
    return (
      <DecisionComponent
        className={embedBlockTheme.base || ''}
        content={this.__content}
        nodeKey={this.__key}
      />
    );
  }
}

function convertDecisionElement(domNode: HTMLElement): DOMConversionOutput | null {
  const codeElement = domNode.querySelector('code.language-decision');
  if (!codeElement) return null;
  return { node: $createDecisionNode({ content: codeElement.textContent || '' }) };
}

/**
 * Lazy so the six respond controls, their tally renderers, and dnd-kit stay out
 * of the initial bundle. The mobile editor deep-imports the editor precisely to
 * avoid dragging heavy renderers in, so this must not become eager.
 */
const DecisionComponent = React.lazy(() => import('./DecisionComponent'));

export function $createDecisionNode(payload: DecisionPayload): DecisionNode {
  return $applyNodeReplacement(new DecisionNode(payload.content, payload.key));
}

export function $isDecisionNode(
  node: LexicalNode | null | undefined
): node is DecisionNode {
  return node instanceof DecisionNode;
}
