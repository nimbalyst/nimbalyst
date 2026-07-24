import type {
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
import type { JSX } from 'react';

import { $applyNodeReplacement, DecoratorNode } from 'lexical';

import { EditableMathNode } from './EditableMathNode';

export type SerializedMathInlineNode = Spread<
  {
    source: string;
  },
  SerializedLexicalNode
>;

function convertMathInlineElement(domNode: HTMLElement): DOMConversionOutput | null {
  const source = domNode.getAttribute('data-math-source');
  if (!source) {
    return null;
  }

  return {
    node: $createMathInlineNode(source),
  };
}

export class MathInlineNode extends DecoratorNode<JSX.Element> {
  __source: string;

  constructor(source: string, key?: NodeKey) {
    super(key);
    this.__source = source;
  }

  static getType(): string {
    return 'math-inline';
  }

  static clone(node: MathInlineNode): MathInlineNode {
    return new MathInlineNode(node.__source, node.__key);
  }

  static importJSON(serializedNode: SerializedMathInlineNode): MathInlineNode {
    return $createMathInlineNode(serializedNode.source);
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute('data-lexical-math-inline')) {
          return null;
        }
        return {
          conversion: convertMathInlineElement,
          priority: 1,
        };
      },
    };
  }

  exportJSON(): SerializedMathInlineNode {
    return {
      ...super.exportJSON(),
      type: 'math-inline',
      version: 1,
      source: this.__source,
    };
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const element = document.createElement('span');
    element.className = 'nim-math-inline-node';
    element.setAttribute('data-lexical-math-inline', 'true');
    element.setAttribute('data-math-source', this.__source);
    element.textContent = `$${this.__source}$`;
    return { element };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.className = 'nim-math-inline-node';
    span.spellcheck = false;
    return span;
  }

  updateDOM(prevNode: MathInlineNode): boolean {
    return prevNode.__source !== this.__source;
  }

  isInline(): true {
    return true;
  }

  canInsertTextBefore(): false {
    return false;
  }

  canInsertTextAfter(): false {
    return false;
  }

  setSource(source: string): void {
    const writable = this.getWritable();
    writable.__source = source;
  }

  getTextContent(): string {
    return this.__source;
  }

  getSource(): string {
    return this.getLatest().__source;
  }

  decorate(): JSX.Element {
    return (
      <EditableMathNode
        displayMode={false}
        nodeKey={this.__key}
        source={this.__source}
      />
    );
  }
}

export function $createMathInlineNode(source: string): MathInlineNode {
  return $applyNodeReplacement(new MathInlineNode(source));
}

export function $isMathInlineNode(
  node: LexicalNode | null | undefined,
): node is MathInlineNode {
  return node instanceof MathInlineNode;
}
