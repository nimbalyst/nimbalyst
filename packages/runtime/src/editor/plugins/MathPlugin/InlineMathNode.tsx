/**
 * InlineMathNode - A Lexical DecoratorNode for rendering inline math ($...$)
 */

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
import React from 'react';

export interface InlineMathPayload {
  equation: string;
  key?: NodeKey;
}

export type SerializedInlineMathNode = Spread<
  {
    equation: string;
  },
  SerializedLexicalNode
>;

export class InlineMathNode extends DecoratorNode<JSX.Element> {
  __equation: string;

  constructor(equation: string, key?: NodeKey) {
    super(key);
    this.__equation = equation;
  }

  static getType(): string {
    return 'math-inline';
  }

  static clone(node: InlineMathNode): InlineMathNode {
    return new InlineMathNode(node.__equation, node.__key);
  }

  isInline(): boolean {
    return true;
  }

  static importJSON(serializedNode: SerializedInlineMathNode): InlineMathNode {
    const { equation } = serializedNode;
    return $createInlineMathNode({ equation });
  }

  exportJSON(): SerializedInlineMathNode {
    return {
      equation: this.__equation,
      type: 'math-inline',
      version: 1,
    };
  }

  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const span = document.createElement('span');
    span.className = 'math-inline-container';
    return span;
  }

  updateDOM(_prevNode: InlineMathNode, _dom: HTMLElement): boolean {
    return _prevNode.__equation !== this.__equation;
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const element = document.createElement('span');
    element.classList.add('math-inline-container');
    element.setAttribute('data-math-inline', this.__equation);

    const code = document.createElement('code');
    code.className = 'language-math-inline';
    code.textContent = this.__equation;
    element.appendChild(code);

    return { element };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (domNode: HTMLElement) => {
        if (!domNode.classList.contains('math-inline-container')) {
          return null;
        }
        return {
          conversion: convertInlineMathElement,
          priority: 1,
        };
      },
    };
  }

  getEquation(): string {
    return this.__equation;
  }

  getTextContent(): string {
    return this.__equation;
  }

  setEquation(equation: string): void {
    const writable = this.getWritable();
    writable.__equation = equation;
  }

  decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element {
    return (
      <MathInlineComponent
        equation={this.__equation}
        nodeKey={this.__key}
      />
    );
  }
}

function convertInlineMathElement(domNode: HTMLElement): DOMConversionOutput | null {
  const equation = domNode.getAttribute('data-math-inline');
  if (equation) {
    const node = $createInlineMathNode({ equation });
    return { node };
  }
  const codeElement = domNode.querySelector('code.language-math-inline');
  if (codeElement) {
    const node = $createInlineMathNode({ equation: codeElement.textContent || '' });
    return { node };
  }
  return null;
}

// Lazy-loaded component
const MathInlineComponent = React.lazy(() =>
  import('./MathComponent').then((mod) => ({ default: mod.MathInlineComponent }))
);

export function $createInlineMathNode(payload?: InlineMathPayload): InlineMathNode {
  const equation = payload?.equation || 'x^2';
  return $applyNodeReplacement(new InlineMathNode(equation, payload?.key));
}

export function $isInlineMathNode(
  node: LexicalNode | null | undefined
): node is InlineMathNode {
  return node instanceof InlineMathNode;
}
