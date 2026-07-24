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

export type MathBlockDelimiter = '$' | '$$';

export type SerializedMathBlockNode = Spread<
  {
    source: string;
    delimiter: MathBlockDelimiter;
  },
  SerializedLexicalNode
>;

function convertMathBlockElement(domNode: HTMLElement): DOMConversionOutput | null {
  const source = domNode.getAttribute('data-math-source');
  const delimiterAttr = domNode.getAttribute('data-math-delimiter');
  const delimiter = delimiterAttr === '$' ? '$' : '$$';

  if (source === null) {
    return null;
  }

  return {
    node: $createMathBlockNode(source, delimiter),
  };
}

export class MathBlockNode extends DecoratorNode<JSX.Element> {
  __source: string;
  __delimiter: MathBlockDelimiter;

  constructor(source: string, delimiter: MathBlockDelimiter = '$$', key?: NodeKey) {
    super(key);
    this.__source = source;
    this.__delimiter = delimiter;
  }

  static getType(): string {
    return 'math-block';
  }

  static clone(node: MathBlockNode): MathBlockNode {
    return new MathBlockNode(node.__source, node.__delimiter, node.__key);
  }

  static importJSON(serializedNode: SerializedMathBlockNode): MathBlockNode {
    return $createMathBlockNode(serializedNode.source, serializedNode.delimiter);
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute('data-lexical-math-block')) {
          return null;
        }
        return {
          conversion: convertMathBlockElement,
          priority: 1,
        };
      },
    };
  }

  exportJSON(): SerializedMathBlockNode {
    return {
      ...super.exportJSON(),
      type: 'math-block',
      version: 1,
      source: this.__source,
      delimiter: this.__delimiter,
    };
  }

  exportDOM(_editor: LexicalEditor): DOMExportOutput {
    const element = document.createElement('div');
    element.className = 'nim-math-block-node';
    element.setAttribute('data-lexical-math-block', 'true');
    element.setAttribute('data-math-source', this.__source);
    element.setAttribute('data-math-delimiter', this.__delimiter);
    element.textContent = `${this.__delimiter}\n${this.__source}\n${this.__delimiter}`;
    return { element };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const div = document.createElement('div');
    div.className = 'nim-math-block-node';
    return div;
  }

  updateDOM(prevNode: MathBlockNode): boolean {
    return (
      prevNode.__source !== this.__source ||
      prevNode.__delimiter !== this.__delimiter
    );
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

  getDelimiter(): MathBlockDelimiter {
    return this.getLatest().__delimiter;
  }

  decorate(): JSX.Element {
    return (
      <EditableMathNode
        delimiter={this.__delimiter}
        displayMode={true}
        nodeKey={this.__key}
        source={this.__source}
      />
    );
  }
}

export function $createMathBlockNode(
  source: string,
  delimiter: MathBlockDelimiter = '$$',
): MathBlockNode {
  return $applyNodeReplacement(new MathBlockNode(source, delimiter));
}

export function $isMathBlockNode(
  node: LexicalNode | null | undefined,
): node is MathBlockNode {
  return node instanceof MathBlockNode;
}
