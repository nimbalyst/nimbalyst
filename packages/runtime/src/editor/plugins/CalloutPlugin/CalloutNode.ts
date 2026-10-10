/**
 * CalloutNode - a GitHub-alert style callout (`> [!WARNING] Title`).
 *
 * A shadow-root container of block children, so a callout holds paragraphs,
 * lists and headings like a quote that can nest blocks. The type and optional
 * custom title live on the node; the header is non-editable DOM drawn in
 * `createDOM`, and children render into the body via `getDOMSlot`.
 *
 * React- and CSS-free so the collab worker and CLI can load it.
 */

import {
  $applyNodeReplacement,
  $createParagraphNode,
  $getNodeByKey,
  ElementNode,
  setDOMUnmanaged,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type ElementDOMSlot,
  type LexicalEditor,
  type LexicalNode,
  type LexicalUpdateJSON,
  type NodeKey,
  type SerializedElementNode,
  type Spread,
} from 'lexical';

import { openCalloutTitleInput } from './calloutTitleInput';

export const CALLOUT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

export const CALLOUT_LABELS: Record<CalloutType, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
};

export function isCalloutType(value: string): value is CalloutType {
  return (CALLOUT_TYPES as readonly string[]).includes(value);
}

export type SerializedCalloutNode = Spread<
  {
    calloutType: CalloutType;
    title: string;
  },
  SerializedElementNode
>;

const HEADER_CLASS = 'callout-header';
const BODY_CLASS = 'callout-body';

function renderHeader(header: HTMLElement, type: CalloutType, title: string): void {
  header.textContent = title || CALLOUT_LABELS[type];
}

/** Opens the title input in a callout's header (a header click, or the block menu's "Edit title"). */
export function startCalloutTitleEdit(editor: LexicalEditor, key: NodeKey): void {
  const header = editor.getElementByKey(key)?.querySelector<HTMLElement>(`:scope > .${HEADER_CLASS}`);
  const current = editor.getEditorState().read(() => {
    const node = $getNodeByKey(key);
    return $isCalloutNode(node) ? { title: node.getTitle(), label: CALLOUT_LABELS[node.getCalloutType()] } : null;
  });
  if (!header || !current) return;
  openCalloutTitleInput(header, current, (title) => editor.update(() => {
    const node = $getNodeByKey(key);
    if ($isCalloutNode(node)) node.setTitle(title);
  }));
}

export class CalloutNode extends ElementNode {
  __calloutType: CalloutType;
  __title: string;

  constructor(calloutType: CalloutType = 'note', title: string = '', key?: NodeKey) {
    super(key);
    this.__calloutType = calloutType;
    this.__title = title;
  }

  static getType(): string {
    return 'callout';
  }

  static clone(node: CalloutNode): CalloutNode {
    return new CalloutNode(node.__calloutType, node.__title, node.__key);
  }

  createDOM(_config: EditorConfig, editor?: LexicalEditor): HTMLElement {
    const dom = document.createElement('div');
    dom.className = `callout callout-${this.__calloutType}`;
    dom.setAttribute('data-callout-type', this.__calloutType);

    const header = document.createElement('div');
    header.className = HEADER_CLASS;
    header.contentEditable = 'false';
    // The title input is swapped in here; keep Lexical's mutation observer off it.
    setDOMUnmanaged(header);
    renderHeader(header, this.__calloutType, this.__title);
    if (editor) {
      const key = this.__key;
      // The editor root refocuses itself on a mousedown that reaches it, which
      // would blur the input at once; keep both events at the header.
      header.addEventListener('mousedown', (event) => {
        if (!editor.isEditable()) return;
        event.preventDefault();
        event.stopPropagation();
      });
      header.addEventListener('click', (event) => {
        if (!editor.isEditable()) return;
        event.stopPropagation();
        startCalloutTitleEdit(editor, key);
      });
    }

    const body = document.createElement('div');
    body.className = BODY_CLASS;

    dom.append(header, body);
    return dom;
  }

  updateDOM(prevNode: CalloutNode, dom: HTMLElement): boolean {
    if (prevNode.__calloutType !== this.__calloutType || prevNode.__title !== this.__title) {
      dom.className = `callout callout-${this.__calloutType}`;
      dom.setAttribute('data-callout-type', this.__calloutType);
      const header = dom.querySelector<HTMLElement>(`:scope > .${HEADER_CLASS}`);
      if (header) renderHeader(header, this.__calloutType, this.__title);
    }
    return false;
  }

  getDOMSlot(element: HTMLElement): ElementDOMSlot<HTMLElement> {
    const body = element.querySelector<HTMLElement>(`:scope > .${BODY_CLASS}`);
    return body ? super.getDOMSlot(element).withElement(body) : super.getDOMSlot(element);
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('blockquote');
    element.className = `callout callout-${this.__calloutType}`;
    element.setAttribute('data-callout-type', this.__calloutType);
    if (this.__title) element.setAttribute('data-callout-title', this.__title);
    return { element };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      blockquote: (domNode: HTMLElement) => {
        const type = domNode.getAttribute('data-callout-type');
        if (!type || !isCalloutType(type)) return null;
        return { conversion: convertCalloutElement, priority: 2 };
      },
    };
  }

  static importJSON(serializedNode: SerializedCalloutNode): CalloutNode {
    return $createCalloutNode().updateFromJSON(serializedNode);
  }

  updateFromJSON(serializedNode: LexicalUpdateJSON<SerializedCalloutNode>): this {
    const type = isCalloutType(serializedNode.calloutType) ? serializedNode.calloutType : 'note';
    return super
      .updateFromJSON(serializedNode)
      .setCalloutType(type)
      .setTitle(serializedNode.title ?? '');
  }

  exportJSON(): SerializedCalloutNode {
    return {
      ...super.exportJSON(),
      calloutType: this.getCalloutType(),
      title: this.getTitle(),
    };
  }

  isShadowRoot(): boolean {
    return true;
  }

  canBeEmpty(): boolean {
    return false;
  }

  getCalloutType(): CalloutType {
    return this.getLatest().__calloutType;
  }

  setCalloutType(type: CalloutType): this {
    const self = this.getWritable();
    self.__calloutType = type;
    return self;
  }

  getTitle(): string {
    return this.getLatest().__title;
  }

  setTitle(title: string): this {
    const self = this.getWritable();
    self.__title = title;
    return self;
  }
}

function convertCalloutElement(domNode: HTMLElement): DOMConversionOutput {
  const type = domNode.getAttribute('data-callout-type');
  return {
    node: $createCalloutNode(
      type && isCalloutType(type) ? type : 'note',
      domNode.getAttribute('data-callout-title') ?? '',
    ),
  };
}

export function $createCalloutNode(type: CalloutType = 'note', title: string = ''): CalloutNode {
  return $applyNodeReplacement(new CalloutNode(type, title));
}

/** A callout with one empty paragraph, ready for the caret. */
export function $createEmptyCalloutNode(type: CalloutType = 'note'): CalloutNode {
  return $createCalloutNode(type).append($createParagraphNode());
}

export function $isCalloutNode(node: LexicalNode | null | undefined): node is CalloutNode {
  return node instanceof CalloutNode;
}
