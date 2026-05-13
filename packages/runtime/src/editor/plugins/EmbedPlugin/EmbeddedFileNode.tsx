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
 */

import {
  $applyNodeReplacement,
  DecoratorNode,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { addClassNamesToElement } from '@lexical/utils';
import React from 'react';

import { getEmbedPluginCallbacks } from './EmbedPluginCallbacks';
import { serializeEmbedAttrs } from './embedAttrs';

export type EmbedAttrs = Record<string, string>;

export interface EmbeddedFilePayload {
  src: string;
  label: string;
  attrs?: EmbedAttrs;
  key?: NodeKey;
}

export type SerializedEmbeddedFileNode = Spread<
  {
    src: string;
    label: string;
    attrs: EmbedAttrs;
  },
  SerializedLexicalNode
>;

export class EmbeddedFileNode extends DecoratorNode<JSX.Element> {
  __src: string;
  __label: string;
  __attrs: EmbedAttrs;

  constructor(src: string, label: string, attrs: EmbedAttrs, key?: NodeKey) {
    super(key);
    this.__src = src;
    this.__label = label;
    this.__attrs = attrs;
  }

  static getType(): string {
    return 'embedded-file';
  }

  static clone(node: EmbeddedFileNode): EmbeddedFileNode {
    return new EmbeddedFileNode(
      node.__src,
      node.__label,
      { ...node.__attrs },
      node.__key,
    );
  }

  static importJSON(
    serializedNode: SerializedEmbeddedFileNode,
  ): EmbeddedFileNode {
    return $createEmbeddedFileNode({
      src: serializedNode.src,
      label: serializedNode.label,
      attrs: serializedNode.attrs ?? {},
    });
  }

  exportJSON(): SerializedEmbeddedFileNode {
    return {
      type: 'embedded-file',
      version: 1,
      src: this.__src,
      label: this.__label,
      attrs: { ...this.__attrs },
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
    const title = serializeEmbedAttrs(this.__attrs);
    if (title) {
      a.title = title;
    }
    return { element: a };
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

  getAttrs(): EmbedAttrs {
    return { ...this.__attrs };
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
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): JSX.Element {
    return (
      <EmbedFrameSlot
        src={this.__src}
        label={this.__label}
        attrs={this.__attrs}
        nodeKey={this.__key}
      />
    );
  }
}

/**
 * Thin wrapper component. Reads the renderer-side EmbedFrame implementation
 * (registered via `setEmbedPluginCallbacks`) at render time and dispatches
 * to it. When no renderer is registered (e.g. on mobile or the share viewer
 * before Phase 6 lands), it shows a chrome-only placeholder so the host doc
 * still renders.
 */
function EmbedFrameSlot(props: {
  src: string;
  label: string;
  attrs: EmbedAttrs;
  nodeKey: NodeKey;
}): JSX.Element {
  const callbacks = getEmbedPluginCallbacks();
  const Renderer = callbacks.renderEmbed;
  if (Renderer) {
    return (
      <Renderer
        src={props.src}
        label={props.label}
        attrs={props.attrs}
        nodeKey={props.nodeKey}
      />
    );
  }
  return <EmbedPlaceholder src={props.src} label={props.label} />;
}

function EmbedPlaceholder(props: { src: string; label: string }): JSX.Element {
  return (
    <div className="embedded-file-placeholder" data-testid="embed-frame-placeholder">
      <span className="embedded-file-placeholder__label">
        {props.label || props.src}
      </span>
      <span className="embedded-file-placeholder__path">{props.src}</span>
    </div>
  );
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
    ),
  );
}

export function $isEmbeddedFileNode(
  node: LexicalNode | null | undefined,
): node is EmbeddedFileNode {
  return node instanceof EmbeddedFileNode;
}
