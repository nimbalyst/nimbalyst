/**
 * TextColorNode: colored text (foreground, background or both).
 *
 * An inline element shaped like LinkNode: it wraps the run's own nodes (text
 * with its bold/italic formats, links, code), so color nests around
 * formatting the way the markdown does:
 * `<span style="color: #f03e3e">**Blocked** on review</span>`.
 *
 * Markdown syntax lives in `core/textColorSyntax.ts`. The opening tag as it was
 * read is kept in `rawOpenTag` so an unchanged span is written back byte for
 * byte, including colors that are not in the palette.
 *
 * React-, DOM- and CSS-free at import: the headless body graph
 * (`headlessBodyNodes.ts`) and the collab worker load this class.
 */

import type {
  BaseSelection,
  DOMConversionMap,
  DOMConversionOutput,
  DOMExportOutput,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  RangeSelection,
  SerializedElementNode,
  Spread,
} from 'lexical';

import { $applyNodeReplacement, $copyNode, $isRangeSelection, ElementNode } from 'lexical';

import {
  formatTextColorStyle,
  isSafeCssColor,
  parseTextColorStyle,
  textColorRenderStyle,
  type TextColorStyle,
} from '../../../core/textColorSyntax';

export type SerializedTextColorNode = Spread<
  {
    color?: string;
    backgroundColor?: string;
    /** The `<span ...>` tag as it was read from markdown, when unchanged since. */
    rawOpenTag?: string;
  },
  SerializedElementNode
>;

function safeColor(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && isSafeCssColor(value) ? value : undefined;
}

export class TextColorNode extends ElementNode {
  __color: string | undefined;
  __backgroundColor: string | undefined;
  __rawOpenTag: string | undefined;

  static getType(): string {
    return 'text-color';
  }

  static clone(node: TextColorNode): TextColorNode {
    return new TextColorNode(node.getTextColorStyle(), node.__rawOpenTag, node.__key);
  }

  static importJSON(serialized: SerializedTextColorNode): TextColorNode {
    return $createTextColorNode(
      { color: safeColor(serialized.color), backgroundColor: safeColor(serialized.backgroundColor) },
      typeof serialized.rawOpenTag === 'string' ? serialized.rawOpenTag : undefined,
    ).updateFromJSON(serialized);
  }

  static importDOM(): DOMConversionMap | null {
    return {
      // Only spans this node wrote (copy and paste inside Nimbalyst). Colored
      // spans in HTML pasted from elsewhere stay plain text, so pasting a web
      // page does not fill the markdown with arbitrary colors.
      span: (element: HTMLElement) => {
        if (!element.hasAttribute('data-nim-text-color')) return null;
        return { conversion: convertTextColorElement, priority: 2 };
      },
    };
  }

  constructor(style: TextColorStyle = {}, rawOpenTag?: string, key?: NodeKey) {
    super(key);
    this.__color = safeColor(style.color);
    this.__backgroundColor = safeColor(style.backgroundColor);
    this.__rawOpenTag = rawOpenTag || undefined;
  }

  exportJSON(): SerializedTextColorNode {
    return {
      ...super.exportJSON(),
      type: 'text-color',
      version: 1,
      ...(this.__color ? { color: this.__color } : {}),
      ...(this.__backgroundColor ? { backgroundColor: this.__backgroundColor } : {}),
      ...(this.__rawOpenTag ? { rawOpenTag: this.__rawOpenTag } : {}),
    };
  }

  getTextColorStyle(): TextColorStyle {
    const self = this.getLatest();
    return {
      ...(self.__color ? { color: self.__color } : {}),
      ...(self.__backgroundColor ? { backgroundColor: self.__backgroundColor } : {}),
    };
  }

  getRawOpenTag(): string | undefined {
    return this.getLatest().__rawOpenTag;
  }

  setTextColorStyle(style: TextColorStyle): this {
    const writable = this.getWritable();
    writable.__color = safeColor(style.color);
    writable.__backgroundColor = safeColor(style.backgroundColor);
    // The serializer keeps the written tag only while it still parses to the
    // same colors; clearing it keeps the Y.Doc from carrying stale source.
    writable.__rawOpenTag = undefined;
    return writable;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = document.createElement('span');
    const theme = config.theme as { textColor?: string };
    element.className = theme.textColor ? `text-color ${theme.textColor}` : 'text-color';
    element.setAttribute('data-nim-text-color', '');
    applyTextColorStyle(element, this.getTextColorStyle());
    return element;
  }

  updateDOM(prevNode: TextColorNode, element: HTMLElement): boolean {
    if (prevNode.__color !== this.__color || prevNode.__backgroundColor !== this.__backgroundColor) {
      applyTextColorStyle(element, { color: this.__color, backgroundColor: this.__backgroundColor });
    }
    return false;
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const { element } = super.exportDOM(editor);
    if (element instanceof HTMLElement) {
      // Pasted into another app, theme variables do not resolve; write the
      // colors themselves.
      element.setAttribute('style', formatTextColorStyle(this.getTextColorStyle()));
    }
    return { element };
  }

  insertNewAfter(_selection: RangeSelection, restoreSelection = true): null | ElementNode {
    const colored = $copyNode(this);
    this.insertAfter(colored, restoreSelection);
    return colored;
  }

  canInsertTextBefore(): false {
    return false;
  }

  canInsertTextAfter(): false {
    return false;
  }

  canBeEmpty(): false {
    return false;
  }

  isInline(): true {
    return true;
  }

  extractWithChild(_child: LexicalNode, selection: BaseSelection, _destination: 'clone' | 'html'): boolean {
    if (!$isRangeSelection(selection)) return false;
    return this.isParentOf(selection.anchor.getNode()) && this.isParentOf(selection.focus.getNode())
      && selection.getTextContent().length > 0;
  }
}

function applyTextColorStyle(element: HTMLElement, style: TextColorStyle): void {
  const render = textColorRenderStyle(style);
  element.style.color = render.color ?? '';
  element.style.backgroundColor = render.backgroundColor ?? '';
}

function convertTextColorElement(element: HTMLElement): DOMConversionOutput {
  const style = parseTextColorStyle(element.getAttribute('style') ?? '') ?? {};
  return { node: $createTextColorNode(style) };
}

export function $createTextColorNode(style: TextColorStyle, rawOpenTag?: string): TextColorNode {
  return $applyNodeReplacement(new TextColorNode(style, rawOpenTag));
}

export function $isTextColorNode(node: LexicalNode | null | undefined): node is TextColorNode {
  return node instanceof TextColorNode;
}
