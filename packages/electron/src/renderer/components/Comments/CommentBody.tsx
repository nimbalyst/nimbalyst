import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import {
  TrackerReferenceChip,
} from '@nimbalyst/runtime/plugins/TrackerLinkPlugin';

import { ResourcePill } from './ResourcePill';
import type {
  BodySegment,
  MessageAttachmentView,
  ResourceOpenHandler,
  ResourcePillView,
} from './commentTypes';
import { parseResourceUrn } from './resourceUrn';

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
  onOpenResource?: ResourceOpenHandler;
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
  onOpenResource?: ResourceOpenHandler;
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
      return (
        <MessageResourceReference
          pill={segment.pill}
          label={segment.label}
          onOpenResource={onOpenResource}
        />
      );

    case 'attachments':
      return <AttachmentBlock attachments={segment.attachments} />;

    default:
      return null;
  }
}

/**
 * Tracker references reuse the canonical live chip. A project window resolves
 * its title and status from the tracker atom; a dedicated organization window
 * can still render the stable reference and route it to the owning project.
 *
 * The generic redacted pill remains the fallback for unavailable resources.
 */
function MessageResourceReference({
  pill,
  label,
  onOpenResource,
}: {
  pill: ResourcePillView;
  label?: string;
  onOpenResource?: ResourceOpenHandler;
}) {
  const trackerReferenceKey =
    pill.kind === 'tracker'
      ? parseResourceUrn(pill.urn, 'message-resource')?.sourceId ?? null
      : null;
  if (
    trackerReferenceKey
    && pill.availability !== 'unavailable'
    && pill.availability !== 'notInWorkspace'
  ) {
    const unresolvedLabel = label === 'Plan' ? 'Plan' : 'Tracker';
    return (
      <TrackerReferenceChip
        referenceKey={trackerReferenceKey}
        unresolvedLabel={unresolvedLabel}
        onNavigate={
          onOpenResource
            ? () => onOpenResource(
                pill,
                label === 'Plan' ? { trackerView: 'document' } : undefined,
              )
            : undefined
        }
      />
    );
  }

  return <ResourcePill pill={pill} onOpen={onOpenResource} />;
}

/**
 * The message's files, below its text.
 *
 * Images are shown, not linked: an attached screenshot that has to be clicked
 * to be seen is a worse conversation. They are bounded rather than laid out at
 * their natural size, so one large paste cannot take over the thread, and the
 * full-size view is one click away.
 *
 * `collab-asset://` is served by the main-process protocol handler, decrypted,
 * so both the `<img>` and the link are ordinary URLs with no shim in between.
 */
function AttachmentBlock({ attachments }: { attachments: readonly MessageAttachmentView[] }) {
  return (
    <div
      className="comment-body-attachments mt-1.5 flex flex-col items-start gap-1.5"
      data-testid="comment-body-attachments"
    >
      {attachments.map((attachment) =>
        attachment.isImage ? (
          <button
            key={attachment.assetId}
            type="button"
            className="comment-body-attachment-image block max-w-full overflow-hidden rounded-md border border-[var(--nim-border)]"
            data-testid="comment-body-attachment-image"
            data-asset-id={attachment.assetId}
            title={`${attachment.fileName} (${attachment.sizeLabel})`}
            onClick={() => window.open(attachment.src)}
          >
            <img
              src={attachment.src}
              alt={attachment.fileName}
              width={attachment.width}
              height={attachment.height}
              className="max-h-[320px] max-w-full object-contain"
            />
          </button>
        ) : (
          <a
            key={attachment.assetId}
            href={attachment.src}
            download={attachment.fileName}
            className="comment-body-attachment-file flex max-w-full items-center gap-2 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-2 py-1.5 text-[12px] text-[var(--nim-text)] no-underline hover:bg-[var(--nim-bg-hover)]"
            data-testid="comment-body-attachment-file"
            data-asset-id={attachment.assetId}
          >
            <MaterialSymbol icon="draft" size={16} className="shrink-0 text-[var(--nim-text-muted)]" />
            <span className="min-w-0">
              <span className="block max-w-[280px] truncate">{attachment.fileName}</span>
              <span className="block text-[11px] text-[var(--nim-text-faint)]">
                {attachment.sizeLabel}
              </span>
            </span>
            <MaterialSymbol icon="download" size={14} className="shrink-0 text-[var(--nim-text-muted)]" />
          </a>
        ),
      )}
    </div>
  );
}
