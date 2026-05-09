/**
 * MathNode - A Lexical DecoratorNode for rendering block math ($$...$$)
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
import { addClassNamesToElement } from '@lexical/utils';
import React from 'react';

export interface MathBlockPayload {
  equation: string;
  key?: NodeKey;
}

export type SerializedMathNode = Spread<
  {
    equation: string;
  },
  SerializedLexicalNode
>;

export class MathNode extends DecoratorNode<JSX.Element> {
  __equation: string;

  constructor(equation: string, key?: NodeKey) {
    super(key);
    this.__equation = equation;
  }

  static getType(): string {
    return 'math-block';
  }

  static clone(node: MathNode): MathNode {
    return new MathNode(node.__equation, node.__key);
  }

  static importJSON(serializedNode: SerializedMathNode): MathNode {
    const { equation } = serializedNode;
    return $createMathNode({ equation });
  }

  exportJSON(): SerializedMathNode {
    return {
      equation: this.__equation,
      type: 'math-block',
      version: 1,
    };
  }

  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const div = document.createElement('div');
    addClassNamesToElement(div, 'math-block-container');
    return div;
  }

  updateDOM(_prevNode: MathNode, _dom: HTMLElement): boolean {
    return _prevNode.__equation !== this.__equation;
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const element = document.createElement('div');
    element.classList.add('math-block-container');

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.classList.add('language-math');
    code.textContent = this.__equation;
    pre.appendChild(code);
    element.appendChild(pre);

    return { element };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode: HTMLElement) => {
        if (!domNode.classList.contains('math-block-container')) {
          return null;
        }
        return {
          conversion: convertMathBlockElement,
          priority: 1,
        };
      },
    };
  }

  getEquation(): string {
    return this.__equation;
  }

  /**
   * Override getTextContent to return the equation content.
   * Critical for the diff system to properly compare math nodes.
   */
  getTextContent(): string {
    return this.__equation;
  }

  setEquation(equation: string): void {
    const writable = this.getWritable();
    writable.__equation = equation;
  }

  decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element {
    return (
      <MathBlockComponent
        equation={this.__equation}
        nodeKey={this.__key}
      />
    );
  }
}

function convertMathBlockElement(domNode: HTMLElement): DOMConversionOutput | null {
  const codeElement = domNode.querySelector('code.language-math');
  if (codeElement) {
    const equation = codeElement.textContent || '';
    const node = $createMathNode({ equation });
    return { node };
  }
  return null;
}

// Lazy-loaded component to avoid bundling KaTeX when not needed
const MathBlockComponent = React.lazy(() =>
  import('./MathComponent').then((mod) => ({ default: mod.MathBlockComponent }))
);

export function $createMathNode(payload?: MathBlockPayload): MathNode {
  const equation = payload?.equation || 'E = mc^2';
  return $applyNodeReplacement(new MathNode(equation, payload?.key));
}

export function $isMathNode(
  node: LexicalNode | null | undefined
): node is MathNode {
  return node instanceof MathNode;
}
