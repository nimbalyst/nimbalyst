/**
 * DataModelNode - A Lexical DecoratorNode for embedding data models in documents.
 *
 * Displays a screenshot of the data model with an edit button overlay.
 * References both the data model source file (.prisma) and its cached screenshot.
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

// Import directly instead of lazy loading - blob URLs don't support relative dynamic imports
import DataModelComponent from './DataModelComponent';

export interface DataModelPayload {
  dataModelPath: string;
  screenshotPath: string;
  altText?: string;
  width?: number;
  height?: number;
  key?: NodeKey;
}

export type SerializedDataModelNode = Spread<
  {
    dataModelPath: string;
    screenshotPath: string;
    altText: string;
    width?: number;
    height?: number;
  },
  SerializedLexicalNode
>;

function $convertDataModelElement(domNode: Node): null | DOMConversionOutput {
  const element = domNode as HTMLElement;
  const dataModelPath = element.getAttribute('data-datamodel-path');
  const screenshotPath = element.getAttribute('data-screenshot-path');
  const altText = element.getAttribute('data-alt-text') || 'Data Model';
  const width = element.getAttribute('data-width');
  const height = element.getAttribute('data-height');

  if (dataModelPath && screenshotPath) {
    const node = $createDataModelNode({
      dataModelPath,
      screenshotPath,
      altText,
      width: width ? parseInt(width) : undefined,
      height: height ? parseInt(height) : undefined,
    });
    return { node };
  }

  return null;
}

export class DataModelNode extends DecoratorNode<JSX.Element> {
  __dataModelPath: string;
  __screenshotPath: string;
  __altText: string;
  __width: 'inherit' | number;
  __height: 'inherit' | number;

  static getType(): string {
    return 'datamodel';
  }

  static clone(node: DataModelNode): DataModelNode {
    return new DataModelNode(
      node.__dataModelPath,
      node.__screenshotPath,
      node.__altText,
      node.__width,
      node.__height,
      node.__key,
    );
  }

  static importJSON(serializedNode: SerializedDataModelNode): DataModelNode {
    const { dataModelPath, screenshotPath, altText, width, height } =
      serializedNode;
    return $createDataModelNode({
      dataModelPath,
      screenshotPath,
      altText,
      width,
      height,
    });
  }

  constructor(
    dataModelPath: string,
    screenshotPath: string,
    altText: string = 'Data Model',
    width?: 'inherit' | number,
    height?: 'inherit' | number,
    key?: NodeKey,
  ) {
    super(key);
    this.__dataModelPath = dataModelPath;
    this.__screenshotPath = screenshotPath;
    this.__altText = altText;
    this.__width = width || 'inherit';
    this.__height = height || 'inherit';
  }

  exportJSON(): SerializedDataModelNode {
    return {
      ...super.exportJSON(),
      dataModelPath: this.__dataModelPath,
      screenshotPath: this.__screenshotPath,
      altText: this.__altText,
      width: this.__width === 'inherit' ? undefined : this.__width,
      height: this.__height === 'inherit' ? undefined : this.__height,
    };
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('div');
    element.setAttribute('data-lexical-datamodel', 'true');
    element.setAttribute('data-datamodel-path', this.__dataModelPath);
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
        if (!domNode.hasAttribute('data-lexical-datamodel')) {
          return null;
        }
        return {
          conversion: $convertDataModelElement,
          priority: 1,
        };
      },
    };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    const theme = config.theme;
    const className = theme.datamodel;
    if (className !== undefined) {
      span.className = className;
    }
    return span;
  }

  updateDOM(): false {
    return false;
  }

  getDataModelPath(): string {
    return this.__dataModelPath;
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
      <DataModelComponent
        dataModelPath={this.__dataModelPath}
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

export function $createDataModelNode({
  dataModelPath,
  screenshotPath,
  altText = 'Data Model',
  width,
  height,
  key,
}: DataModelPayload): DataModelNode {
  return $applyNodeReplacement(
    new DataModelNode(dataModelPath, screenshotPath, altText, width, height, key),
  );
}

export function $isDataModelNode(
  node: LexicalNode | null | undefined,
): node is DataModelNode {
  return node instanceof DataModelNode;
}
