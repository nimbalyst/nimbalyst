/**
 * MermaidNode - A Lexical node for rendering Mermaid diagrams
 *
 * React-free: `./MermaidNode.tsx` registers the React decorator and re-exports
 * this module; headless graphs (collab worker, CLI) import this one directly.
 * See `nodeDecoratorSlot.ts`.
 */

import type { JSX } from 'react';
import {
  $applyNodeReplacement,
  DecoratorNode,
  DOMConversionMap,
  DOMConversionOutput,
  DOMExportOutput,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical';
import { addClassNamesToElement } from '@lexical/utils';

import { createNodeDecoratorSlot } from '../../nodes/nodeDecoratorSlot';

export interface MermaidPayload {
  content: string;
  key?: NodeKey;
}

export type SerializedMermaidNode = Spread<
  {
    content: string;
  },
  SerializedLexicalNode
>;

export const MermaidNodeDecorator = createNodeDecoratorSlot<MermaidNode>();

export class MermaidNode extends DecoratorNode<JSX.Element | null> {
  __content: string;

  constructor(content: string, key?: NodeKey) {
    super(key);
    this.__content = content;
  }

  static getType(): string {
    return 'mermaid';
  }

  static clone(node: MermaidNode): MermaidNode {
    return new MermaidNode(node.__content, node.__key);
  }

  static importJSON(serializedNode: SerializedMermaidNode): MermaidNode {
    const { content } = serializedNode;
    return $createMermaidNode({ content });
  }

  exportJSON(): SerializedMermaidNode {
    return {
      content: this.__content,
      type: 'mermaid',
      version: 1,
    };
  }

  // Block-level: Lexical 0.53 wraps inline children of the root in a
  // paragraph, and DecoratorNode defaults to inline.
  isInline(): false {
    return false;
  }

  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const div = document.createElement('div');
    addClassNamesToElement(div, 'mermaid-container');
    return div;
  }

  updateDOM(_prevNode: MermaidNode, _dom: HTMLElement): boolean {
    // Return true to re-render if content changes
    return _prevNode.__content !== this.__content;
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const element = document.createElement('div');
    element.classList.add('mermaid-container');

    // Create a pre/code block for the mermaid content
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.classList.add('language-mermaid');
    code.textContent = this.__content;
    pre.appendChild(code);
    element.appendChild(pre);

    return { element };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode: HTMLElement) => {
        if (!domNode.classList.contains('mermaid-container')) {
          return null;
        }
        return {
          conversion: convertMermaidElement,
          priority: 1,
        };
      },
    };
  }

  getContent(): string {
    return this.__content;
  }

  /**
   * Override getTextContent to return the mermaid diagram content.
   * This is critical for the diff system to properly compare mermaid nodes
   * and detect content changes.
   */
  getTextContent(): string {
    return this.__content;
  }

  setContent(content: string): void {
    const writable = this.getWritable();
    writable.__content = content;
  }

  decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element | null {
    return MermaidNodeDecorator.decorate(this, editor, config);
  }
}

function convertMermaidElement(domNode: HTMLElement): DOMConversionOutput | null {
  const codeElement = domNode.querySelector('code.language-mermaid');
  if (codeElement) {
    const content = codeElement.textContent || '';
    const node = $createMermaidNode({ content });
    return { node };
  }
  return null;
}

export function $createMermaidNode(payload?: MermaidPayload): MermaidNode {
  const content = payload?.content || `graph TD
    A[Start] --> B{Is it working?}
    B -->|Yes| C[Great!]
    B -->|No| D[Debug]`;
  return $applyNodeReplacement(new MermaidNode(content, payload?.key));
}

export function $isMermaidNode(
  node: LexicalNode | null | undefined
): node is MermaidNode {
  return node instanceof MermaidNode;
}