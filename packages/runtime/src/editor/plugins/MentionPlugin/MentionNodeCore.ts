/**
 * MentionNode -- an inline chip for a person or a date.
 *
 * Markdown (both read sensibly on GitHub and in a plain editor):
 *
 *   person  [@Ada Lovelace](mailto:ada@example.com)
 *   date    @2026-10-15
 *
 * A person is keyed by email so the mention means the same human in the
 * console, in a clone of the repo, or after the member leaves the team; the
 * `mailto:` link keeps it clickable everywhere else. A date needs no key and no
 * link target, so it stays the bare `@YYYY-MM-DD` an agent would type; only a
 * real calendar date written that way becomes a chip.
 *
 * React-free: `./MentionNode.tsx` registers the React decorator and re-exports
 * this module; headless graphs (collab worker, CLI) import this one directly.
 * See `nodeDecoratorSlot.ts`.
 */

import type { JSX } from 'react';
import {
  $applyNodeReplacement,
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
import { $isLinkNode } from '@lexical/link';
import type { TextMatchTransformer } from '@lexical/markdown';

import { createNodeDecoratorSlot } from '../../nodes/nodeDecoratorSlot';
import { isIsoDate } from './mentionDates';

export type MentionKind = 'person' | 'date';

export type SerializedMentionNode = Spread<
  {
    mentionKind: MentionKind;
    /** The email for a person, the `YYYY-MM-DD` date for a date. */
    value: string;
    /** A person's display name as written; empty for a date. */
    label: string;
  },
  SerializedLexicalNode
>;

export const MentionNodeDecorator = createNodeDecoratorSlot<MentionNode>();

export class MentionNode extends DecoratorNode<JSX.Element | null> {
  __mentionKind: MentionKind;
  __value: string;
  __label: string;

  constructor(mentionKind: MentionKind, value: string, label: string = '', key?: NodeKey) {
    super(key);
    this.__mentionKind = mentionKind;
    this.__value = value;
    this.__label = label;
  }

  static getType(): string {
    return 'mention';
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__mentionKind, node.__value, node.__label, node.__key);
  }

  static importJSON(serializedNode: SerializedMentionNode): MentionNode {
    return $createMentionNode(serializedNode.mentionKind, serializedNode.value, serializedNode.label ?? '');
  }

  exportJSON(): SerializedMentionNode {
    return { type: 'mention', version: 1, mentionKind: this.__mentionKind, value: this.__value, label: this.__label };
  }

  createDOM(_config: EditorConfig, _editor: LexicalEditor): HTMLElement {
    const span = document.createElement('span');
    span.className = `mention mention--${this.__mentionKind}`;
    return span;
  }

  updateDOM(prevNode: MentionNode): boolean {
    return prevNode.__mentionKind !== this.__mentionKind;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement(this.__mentionKind === 'person' ? 'a' : 'time');
    element.setAttribute('data-lexical-mention', this.__mentionKind);
    if (this.__mentionKind === 'person') {
      element.setAttribute('href', `mailto:${this.__value}`);
    } else {
      element.setAttribute('datetime', this.__value);
    }
    element.textContent = this.getTextContent();
    return { element };
  }

  static importDOM(): DOMConversionMap | null {
    const convert = (domNode: HTMLElement) => {
      const kind = domNode.getAttribute('data-lexical-mention');
      if (kind === 'person') {
        const email = (domNode.getAttribute('href') ?? '').replace(/^mailto:/, '');
        return email ? { node: $createMentionNode('person', email, (domNode.textContent ?? '').replace(/^@/, '')) } : null;
      }
      const date = domNode.getAttribute('datetime') ?? '';
      return kind === 'date' && isIsoDate(date) ? { node: $createMentionNode('date', date) } : null;
    };
    const match = (domNode: HTMLElement) => (domNode.hasAttribute('data-lexical-mention') ? { conversion: convert, priority: 2 as const } : null);
    return { a: match, time: match };
  }

  isInline(): true {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  getMentionKind(): MentionKind {
    return this.getLatest().__mentionKind;
  }

  getValue(): string {
    return this.getLatest().__value;
  }

  getLabel(): string {
    return this.getLatest().__label;
  }

  getTextContent(): string {
    const self = this.getLatest();
    return self.__mentionKind === 'person' ? `@${self.__label || self.__value}` : `@${self.__value}`;
  }

  decorate(editor: LexicalEditor, config: EditorConfig): JSX.Element | null {
    return MentionNodeDecorator.decorate(this, editor, config);
  }
}

export function $createMentionNode(mentionKind: MentionKind, value: string, label: string = ''): MentionNode {
  return $applyNodeReplacement(new MentionNode(mentionKind, value, label));
}

export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return node instanceof MentionNode;
}

/** `]` and `\` would end or escape the link text; everything else is literal. */
function escapeLinkText(text: string): string {
  return text.replace(/[\\\]]/g, (ch) => `\\${ch}`);
}

function unescapeLinkText(text: string): string {
  return text.replace(/\\([\\\]])/g, '$1');
}

/** The markdown for a mention; the inverse of the two import patterns below. */
export function mentionMarkdown(kind: MentionKind, value: string, label: string): string {
  if (kind === 'date') return `@${value}`;
  return `[@${escapeLinkText(label || value)}](mailto:${value})`;
}

const PERSON_MENTION_SOURCE = String.raw`(?<!!)\[@((?:\\.|[^\]\\])+)\]\(mailto:([^\s()<>]+@[^\s()<>]+)\)`;

/** `[@Name](mailto:email)`. Must precede every other link transformer. */
export const PERSON_MENTION_TRANSFORMER: TextMatchTransformer = {
  dependencies: [MentionNode],
  export: (node) => ($isMentionNode(node) && node.getMentionKind() === 'person'
    ? mentionMarkdown('person', node.getValue(), node.getLabel())
    : null),
  importRegExp: new RegExp(PERSON_MENTION_SOURCE),
  regExp: new RegExp(`${PERSON_MENTION_SOURCE}$`),
  replace: (textNode, match) => {
    const [, label, email] = match;
    textNode.replace($createMentionNode('person', email!, unescapeLinkText(label!)));
  },
  trigger: ')',
  type: 'text-match',
};

// A date is its own token: at the start of the text or after whitespace or an
// opening bracket, quote or emphasis mark (never after `=`, `+`, `/`, `.` and
// the like, which put it inside a URL query, path or email), not in a token
// that contains `://`, and not continued by a word character, `-`, or a `.`,
// `:` or `/` followed by more of a URL or domain (`@2026-10-15.example`).
const DATE_MENTION_SOURCE = String.raw`(?<=^|[\s([{"'*_~>])(?<!\S*:\/\/\S*)@(\d{4}-\d{2}-\d{2})(?![\w-])(?![.:/@][^\s])`;

/** A bare `@YYYY-MM-DD` that names a real date. */
export const DATE_MENTION_TRANSFORMER: TextMatchTransformer = {
  dependencies: [MentionNode],
  export: (node) => ($isMentionNode(node) && node.getMentionKind() === 'date'
    ? mentionMarkdown('date', node.getValue(), '')
    : null),
  importRegExp: new RegExp(DATE_MENTION_SOURCE),
  regExp: new RegExp(`${DATE_MENTION_SOURCE}$`),
  replace: (textNode, match) => {
    const date = match[1]!;
    // An impossible date (`@2026-13-40`) stays text, and so does one inside a
    // link's text, which belongs to the link.
    if (!isIsoDate(date) || $isLinkNode(textNode.getParent())) return;
    textNode.replace($createMentionNode('date', date));
  },
  type: 'text-match',
};

export const MENTION_TRANSFORMERS: TextMatchTransformer[] = [PERSON_MENTION_TRANSFORMER, DATE_MENTION_TRANSFORMER];
