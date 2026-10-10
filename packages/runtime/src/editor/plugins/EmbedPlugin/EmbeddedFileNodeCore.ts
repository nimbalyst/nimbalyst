/**
 * EmbeddedFileNode -- a Lexical DecoratorNode that renders another file
 * (e.g. an Excalidraw canvas) inline inside a host markdown document.
 *
 * The node stores a path (`__src`) plus a label and key=value attribute bag
 * derived from the markdown link title. Markdown round-trips as a CommonMark
 * link: `[label](./path/to/file "k=v k=v")`.
 *
 * The actual editor inside the embed is rendered by a host-supplied
 * component registered via `setEmbedPluginCallbacks`. The runtime package
 * does not know how to read files or look up extensions; those concerns live
 * in the renderer-side `EmbedFrame`.
 *
 * React-free: `./EmbeddedFileNode.tsx` registers the React decorator and
 * re-exports this module; headless graphs (collab worker, CLI) import this one
 * directly. See `nodeDecoratorSlot.ts`.
 */

import type { JSX } from 'react';
import {
  $applyNodeReplacement,
  DecoratorNode,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { addClassNamesToElement } from '@lexical/utils';

import { createNodeDecoratorSlot } from '../../nodes/nodeDecoratorSlot';
import { parseEmbedAttrs, serializeEmbedAttrs } from './embedAttrs';

export type EmbedAttrs = Record<string, string>;
export const PLACED_VIEW_ATTR_KEYS = ['mode', 'cols', 'sort', 'filter', 'group', 'scope', 'w', 'ordering', 'hide', 'start', 'end', 'x', 'y', 'xl', 'yl', 'q', 'pin', 'height', 'width'] as const;


export interface EmbeddedFilePayload {
  src: string;
  label: string;
  attrs?: EmbedAttrs;
  /**
   * The link title exactly as written, for web link previews. When set, it is
   * the source of truth: `attrs` is parsed from it and export writes it back
   * verbatim. File embeds leave it null and keep the attribute-map export.
   */
  title?: string | null;
  key?: NodeKey;
}

export type SerializedEmbeddedFileNode = Spread<
  {
    src: string;
    label: string;
    attrs: EmbedAttrs;
    title?: string;
  },
  SerializedLexicalNode
>;

export const EmbeddedFileNodeDecorator = createNodeDecoratorSlot<EmbeddedFileNode>();

export class EmbeddedFileNode extends DecoratorNode<JSX.Element | null> {
  __src: string;
  __label: string;
  __attrs: EmbedAttrs;
  __title: string | null;
  // Separate primitive Yjs properties let independent settings merge. Null
  // uses the original markdown value; an empty string explicitly removes it.
  [key: `__view_${string}`]: string | null;

  constructor(src: string, label: string, attrs: EmbedAttrs, key?: NodeKey, title: string | null = null) {
    super(key);
    this.__src = src;
    this.__label = label;
    this.__attrs = title === null ? attrs : parseEmbedAttrs(title);
    this.__title = title;
    for (const key of PLACED_VIEW_ATTR_KEYS) this[`__view_${key}`] = null;
  }

  static getType(): string {
    return 'embedded-file';
  }

  static clone(node: EmbeddedFileNode): EmbeddedFileNode {
    const clone = new EmbeddedFileNode(
      node.__src,
      node.__label,
      { ...node.__attrs },
      node.__key,
      node.__title,
    );
    for (const key of PLACED_VIEW_ATTR_KEYS) clone[`__view_${key}`] = node[`__view_${key}`];
    return clone;
  }

  static importJSON(
    serializedNode: SerializedEmbeddedFileNode,
  ): EmbeddedFileNode {
    return $createEmbeddedFileNode({
      src: serializedNode.src,
      label: serializedNode.label,
      attrs: serializedNode.attrs ?? {},
      title: serializedNode.title ?? null,
    });
  }

  exportJSON(): SerializedEmbeddedFileNode {
    return {
      type: 'embedded-file',
      version: 1,
      src: this.__src,
      label: this.__label,
      attrs: this.getAttrs(),
      ...(this.getLatest().__title !== null ? { title: this.getLatest().__title as string } : {}),
    };
  }

  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const div = document.createElement('div');
    addClassNamesToElement(div, 'embedded-file-container');
    return div;
  }

  updateDOM(prev: EmbeddedFileNode): boolean {
    // Only force a container-DOM recreate when the embedded file path
    // changes -- that's effectively a different embed and resetting the
    // mounted extension is the right move. Label and attrs (height /
    // width / caption) are presentation-only; the React subtree picks
    // them up on its next render without losing the extension's
    // in-memory view-state (pan / zoom).
    return prev.__src !== this.__src;
  }

  exportDOM(): DOMExportOutput {
    // Export as a plain anchor so non-Nimbalyst readers still get a link.
    const a = document.createElement('a');
    a.href = this.__src;
    a.textContent = this.__label || this.__src;
    a.setAttribute('data-lexical-embedded-file', 'true');
    const title = this.getTitle() ?? serializeEmbedAttrs(this.getAttrs());
    if (title) {
      a.title = title;
    }
    return { element: a };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      a: (domNode: HTMLElement) => {
        if (
          domNode.getAttribute('data-lexical-embedded-file') !== 'true'
        ) {
          return null;
        }
        return {
          conversion: $convertEmbeddedFileElement,
          priority: 2,
        };
      },
    };
  }

  /**
   * Override so the diff system and copy-as-text paths still produce
   * something meaningful when an embed is part of a comparison.
   */
  getTextContent(): string {
    return `[${this.__label}](${this.__src})`;
  }

  getSrc(): string {
    return this.__src;
  }

  getLabel(): string {
    return this.__label;
  }

  /** The verbatim link title, or null for embeds whose title is the attribute map. */
  getTitle(): string | null {
    return this.getLatest().__title;
  }

  /** Replace the verbatim title; the attribute map follows it. */
  setTitle(title: string): void {
    const writable = this.getWritable();
    writable.__title = title;
    writable.__attrs = parseEmbedAttrs(title);
    for (const key of PLACED_VIEW_ATTR_KEYS) writable[`__view_${key}`] = null;
  }

  getAttrs(): EmbedAttrs {
    const latest = this.getLatest();
    const attrs = { ...latest.__attrs };
    for (const key of PLACED_VIEW_ATTR_KEYS) {
      const value = latest[`__view_${key}`];
      if (value === '') delete attrs[key];
      else if (typeof value === 'string') attrs[key] = value;
    }
    return attrs;
  }

  setSrc(src: string): void {
    const writable = this.getWritable();
    writable.__src = src;
  }

  setLabel(label: string): void {
    const writable = this.getWritable();
    writable.__label = label;
  }

  setAttrs(attrs: EmbedAttrs): void {
    const writable = this.getWritable();
    writable.__attrs = { ...attrs };
    writable.__title = null;
    for (const key of PLACED_VIEW_ATTR_KEYS) writable[`__view_${key}`] = null;
  }

  /** Merge one settings gesture into the current node, preserving other keys. */
  patchViewAttrs(patch: Readonly<Record<string, string | null>>): void {
    const current = this.getAttrs();
    for (const [key, value] of Object.entries(patch)) {
      if (!(PLACED_VIEW_ATTR_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown view setting: ${key}`);
      if ((current[key] ?? null) !== (value || null)) this.getWritable()[`__view_${key}`] = value ?? '';
    }
  }

  decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element | null {
    return EmbeddedFileNodeDecorator.decorate(this, editor, config);
  }
}

function $convertEmbeddedFileElement(
  domNode: Node,
): DOMConversionOutput | null {
  const anchor = domNode as HTMLAnchorElement;
  if (anchor.getAttribute('data-lexical-embedded-file') !== 'true') {
    return null;
  }

  const src = anchor.getAttribute('href') ?? '';
  return {
    node: $createEmbeddedFileNode({
      src,
      label: anchor.textContent || src,
      attrs: parseEmbedAttrs(anchor.getAttribute('title')),
    }),
  };
}

export function $createEmbeddedFileNode(
  payload: EmbeddedFilePayload,
): EmbeddedFileNode {
  return $applyNodeReplacement(
    new EmbeddedFileNode(
      payload.src,
      payload.label,
      payload.attrs ?? {},
      payload.key,
      payload.title ?? null,
    ),
  );
}

export function $isEmbeddedFileNode(
  node: LexicalNode | null | undefined,
): node is EmbeddedFileNode {
  return node instanceof EmbeddedFileNode;
}
