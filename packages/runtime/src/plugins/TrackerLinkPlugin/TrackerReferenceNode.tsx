/**
 * TrackerReferenceNode — an inline reference (pointer) to a tracker item.
 *
 * Unlike `TrackerItemNode` (which embeds a frozen snapshot of an item inline),
 * this node stores ONLY the reference key (e.g. `NIM-123`). The decorated chip
 * resolves the item's title/status *live* at render time via the injected
 * {@link TrackerReferenceResolver}, so editing or closing the item elsewhere
 * updates every chip pointing at it with no document edit.
 *
 * Serializes to a portable markdown link `[NIM-123](nimbalyst://NIM-123)` via
 * {@link TrackerReferenceTransformer}, so the document stays valid markdown and
 * degrades to a plain link in any other viewer.
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

import { getTrackerReferenceNodeRenderer } from './TrackerReferenceNodeRenderer';

export const TRACKER_REFERENCE_URN_SCHEME = 'nimbalyst://';

export type SerializedTrackerReferenceNode = Spread<
  {
    /** Reference key: an issue key (NIM-123) or local short id (tk_abc123). */
    referenceKey: string;
  },
  SerializedLexicalNode
>;

function convertTrackerReferenceElement(
  domNode: HTMLElement,
): DOMConversionOutput | null {
  const referenceKey = domNode.getAttribute('data-issue-key');
  if (referenceKey) {
    return { node: $createTrackerReferenceNode(referenceKey) };
  }
  return null;
}

export class TrackerReferenceNode extends DecoratorNode<JSX.Element> {
  __referenceKey: string;

  static getType(): string {
    return 'tracker-reference';
  }

  static clone(node: TrackerReferenceNode): TrackerReferenceNode {
    return new TrackerReferenceNode(node.__referenceKey, node.__key);
  }

  static importJSON(
    serializedNode: SerializedTrackerReferenceNode,
  ): TrackerReferenceNode {
    return $createTrackerReferenceNode(serializedNode.referenceKey);
  }

  constructor(referenceKey: string, key?: NodeKey) {
    super(key);
    this.__referenceKey = referenceKey;
  }

  exportJSON(): SerializedTrackerReferenceNode {
    return {
      ...super.exportJSON(),
      type: 'tracker-reference',
      version: 1,
      referenceKey: this.__referenceKey,
    };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.className = 'tracker-reference';
    const theme = config.theme as { trackerReference?: string };
    if (theme.trackerReference) {
      span.className = `tracker-reference ${theme.trackerReference}`;
    }
    span.setAttribute('data-issue-key', this.__referenceKey);
    return span;
  }

  updateDOM(): false {
    return false;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('span');
    element.className = 'tracker-reference';
    element.setAttribute('data-lexical-tracker-reference', 'true');
    element.setAttribute('data-issue-key', this.__referenceKey);
    element.textContent = this.__referenceKey;
    return { element };
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (domNode: HTMLElement) => {
        if (!domNode.hasAttribute('data-lexical-tracker-reference')) {
          return null;
        }
        return { conversion: convertTrackerReferenceElement, priority: 1 };
      },
    };
  }

  decorate(): JSX.Element {
    const Renderer = getTrackerReferenceNodeRenderer();
    if (!Renderer) {
      return (
        <span
          className="tracker-reference"
          data-issue-key={this.__referenceKey}
        >
          {this.__referenceKey}
        </span>
      );
    }
    return (
      <Renderer
        referenceKey={this.__referenceKey}
        nodeKey={this.getKey()}
      />
    );
  }

  isInline(): true {
    return true;
  }

  /** Plain-text fallback (copy, non-rich serialization) is the bare key. */
  getTextContent(): string {
    return this.__referenceKey;
  }

  getReferenceKey(): string {
    return this.__referenceKey;
  }
}

export function $createTrackerReferenceNode(
  referenceKey: string,
): TrackerReferenceNode {
  return $applyNodeReplacement(new TrackerReferenceNode(referenceKey));
}

export function $isTrackerReferenceNode(
  node: LexicalNode | null | undefined,
): node is TrackerReferenceNode {
  return node instanceof TrackerReferenceNode;
}
