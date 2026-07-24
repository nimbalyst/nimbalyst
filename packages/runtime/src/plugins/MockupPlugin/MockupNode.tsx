/**
 * MockupNode - A Lexical DecoratorNode for embedding mockups in documents.
 *
 * Displays a screenshot of the mockup with an edit button overlay.
 * References both the mockup source file and its cached screenshot.
 */

import type {
  DOMConversionMap,
  DOMConversionOutput,
  DOMExportOutput,
  EditorConfig,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical';
import type { JSX } from 'react';

import { $applyNodeReplacement, DecoratorNode } from 'lexical';
import * as React from 'react';

const MockupComponent = React.lazy(() => import('./MockupComponent'));

export interface MockupPayload {
  mockupPath: string;
  screenshotPath: string;
  altText?: string;
  width?: number;
  height?: number;
  key?: NodeKey;
}

export type SerializedMockupNode = Spread<
  {
    mockupPath: string;
    screenshotPath: string;
    altText: string;
    width?: number;
    height?: number;
  },
  SerializedLexicalNode
>;

function $convertMockupElement(domNode: Node): null | DOMConversionOutput {
  const element = domNode as HTMLElement;
  const mockupPath = element.getAttribute('data-mockup-path');
  const screenshotPath = element.getAttribute('data-screenshot-path');
  const altText = element.getAttribute('data-alt-text') || 'Mockup';
  const width = element.getAttribute('data-width');
  const height = element.getAttribute('data-height');

  if (mockupPath && screenshotPath) {
    const node = $createMockupNode({
      mockupPath,
      screenshotPath,
      altText,
      width: width ? parseInt(width) : undefined,
      height: height ? parseInt(height) : undefined,
    });
    return { node };
  }

  return null;
}

export class MockupNode extends DecoratorNode<JSX.Element> {
  __mockupPath: string;
  __screenshotPath: string;
  __altText: string;
  __width: 'inherit' | number;
  __height: 'inherit' | number;

  static getType(): string {
    return 'mockup';
  }

  static clone(node: MockupNode): MockupNode {
    return new MockupNode(
      node.__mockupPath,
      node.__screenshotPath,
      node.__altText,
      node.__width,
      node.__height,
      node.__key,
    );
  }

  static importJSON(serializedNode: SerializedMockupNode): MockupNode {
    const { mockupPath, screenshotPath, altText, width, height } =
      serializedNode;
    return $createMockupNode({
      mockupPath,
      screenshotPath,
      altText,
      width,
      height,
    });
  }

  constructor(
    mockupPath: string,
    screenshotPath: string,
    altText: string = 'Mockup',
    width?: 'inherit' | number,
    height?: 'inherit' | number,
    key?: NodeKey,
  ) {
    super(key);
    this.__mockupPath = mockupPath;
    this.__screenshotPath = screenshotPath;
    this.__altText = altText;
    this.__width = width || 'inherit';
    this.__height = height || 'inherit';
  }

  exportJSON(): SerializedMockupNode {
    return {
      ...super.exportJSON(),
      mockupPath: this.__mockupPath,
      screenshotPath: this.__screenshotPath,
      altText: this.__altText,
      width: this.__width === 'inherit' ? undefined : this.__width,
      height: this.__height === 'inherit' ? undefined : this.__height,
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('div');
    element.setAttribute('data-lexical-mockup', 'true');
    element.setAttribute('data-mockup-path', this.__mockupPath);
    element.setAttribute('data-screenshot-path', this.__screenshotPath);
    element.setAttribute('data-alt-text', this.__altText);
    if (this.__width !== 'inherit') {
      element.setAttribute('data-width', String(this.__width));
    }
    if (this.__height !== 'inherit') {
      element.setAttribute('data-height', String(this.__height));
    }

    // Include an img for visual representation in copy/paste
    const img = document.createElement('img');
    img.src = this.__screenshotPath;
    img.alt = this.__altText;
    if (this.__width !== 'inherit') {
      img.width = this.__width;
    }
    if (this.__height !== 'inherit') {
      img.height = this.__height;
    }
    element.appendChild(img);

    return { element };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute('data-lexical-mockup')) {
          return null;
        }
        return {
          conversion: $convertMockupElement,
          priority: 1,
        };
      },
    };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    const theme = config.theme;
    const className = theme.mockup;
    if (className !== undefined) {
      span.className = className;
    }
    return span;
  }

  updateDOM(): false {
    return false;
  }

  getMockupPath(): string {
    return this.__mockupPath;
  }

  getScreenshotPath(): string {
    return this.__screenshotPath;
  }

  getAltText(): string {
    return this.__altText;
  }

  setWidthAndHeight(
    width: 'inherit' | number,
    height: 'inherit' | number,
  ): void {
    const writable = this.getWritable();
    writable.__width = width;
    writable.__height = height;
  }

  setScreenshotPath(screenshotPath: string): void {
    const writable = this.getWritable();
    writable.__screenshotPath = screenshotPath;
  }

  decorate(): JSX.Element {
    return (
      <MockupComponent
        mockupPath={this.__mockupPath}
        screenshotPath={this.__screenshotPath}
        altText={this.__altText}
        width={this.__width}
        height={this.__height}
        nodeKey={this.getKey()}
        resizable={true}
      />
    );
  }
}

export function $createMockupNode({
  mockupPath,
  screenshotPath,
  altText = 'Mockup',
  width,
  height,
  key,
}: MockupPayload): MockupNode {
  return $applyNodeReplacement(
    new MockupNode(mockupPath, screenshotPath, altText, width, height, key),
  );
}

export function $isMockupNode(
  node: LexicalNode | null | undefined,
): node is MockupNode {
  return node instanceof MockupNode;
}
