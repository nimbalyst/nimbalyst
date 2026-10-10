/**
 * CitationNode: an inline chip citing a person's words or a source.
 *
 * A human citation holds a snapshot of who said it, when and the quote, so a
 * teammate reads it without the session; the jump to the session works where
 * the session exists. A source citation points at a web page or a document.
 * Markdown: see `citationSyntax.ts`. The title as written is kept in
 * `rawTitle` so an unchanged citation is written back byte for byte.
 *
 * React-free: `CitationNode.tsx` fills the decorator slot; the headless body
 * graph imports this module directly (see `nodeDecoratorSlot.ts`).
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
  LexicalEditor,
} from 'lexical';
import type { JSX } from 'react';

import { $applyNodeReplacement, DecoratorNode } from 'lexical';

import { createNodeDecoratorSlot } from '../../nodes/nodeDecoratorSlot';
import {
  buildCitationHref,
  formatCitationTitle,
  isCitationInputKind,
  parseCitationLink,
  type Citation,
} from '../../../core/citationSyntax';

export type SerializedCitationNode = Spread<
  {
    citation: Citation;
    rawTitle?: string;
    rawHref?: string;
  },
  SerializedLexicalNode
>;

export const CitationNodeDecorator = createNodeDecoratorSlot<CitationNode>();

function sanitizeCitation(value: unknown): Citation | null {
  const raw = value as Partial<Record<string, unknown>> | null;
  if (!raw || typeof raw !== 'object') return null;
  const text = (key: string) => (typeof raw[key] === 'string' ? (raw[key] as string) : undefined);
  if (raw.kind === 'source') {
    const target = text('target');
    return target ? { kind: 'source', target, label: text('label') ?? '' } : null;
  }
  const sessionId = text('sessionId');
  const key = text('key');
  const inputKind = text('inputKind');
  if (!sessionId || !key || !isCitationInputKind(inputKind)) return null;
  const citation: Citation = { kind: 'human', sessionId, inputKind, key, label: text('label') ?? '' };
  for (const field of ['by', 'email', 'at', 'context', 'sessionTitle', 'quote'] as const) {
    const fieldValue = text(field);
    if (fieldValue !== undefined) citation[field] = fieldValue;
  }
  return citation;
}

export class CitationNode extends DecoratorNode<JSX.Element | null> {
  __citation: Citation;
  __rawTitle: string | undefined;
  __rawHref: string | undefined;

  static getType(): string {
    return 'citation';
  }

  static clone(node: CitationNode): CitationNode {
    return new CitationNode(node.__citation, node.__rawTitle, node.__rawHref, node.__key);
  }

  static importJSON(serialized: SerializedCitationNode): CitationNode {
    const citation = sanitizeCitation(serialized.citation)
      ?? { kind: 'source', target: 'about:blank', label: '' };
    return $createCitationNode(citation, serialized.rawTitle, serialized.rawHref);
  }

  static importDOM(): DOMConversionMap | null {
    return {
      a: (element: HTMLElement) => {
        const title = element.getAttribute('title');
        const href = element.getAttribute('href') ?? '';
        const citation = parseCitationLink(element.textContent ?? '', href, title);
        if (!citation) return null;
        return {
          // Above LinkNode's anchor conversion, so a pasted chip stays a citation.
          priority: 2,
          conversion: (): DOMConversionOutput => ({ node: $createCitationNode(citation, title, href) }),
        };
      },
    };
  }

  constructor(citation: Citation, rawTitle?: string | null, rawHref?: string | null, key?: NodeKey) {
    super(key);
    this.__citation = citation;
    this.__rawTitle = rawTitle ?? undefined;
    this.__rawHref = rawHref ?? undefined;
  }

  exportJSON(): SerializedCitationNode {
    return {
      ...super.exportJSON(),
      type: 'citation',
      version: 1,
      citation: this.__citation,
      ...(this.__rawTitle ? { rawTitle: this.__rawTitle } : {}),
      ...(this.__rawHref ? { rawHref: this.__rawHref } : {}),
    };
  }

  getCitation(): Citation {
    return this.getLatest().__citation;
  }

  getRawTitle(): string | undefined {
    return this.getLatest().__rawTitle;
  }

  getRawHref(): string | undefined {
    return this.getLatest().__rawHref;
  }

  setCitation(citation: Citation): this {
    const writable = this.getWritable();
    writable.__citation = citation;
    writable.__rawTitle = undefined;
    writable.__rawHref = undefined;
    return writable;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    const theme = config.theme as { citation?: string };
    span.className = theme.citation ? `citation ${theme.citation}` : 'citation';
    return span;
  }

  updateDOM(): false {
    return false;
  }

  exportDOM(): DOMExportOutput {
    const citation = this.getCitation();
    const anchor = document.createElement('a');
    anchor.className = 'citation';
    anchor.setAttribute('href', buildCitationHref(citation));
    const title = formatCitationTitle(citation);
    if (title) anchor.setAttribute('title', title);
    anchor.textContent = citation.label;
    return { element: anchor };
  }

  getTextContent(): string {
    return '';
  }

  isInline(): true {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element | null {
    return CitationNodeDecorator.decorate(this, editor, config);
  }
}

export function $createCitationNode(citation: Citation, rawTitle?: string | null, rawHref?: string | null): CitationNode {
  return $applyNodeReplacement(new CitationNode(citation, rawTitle, rawHref));
}

export function $isCitationNode(node: LexicalNode | null | undefined): node is CitationNode {
  return node instanceof CitationNode;
}
