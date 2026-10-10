/**
 * PageMarkNode: a decision or open-question mark on a sentence.
 *
 * An inline element that wraps the sentence's own nodes (text, links,
 * emphasis, citations), so the sentence stays ordinary editable text. The chip
 * before it and the faint who/when/not-chosen line after it are drawn from
 * data attributes by CSS (`PageMark.css`), so neither is part of the text,
 * the selection or the markdown.
 *
 * Markdown: `[sentence]{decided by="..." on=YYYY-MM-DD over="..."}` (see
 * `pageMarkSyntax.ts`). The attribute block as written is kept in `rawAttrs`
 * so an unchanged mark is written back byte for byte.
 *
 * React-, DOM- and CSS-free at import: the headless body graph
 * (`headlessBodyNodes.ts`) and the collab worker load this class.
 */

import type {
  BaseSelection,
  DOMConversionMap,
  DOMConversionOutput,
  EditorConfig,
  LexicalNode,
  NodeKey,
  RangeSelection,
  SerializedElementNode,
  Spread,
} from 'lexical';

import { $applyNodeReplacement, $copyNode, $isRangeSelection, ElementNode } from 'lexical';

import {
  describePageMark,
  isPageMarkKind,
  type PageMarkAttrs,
  type PageMarkKind,
} from '../../../core/pageMarkSyntax';

export type SerializedPageMarkNode = Spread<
  {
    kind: PageMarkKind;
    by?: string;
    email?: string;
    on?: string;
    over?: string;
    /** The `{...}` block as it was read from markdown, when unchanged since. */
    rawAttrs?: string;
  },
  SerializedElementNode
>;

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export class PageMarkNode extends ElementNode {
  __kind: PageMarkKind;
  __by: string | undefined;
  __email: string | undefined;
  __on: string | undefined;
  __over: string | undefined;
  __rawAttrs: string | undefined;

  static getType(): string {
    return 'page-mark';
  }

  static clone(node: PageMarkNode): PageMarkNode {
    return new PageMarkNode(node.getAttrs(), node.__rawAttrs, node.__key);
  }

  static importJSON(serialized: SerializedPageMarkNode): PageMarkNode {
    return $createPageMarkNode(
      {
        kind: isPageMarkKind(serialized.kind) ? serialized.kind : 'decided',
        by: optional(serialized.by),
        email: optional(serialized.email),
        on: optional(serialized.on),
        over: optional(serialized.over),
      },
      optional(serialized.rawAttrs),
    ).updateFromJSON(serialized);
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (element: HTMLElement) => {
        if (!element.hasAttribute('data-page-mark')) return null;
        return { conversion: convertPageMarkElement, priority: 2 };
      },
    };
  }

  constructor(attrs: PageMarkAttrs = { kind: 'decided' }, rawAttrs?: string, key?: NodeKey) {
    super(key);
    this.__kind = attrs.kind;
    this.__by = optional(attrs.by);
    this.__email = optional(attrs.email);
    this.__on = optional(attrs.on);
    this.__over = optional(attrs.over);
    this.__rawAttrs = optional(rawAttrs);
  }

  exportJSON(): SerializedPageMarkNode {
    return {
      ...super.exportJSON(),
      type: 'page-mark',
      version: 1,
      kind: this.__kind,
      ...(this.__by ? { by: this.__by } : {}),
      ...(this.__email ? { email: this.__email } : {}),
      ...(this.__on ? { on: this.__on } : {}),
      ...(this.__over ? { over: this.__over } : {}),
      ...(this.__rawAttrs ? { rawAttrs: this.__rawAttrs } : {}),
    };
  }

  getAttrs(): PageMarkAttrs {
    const self = this.getLatest();
    return {
      kind: self.__kind,
      ...(self.__by ? { by: self.__by } : {}),
      ...(self.__email ? { email: self.__email } : {}),
      ...(self.__on ? { on: self.__on } : {}),
      ...(self.__over ? { over: self.__over } : {}),
    };
  }

  getKind(): PageMarkKind {
    return this.getLatest().__kind;
  }

  getRawAttrs(): string | undefined {
    return this.getLatest().__rawAttrs;
  }

  setAttrs(attrs: PageMarkAttrs): this {
    const writable = this.getWritable();
    writable.__kind = attrs.kind;
    writable.__by = optional(attrs.by);
    writable.__email = optional(attrs.email);
    writable.__on = optional(attrs.on);
    writable.__over = optional(attrs.over);
    // The serializer keeps the written block only while it still parses to
    // the same attributes, so clearing it here is not required for
    // correctness; it keeps the Y.Doc from carrying stale source text.
    writable.__rawAttrs = undefined;
    return writable;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = document.createElement('span');
    const theme = config.theme as { pageMark?: string };
    element.className = theme.pageMark ? `page-mark ${theme.pageMark}` : 'page-mark';
    applyPageMarkAttributes(element, this.getAttrs());
    return element;
  }

  updateDOM(prevNode: PageMarkNode, element: HTMLElement): boolean {
    // Read the fields directly: `getAttrs()` goes through `getLatest()`, which
    // resolves `prevNode` to this same new version during reconciliation.
    if (
      prevNode.__kind !== this.__kind || prevNode.__by !== this.__by || prevNode.__email !== this.__email
      || prevNode.__on !== this.__on || prevNode.__over !== this.__over
    ) {
      applyPageMarkAttributes(element, this.getAttrs());
    }
    return false;
  }

  insertNewAfter(_selection: RangeSelection, restoreSelection = true): null | ElementNode {
    const mark = $copyNode(this);
    this.insertAfter(mark, restoreSelection);
    return mark;
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

/** The data attributes `PageMark.css` draws the chip and the who line from. */
export function applyPageMarkAttributes(element: HTMLElement, attrs: PageMarkAttrs): void {
  element.setAttribute('data-page-mark', attrs.kind);
  element.classList.toggle('page-mark--decided', attrs.kind === 'decided');
  element.classList.toggle('page-mark--open', attrs.kind === 'open');
  const who = describePageMark(attrs, new Date().getFullYear());
  if (who) element.setAttribute('data-page-mark-who', who);
  else element.removeAttribute('data-page-mark-who');
  for (const name of ['by', 'email', 'on', 'over'] as const) {
    const value = attrs[name];
    if (value) element.setAttribute(`data-${name}`, value);
    else element.removeAttribute(`data-${name}`);
  }
}

function convertPageMarkElement(element: HTMLElement): DOMConversionOutput {
  const kind = element.getAttribute('data-page-mark');
  return {
    node: $createPageMarkNode({
      kind: isPageMarkKind(kind) ? kind : 'decided',
      by: optional(element.getAttribute('data-by')),
      email: optional(element.getAttribute('data-email')),
      on: optional(element.getAttribute('data-on')),
      over: optional(element.getAttribute('data-over')),
    }),
  };
}

export function $createPageMarkNode(attrs: PageMarkAttrs, rawAttrs?: string): PageMarkNode {
  return $applyNodeReplacement(new PageMarkNode(attrs, rawAttrs));
}

export function $isPageMarkNode(node: LexicalNode | null | undefined): node is PageMarkNode {
  return node instanceof PageMarkNode;
}
