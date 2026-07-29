import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

import { ResourcePill } from './ResourcePill';
import type { BodySegment, ResourcePillView } from './commentTypes';

/**
 * Segment renderer.
 *
 * Text is `select-text` because a message body is content, and content areas
 * opt in to selection explicitly (UI_PATTERNS). `whitespace-pre-wrap` preserves
 * the newlines the author typed without turning the body into a `<pre>`.
 */
export function CommentBody({
  segments,
  onOpenResource,
  onOpenMention,
  onOpenSession,
}: {
  segments: readonly BodySegment[];
  onOpenResource?: (pill: ResourcePillView) => void;
  onOpenMention?: (userId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  return (
    <div className="comment-body select-text whitespace-pre-wrap break-words text-[13px] leading-[1.5] text-[var(--nim-text)]">
      {segments.map((segment, index) => (
        <Segment
          key={index}
          segment={segment}
          onOpenResource={onOpenResource}
          onOpenMention={onOpenMention}
          onOpenSession={onOpenSession}
        />
      ))}
    </div>
  );
}

function Segment({
  segment,
  onOpenResource,
  onOpenMention,
  onOpenSession,
}: {
  segment: BodySegment;
  onOpenResource?: (pill: ResourcePillView) => void;
  onOpenMention?: (userId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  switch (segment.type) {
    case 'text':
      return <>{segment.text}</>;

    case 'code':
      return (
        <code className="comment-body-code rounded bg-[var(--nim-code-bg)] px-1 py-px font-[var(--nim-font-mono)] text-[12px] text-[var(--nim-code-text)]">
          {segment.text}
        </code>
      );

    case 'strong':
      return <strong className="comment-body-strong font-semibold">{segment.text}</strong>;

    case 'emphasis':
      return <em className="comment-body-emphasis italic">{segment.text}</em>;

    case 'emoji':
      return (
        <span className="comment-body-emoji" role="img" aria-label={segment.shortcode}>
          {segment.glyph}
        </span>
      );

    case 'mention':
      return (
        <button
          type="button"
          data-testid="comment-mention-person"
          data-user-id={segment.userId}
          title={segment.displayName}
          onClick={() => onOpenMention?.(segment.userId)}
          className={`comment-mention inline-flex items-center gap-1 rounded-[5px] px-1 align-baseline text-[12px] font-medium ${
            segment.isViewer
              ? 'bg-[color-mix(in_srgb,var(--nim-primary)_20%,transparent)] text-[var(--nim-text)]'
              : 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'
          }`}
        >
          {/* Member avatar is the person marker; agents never get one. */}
          <span
            className="comment-mention-avatar flex size-[14px] shrink-0 items-center justify-center rounded-full bg-[var(--nim-bg-active)] text-[8px] font-semibold text-[var(--nim-text-muted)]"
            data-testid="comment-mention-avatar"
            aria-hidden="true"
          >
            {segment.initials}
          </span>
          @{segment.displayName}
        </button>
      );

    case 'agentMention':
      return (
        <button
          type="button"
          data-testid="comment-mention-agent"
          data-session-id={segment.sessionId}
          title={
            segment.ownerDisplayName
              ? `Agent session ${segment.sessionName}, owned by ${segment.ownerDisplayName}`
              : `Agent session ${segment.sessionName}`
          }
          onClick={() => onOpenSession?.(segment.sessionId)}
          className="comment-mention comment-mention-agent inline-flex items-center gap-1 rounded-[5px] border border-[color-mix(in_srgb,var(--nim-primary)_30%,transparent)] bg-[color-mix(in_srgb,var(--nim-primary)_14%,transparent)] px-1 align-baseline text-[12px] font-medium text-[var(--nim-text)] hover:bg-[color-mix(in_srgb,var(--nim-primary)_18%,transparent)]"
        >
          {/* Agent glyph plus session name: the pill has to read as an agent
              after it is placed, without hovering. */}
          <span
            className="comment-mention-agent-glyph flex size-[14px] shrink-0 items-center justify-center rounded-[4px] text-[var(--nim-primary)]"
            data-testid="comment-mention-agent-glyph"
            aria-label="Agent"
          >
            <MaterialSymbol icon="smart_toy" size={11} />
          </span>
          @{segment.sessionName}
        </button>
      );

    case 'resource':
      return <ResourcePill pill={segment.pill} onOpen={onOpenResource} />;

    default:
      return null;
  }
}
