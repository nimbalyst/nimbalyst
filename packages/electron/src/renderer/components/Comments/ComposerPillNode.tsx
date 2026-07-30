import React from 'react';
import {
  DecoratorNode,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
  type Spread,
} from 'lexical';
import { MaterialSymbol } from '@nimbalyst/runtime';

import { labeledToken } from './composerDraft';
import { initialsFor } from './commentBodyParser';

export type ComposerPillKind = 'person' | 'agent' | 'resource';

export interface ComposerPillPayload {
  /** Display label, exactly as it will appear inside the exported token. */
  label: string;
  urn: string;
  kind: ComposerPillKind;
  /** Material symbol for resource pills; person and agent pills have fixed marks. */
  icon?: string;
}

export type SerializedComposerPillNode = Spread<ComposerPillPayload, SerializedLexicalNode>;

/**
 * A mention or reference, as an atomic thing rather than as link syntax.
 *
 * The composer's wire format is unchanged -- `getTextContent()` and the
 * serializer both emit the same `[Label](nimbalyst://...)` token the textarea
 * used to hold -- but in the editor the token is one indivisible object. That
 * is the whole reason this is a `DecoratorNode` and not a `LinkNode`: typing at
 * the boundary of a link extends the link, so a mention would silently absorb
 * the next word and the exported token would no longer say what the author
 * sees.
 */
export class ComposerPillNode extends DecoratorNode<React.ReactElement> {
  __label: string;
  __urn: string;
  __kind: ComposerPillKind;
  __icon?: string;

  static getType(): string {
    return 'composer-pill';
  }

  static clone(node: ComposerPillNode): ComposerPillNode {
    return new ComposerPillNode(
      { label: node.__label, urn: node.__urn, kind: node.__kind, icon: node.__icon },
      node.__key,
    );
  }

  constructor(payload: ComposerPillPayload, key?: NodeKey) {
    super(key);
    this.__label = payload.label;
    this.__urn = payload.urn;
    this.__kind = payload.kind;
    this.__icon = payload.icon;
  }

  static importJSON(serialized: SerializedComposerPillNode): ComposerPillNode {
    return $createComposerPillNode(serialized);
  }

  exportJSON(): SerializedComposerPillNode {
    return {
      ...super.exportJSON(),
      type: ComposerPillNode.getType(),
      version: 1,
      label: this.__label,
      urn: this.__urn,
      kind: this.__kind,
      ...(this.__icon !== undefined ? { icon: this.__icon } : {}),
    };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.className = 'composer-pill-host';
    span.setAttribute('data-composer-pill-urn', this.__urn);
    return span;
  }

  updateDOM(): false {
    return false;
  }

  isInline(): true {
    return true;
  }

  isKeyboardSelectable(): boolean {
    return true;
  }

  /**
   * The token, not the label. Anything that reads the editor as text -- the
   * serializer's fallbacks, copy to clipboard, the typeahead's boundary checks
   * -- sees exactly what the message will carry.
   */
  getTextContent(): string {
    return labeledToken(this.__label, this.__urn);
  }

  getUrn(): string {
    return this.__urn;
  }

  getLabel(): string {
    return this.__label;
  }

  decorate(): React.ReactElement {
    return <ComposerPill label={this.__label} kind={this.__kind} icon={this.__icon} />;
  }
}

export function $createComposerPillNode(payload: ComposerPillPayload): ComposerPillNode {
  return new ComposerPillNode(payload);
}

export function $isComposerPillNode(node: LexicalNode | null | undefined): node is ComposerPillNode {
  return node instanceof ComposerPillNode;
}

/**
 * Deliberately the same shapes `CommentBody` renders for a posted message: the
 * point of the rich input is that what you compose looks like what you send.
 */
function ComposerPill({
  label,
  kind,
  icon,
}: {
  label: string;
  kind: ComposerPillKind;
  icon?: string;
}) {
  if (kind === 'person') {
    return (
      <span
        data-testid="composer-pill-person"
        className="composer-pill comment-mention inline-flex select-none items-center gap-1 rounded-[5px] bg-[var(--nim-bg-tertiary)] px-1 align-baseline text-[12px] font-medium text-[var(--nim-text)]"
      >
        <span
          className="comment-mention-avatar flex size-[14px] shrink-0 items-center justify-center rounded-full bg-[var(--nim-bg-active)] text-[8px] font-semibold text-[var(--nim-text-muted)]"
          data-testid="composer-pill-avatar"
          aria-hidden="true"
        >
          {initialsFor(label.replace(/^@/, ''))}
        </span>
        {label}
      </span>
    );
  }

  if (kind === 'agent') {
    return (
      <span
        data-testid="composer-pill-agent"
        className="composer-pill comment-mention comment-mention-agent inline-flex select-none items-center gap-1 rounded-[5px] border border-[color-mix(in_srgb,var(--nim-primary)_30%,transparent)] bg-[color-mix(in_srgb,var(--nim-primary)_14%,transparent)] px-1 align-baseline text-[12px] font-medium text-[var(--nim-text)]"
      >
        <span
          className="comment-mention-agent-glyph flex size-[14px] shrink-0 items-center justify-center rounded-[4px] text-[var(--nim-primary)]"
          data-testid="composer-pill-agent-glyph"
          aria-label="Agent"
        >
          <MaterialSymbol icon="smart_toy" size={11} />
        </span>
        {label}
      </span>
    );
  }

  return (
    <span
      data-testid="composer-pill-resource"
      className="composer-pill inline-flex select-none items-center gap-1 rounded-[5px] border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-1 align-baseline text-[12px] text-[var(--nim-text)]"
    >
      <MaterialSymbol icon={icon ?? 'link'} size={11} />
      <span className="max-w-[220px] truncate">{label}</span>
    </span>
  );
}
