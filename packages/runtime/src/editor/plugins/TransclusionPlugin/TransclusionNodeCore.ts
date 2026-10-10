/**
 * TransclusionNode -- a read-only, live copy of another page's section, shown
 * in place of a link alone in its paragraph whose title carries `transclude`
 * (see `./transclusionLink.ts` for the markdown contract).
 *
 * The node keeps the link exactly as written (label, href, whole title) and
 * exports it back unchanged, so a page round-trips byte for byte whether or not
 * the editor that saves it renders transclusions. Import is the
 * `TransclusionExtension` LinkNode transform, not a markdown matcher: headless
 * graphs (collab worker, CLI) run no transforms and leave the link a link,
 * which exports identically.
 *
 * React-free: `./TransclusionNode.tsx` registers the React decorator and
 * re-exports this module. See `nodeDecoratorSlot.ts`.
 */

import type { JSX } from 'react';
import {
  $applyNodeReplacement,
  $createParagraphNode,
  $createTextNode,
  $isParagraphNode,
  $isTextNode,
  DecoratorNode,
  type DOMConversionMap,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { $createLinkNode, $isLinkNode, type LinkNode } from '@lexical/link';
import type { ElementTransformer } from '@lexical/markdown';

import { createNodeDecoratorSlot } from '../../nodes/nodeDecoratorSlot';
import { isTranscludeTitle, parseTransclusionHref, withoutTranscludeToken } from './transclusionLink';

export type SerializedTransclusionNode = Spread<
  { href: string; label: string; title: string },
  SerializedLexicalNode
>;

export const TransclusionNodeDecorator = createNodeDecoratorSlot<TransclusionNode>();

export class TransclusionNode extends DecoratorNode<JSX.Element | null> {
  __href: string;
  __label: string;
  __title: string;

  constructor(href: string, label: string, title: string, key?: NodeKey) {
    super(key);
    this.__href = href;
    this.__label = label;
    this.__title = title;
  }

  static getType(): string {
    return 'transclusion';
  }

  static clone(node: TransclusionNode): TransclusionNode {
    return new TransclusionNode(node.__href, node.__label, node.__title, node.__key);
  }

  static importJSON(serializedNode: SerializedTransclusionNode): TransclusionNode {
    return $createTransclusionNode(serializedNode.href, serializedNode.label ?? '', serializedNode.title ?? 'transclude');
  }

  exportJSON(): SerializedTransclusionNode {
    return { type: 'transclusion', version: 1, href: this.__href, label: this.__label, title: this.__title };
  }

  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const div = document.createElement('div');
    div.className = 'transclusion-container';
    return div;
  }

  updateDOM(): boolean {
    return false;
  }

  // Pasted HTML comes back as the plain `<a>` exportDOM writes; LinkNode imports
  // it and the extension's link upgrade turns it back into a transclusion.
  static importDOM(): DOMConversionMap | null {
    return null;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('a');
    element.setAttribute('href', this.__href);
    element.setAttribute('title', this.__title);
    element.textContent = this.__label || this.__href;
    return { element };
  }

  isInline(): false {
    return false;
  }

  getHref(): string {
    return this.getLatest().__href;
  }

  getLabel(): string {
    return this.getLatest().__label;
  }

  getTitle(): string {
    return this.getLatest().__title;
  }

  setTitle(title: string): void {
    this.getWritable().__title = title;
  }

  getTextContent(): string {
    return this.__label;
  }

  decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element | null {
    return TransclusionNodeDecorator.decorate(this, editor, config);
  }
}

export function $createTransclusionNode(href: string, label: string, title: string): TransclusionNode {
  return $applyNodeReplacement(new TransclusionNode(href, label, title));
}

export function $isTransclusionNode(node: LexicalNode | null | undefined): node is TransclusionNode {
  return node instanceof TransclusionNode;
}

/** The link markdown a transclusion was written as. */
export function transclusionMarkdown(href: string, label: string, title: string): string {
  const quoted = title.includes('"') ? `'${title}'` : `"${title}"`;
  return `[${label || href}](${href} ${quoted})`;
}

export const TRANSCLUSION_TRANSFORMER: ElementTransformer = {
  dependencies: [TransclusionNode],
  type: 'element',
  // Import is the LinkNode transform in TransclusionExtension; never matches.
  regExp: /^(?!)/,
  replace: () => {},
  export: (node) => ($isTransclusionNode(node)
    ? transclusionMarkdown(node.getHref(), node.getLabel(), node.getTitle())
    : null),
};

function isEmptyText(node: LexicalNode): boolean {
  return $isTextNode(node) && node.getTextContent() === '';
}

/** True for a link alone in its paragraph whose title asks for a transclusion of a page. */
export function $transcludableLink(linkNode: LinkNode): boolean {
  if (!$isLinkNode(linkNode)) return false;
  if (!isTranscludeTitle(linkNode.getTitle())) return false;
  if (!parseTransclusionHref(linkNode.getURL())) return false;
  const parent = linkNode.getParent();
  if (!$isParagraphNode(parent)) return false;
  const meaningful = parent.getChildren().filter((child) => !isEmptyText(child));
  return meaningful.length === 1 && meaningful[0] === linkNode;
}

/** Replace a paragraph-isolated transclude link with a transclusion. */
export function $upgradeLinkToTransclusion(linkNode: LinkNode): boolean {
  if (!$transcludableLink(linkNode)) return false;
  const node = $createTransclusionNode(linkNode.getURL(), linkNode.getTextContent(), linkNode.getTitle() ?? '');
  linkNode.getParentOrThrow().replace(node);
  return true;
}

/**
 * Turn a transclusion back into its paragraph-isolated link. The `transclude`
 * token goes (otherwise the LinkNode transform upgrades it straight back); any
 * other title tokens stay, and an emptied title is dropped.
 */
export function $downgradeTransclusionToLink(node: TransclusionNode): LinkNode {
  const title = withoutTranscludeToken(node.getTitle());
  const link = $createLinkNode(node.getHref(), title ? { title } : undefined);
  link.append($createTextNode(node.getLabel() || node.getHref()));
  const paragraph = $createParagraphNode();
  paragraph.append(link);
  node.replace(paragraph);
  return link;
}
