import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { MAX_ATTACHMENTS_PER_MESSAGE } from '@nimbalyst/collab-protocol';

import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
import { ComposerLexicalInput, type ComposerInputHandle } from './ComposerLexicalInput';
import { resourceIcon } from './composerRichText';
import type { ComposerPillPayload } from './ComposerPillNode';
import { searchEmoji } from './emojiCatalog';
import {
  buildPillViews,
  describeComposerRestriction,
  mentionCandidates,
  validateDraft,
  type MentionCandidate,
} from './commentViewModel';
import {
  EMPTY_POOL,
  addAgentToPool,
  addPersonToPool,
  addRefToPool,
  deriveDraft,
  urnsInText,
  type DraftPool,
} from './composerDraft';
import { useResourcePreviews } from './useResourcePreviews';
import { parsePastedResourceLink, resourceRefToUrn } from './resourceUrn';
import { formatAttachmentSize, toAttachmentView } from './commentBodyParser';
import type {
  AttachmentComposerHost,
  CommentCapabilities,
  ConversationContext,
  MentionDirectory,
  MessageAttachment,
  ResourceCandidate,
  ResourcePreviewResolver,
  RichCommentBody,
  ResourceRef,
} from './commentTypes';

export interface ComposerSubmission {
  body: RichCommentBody;
  resourceRefs: ResourceRef[];
  mentionedUserIds: string[];
  mentionedAgentSessionIds: string[];
}

/**
 * A file the author has added but not yet sent.
 *
 * Uploaded on add rather than on send: the durable outbox hands back an asset
 * id immediately, so the strip shows a real thumbnail and a message posted
 * offline still carries its files when the queue drains.
 */
interface PendingAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  /** Object URL for an image, revoked when the entry leaves. */
  previewUrl?: string;
  status: 'uploading' | 'ready' | 'failed';
  attachment?: MessageAttachment;
}

function isImageFile(mimeType: string): boolean {
  return mimeType.startsWith('image/') && mimeType !== 'image/svg+xml';
}

function createPendingId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const EMPTY_ATTACHMENTS: readonly MessageAttachment[] = [];

/** Only blob URLs are ours to release; a `collab-asset://` src is not. */
function releasePreview(url: string | undefined): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}

/** An already-posted file, seeded into the strip so an edit keeps it. */
function seedPendingAttachments(
  attachments: readonly MessageAttachment[],
  conversationId: string | undefined,
): PendingAttachment[] {
  return attachments.map((attachment) => ({
    id: attachment.assetId,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    byteSize: attachment.byteSize,
    previewUrl: isImageFile(attachment.mimeType) && conversationId
      ? toAttachmentView(attachment, conversationId).src
      : undefined,
    status: 'ready',
    attachment,
  }));
}

/**
 * The shared composer.
 *
 * Text is the model. The mention and reference lists are derived from it (see
 * composerDraft.ts), and the protocol validators are enforced here rather than
 * approximated -- so what the composer accepts is exactly what the server will
 * accept.
 *
 * The input is the preview. It renders the marks the reader renders (bold,
 * italic, code, pills) as they are typed, so there is nothing to reconcile
 * between what the author sees and what posts. The message text is still the
 * single source of truth: `ComposerLexicalInput` reports it on every edit and
 * everything below this line is unchanged from the textarea it replaced.
 *
 * Over-limit input is retained and reported. Nothing is truncated: a message
 * that quietly loses its tail is worse than one that refuses to send.
 */
export function CommentComposer({
  capabilities,
  context,
  directory,
  orgId,
  resolver = null,
  resourceCandidates = [],
  attachmentHost = null,
  placeholder,
  replyingTo,
  onCancelReply,
  onSubmit,
  autoFocus = false,
  initialText = '',
  initialPool = EMPTY_POOL,
  initialAttachments = EMPTY_ATTACHMENTS,
  submitLabel = 'Send',
  onCancel,
  onDraftChange,
  onDraftCleared,
}: {
  capabilities: CommentCapabilities;
  context: ConversationContext;
  directory: MentionDirectory;
  orgId: string;
  resolver?: ResourcePreviewResolver | null;
  resourceCandidates?: ResourceCandidate[];
  /** Absent on surfaces without an asset store: no paperclip, no paste capture. */
  attachmentHost?: AttachmentComposerHost | null;
  placeholder?: string;
  /** One displayed level of reply context, mirroring the row. */
  replyingTo?: { commentId: string; actorLabel: string; snippet: string } | null;
  onCancelReply?: () => void;
  onSubmit: (submission: ComposerSubmission) => Promise<void> | void;
  autoFocus?: boolean;
  /** Edit mode seeds the existing body and its resolved pool. */
  initialText?: string;
  initialPool?: DraftPool;
  /**
   * Edit mode seeds the message's existing files too. Without this an edit
   * would post a body with no `attachments` and silently detach them.
   */
  initialAttachments?: readonly MessageAttachment[];
  submitLabel?: string;
  onCancel?: () => void;
  /** Main conversation composer only: persist text as the author changes it. */
  onDraftChange?: (text: string) => void;
  /** Main conversation composer only: flush the cleared draft after send. */
  onDraftCleared?: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [pool, setPool] = useState<DraftPool>(initialPool);
  const [sending, setSending] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>(
    () => seedPendingAttachments(initialAttachments, context.conversationId),
  );
  const [attachmentErrors, setAttachmentErrors] = useState<string[]>([]);
  const inputRef = useRef<ComposerInputHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const lastDraftTextRef = useRef(initialText);
  // Read by `addFiles` so a second paste sees the count the first one added
  // without making the callback depend on it.
  const pendingRef = useRef(pendingAttachments);
  pendingRef.current = pendingAttachments;

  const restriction = describeComposerRestriction(capabilities, context);

  const readyAttachments = useMemo(
    () => pendingAttachments.flatMap((entry) => (entry.attachment ? [entry.attachment] : [])),
    [pendingAttachments],
  );
  const draft = useMemo(
    () => deriveDraft(text, 'nimbalystMarkdown', pool, readyAttachments),
    [text, pool, readyAttachments],
  );
  const validation = useMemo(() => validateDraft(draft), [draft]);
  const previews = useResourcePreviews(draft.resourceRefs, resolver);
  const pills = useMemo(
    () => buildPillViews(draft.resourceRefs, previews),
    [draft.resourceRefs, previews],
  );

  const candidatesFor = useCallback(
    (query: string): MentionCandidate[] => mentionCandidates(directory, context, query),
    [directory, context],
  );

  const emojiSuggestionsFor = useCallback((query: string) => searchEmoji(query, 8), []);

  /**
   * The pool records the handle; the editor gets back the pill to insert. Both
   * sides agree on the URN, which is what the derivation keys off.
   */
  const selectMention = useCallback(
    (candidate: MentionCandidate): ComposerPillPayload => {
      if (candidate.kind === 'person') {
        const { pool: nextPool, urn } = addPersonToPool(pool, candidate.person);
        setPool(nextPool);
        return { label: `@${candidate.person.displayName}`, urn, kind: 'person' };
      }
      const { pool: nextPool, urn } = addAgentToPool(pool, candidate.agent, orgId);
      setPool(nextPool);
      return { label: `@${candidate.agent.sessionName}`, urn, kind: 'agent' };
    },
    [orgId, pool],
  );

  const attachResource = useCallback(
    (candidate: ResourceCandidate) => {
      const { pool: nextPool, urn } = addRefToPool(pool, candidate.ref);
      setPool(nextPool);
      inputRef.current?.insertPill({
        label: candidate.label,
        urn,
        kind: 'resource',
        icon: resourceIcon(candidate.ref.kind),
      });
    },
    [pool],
  );

  const attachPastedResourceLink = useCallback(
    (value: string): ComposerPillPayload | null => {
      const parsed = parsePastedResourceLink(value, orgId);
      if (!parsed) return null;

      const { pool: nextPool, urn } = addRefToPool(pool, parsed.ref);
      setPool(nextPool);
      return {
        label: parsed.label,
        urn,
        kind: 'resource',
        icon: resourceIcon(parsed.ref.kind),
      };
    },
    [orgId, pool],
  );

  const removeAttachment = useCallback((urn: string) => {
    // Remove the pill, not just the ref, so the body and the derived list
    // cannot disagree about what the message references.
    inputRef.current?.removePill(urn);
  }, []);

  /**
   * Take files from a paste, a drop, or the picker.
   *
   * Each upload runs on its own: one refused file does not cancel the rest of
   * a multi-file drop, and its reason is stated rather than logged.
   */
  const addFiles = useCallback(
    (files: readonly File[]) => {
      if (!attachmentHost || files.length === 0) return;

      const room = MAX_ATTACHMENTS_PER_MESSAGE - pendingRef.current.length;
      if (room <= 0) {
        setAttachmentErrors([
          `A message can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} files.`,
        ]);
        return;
      }

      const accepted = files.slice(0, room);
      setAttachmentErrors(
        accepted.length < files.length
          ? [
            `Only ${accepted.length} of ${files.length} files were added; a message can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE}.`,
          ]
          : [],
      );

      const entries = accepted.map<PendingAttachment>((file) => ({
        id: createPendingId(),
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        byteSize: file.size,
        previewUrl: isImageFile(file.type) ? URL.createObjectURL(file) : undefined,
        status: 'uploading',
      }));
      setPendingAttachments((current) => [...current, ...entries]);

      entries.forEach((entry, index) => {
        void attachmentHost
          .upload(accepted[index])
          .then((attachment) => {
            setPendingAttachments((now) =>
              now.map((candidate) =>
                candidate.id === entry.id
                  ? {
                    ...candidate,
                    status: 'ready',
                    attachment,
                    fileName: attachment.fileName,
                    mimeType: attachment.mimeType,
                    byteSize: attachment.byteSize,
                  }
                  : candidate,
              ),
            );
          })
          .catch((error: unknown) => {
            setPendingAttachments((now) =>
              now.map((candidate) =>
                candidate.id === entry.id
                  ? { ...candidate, status: 'failed' }
                  : candidate,
              ),
            );
            setAttachmentErrors((now) => [
              ...now,
              error instanceof Error && error.message
                ? error.message
                : `${entry.fileName} could not be attached.`,
            ]);
          });
      });
    },
    [attachmentHost],
  );

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((current) => {
      const leaving = current.find((entry) => entry.id === id);
      releasePreview(leaving?.previewUrl);
      return current.filter((entry) => entry.id !== id);
    });
    setAttachmentErrors([]);
  }, []);

  // Object URLs outlive the component unless they are released explicitly.
  useEffect(
    () => () => {
      for (const entry of pendingRef.current) {
        releasePreview(entry.previewUrl);
      }
    },
    [],
  );

  // An upload still in flight, or one that failed, is a file the author
  // believes is going with this message. Sending past it would drop it
  // silently, so the send waits until every entry is resolved or removed.
  const attachmentsSettling = pendingAttachments.some(
    (entry) => entry.status !== 'ready',
  );

  const handleTextChange = useCallback((next: string) => {
    setText(next);
    if (next === lastDraftTextRef.current) return;
    lastDraftTextRef.current = next;
    onDraftChange?.(next);
  }, [onDraftChange]);

  const submit = useCallback(async () => {
    if (!validation.canSend || attachmentsSettling) {
      setShowErrors(true);
      return;
    }
    setSending(true);
    try {
      await onSubmit({
        body: draft.body,
        resourceRefs: draft.resourceRefs,
        mentionedUserIds: draft.mentionedUserIds,
        mentionedAgentSessionIds: draft.mentionedAgentSessionIds,
      });
      lastDraftTextRef.current = '';
      onDraftCleared?.();
      inputRef.current?.clear();
      setText('');
      setPool(EMPTY_POOL);
      setShowErrors(false);
      // Kept on failure: a send that threw must not also lose the files.
      for (const entry of pendingAttachments) {
        releasePreview(entry.previewUrl);
      }
      setPendingAttachments([]);
      setAttachmentErrors([]);
    } finally {
      setSending(false);
    }
  }, [
    attachmentsSettling,
    draft,
    onSubmit,
    onDraftCleared,
    pendingAttachments,
    validation.canSend,
  ]);

  if (restriction) {
    return (
      <div
        className="comment-composer comment-composer-restricted flex items-start gap-2 border-t border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-3 py-2.5"
        data-testid="comment-composer-restricted"
        data-restriction="true"
      >
        <MaterialSymbol icon={restriction.icon} size={16} />
        <div className="min-w-0">
          <p className="m-0 text-[13px] font-medium text-[var(--nim-text)]" data-testid="comment-composer-restriction-title">
            {restriction.title}
          </p>
          <p className="m-0 mt-0.5 text-[12px] text-[var(--nim-text-muted)]" data-testid="comment-composer-restriction-detail">
            {restriction.detail}
          </p>
        </div>
      </div>
    );
  }

  const attachedUrns = urnsInText(text).filter((urn) => pills[urn]);
  const overBody = validation.bodyBytes > validation.bodyBytesLimit;
  const nearBody = !overBody && validation.bodyBytes > validation.bodyBytesLimit * 0.8;

  return (
    <div
      className="comment-composer border-t border-[var(--nim-border)] bg-[var(--nim-bg)] px-3 py-2"
      data-testid="comment-composer"
    >
      {replyingTo && (
        <div className="comment-composer-reply mb-1.5 flex items-center gap-1.5 rounded border-l-2 border-[var(--nim-primary)] bg-[var(--nim-bg-secondary)] px-2 py-1 text-[11px] text-[var(--nim-text-muted)]" data-testid="comment-composer-reply">
          <MaterialSymbol icon="reply" size={12} />
          <span className="shrink-0 font-medium">{replyingTo.actorLabel}</span>
          <span className="truncate">{replyingTo.snippet}</span>
          <button
            type="button"
            className="ml-auto shrink-0 rounded p-0.5 hover:bg-[var(--nim-bg-hover)]"
            aria-label="Cancel reply"
            data-testid="comment-composer-cancel-reply"
            onClick={onCancelReply}
          >
            <MaterialSymbol icon="close" size={12} />
          </button>
        </div>
      )}

      <ComposerLexicalInput
        ref={inputRef}
        initialText={initialText}
        initialPool={initialPool}
        autoFocus={autoFocus}
        ariaLabel={`Message ${context.surfaceLabel}`}
        placeholder={placeholder ?? `Message ${context.surfaceLabel}. Type @ to mention someone or an agent.`}
        onChange={handleTextChange}
        onSubmit={() => void submit()}
        mentionCandidatesFor={candidatesFor}
        onMentionSelected={selectMention}
        onResourceLinkPasted={attachPastedResourceLink}
        emojiSuggestionsFor={emojiSuggestionsFor}
        onFiles={attachmentHost ? addFiles : undefined}
      />

      {pendingAttachments.length > 0 && (
        <div
          className="comment-composer-pending-attachments mt-1.5 flex flex-wrap gap-1.5"
          data-testid="comment-composer-pending-attachments"
        >
          {pendingAttachments.map((entry) => (
            <PendingAttachmentChip
              key={entry.id}
              entry={entry}
              onRemove={() => removePendingAttachment(entry.id)}
            />
          ))}
        </div>
      )}

      {attachedUrns.length > 0 && (
        <div className="comment-composer-attachments mt-1.5 flex flex-wrap items-center gap-1" data-testid="comment-composer-attachments">
          {attachedUrns.map((urn) => (
            <span
              key={urn}
              className="comment-composer-attachment inline-flex items-center gap-1 rounded-[5px] border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-1.5 py-px text-[12px] text-[var(--nim-text-muted)]"
              data-testid={`comment-composer-attachment-${pills[urn].kind}`}
            >
              <MaterialSymbol icon={pills[urn].icon} size={12} />
              <span className="max-w-[160px] truncate">{pills[urn].label}</span>
              <button
                type="button"
                aria-label={`Remove ${pills[urn].label}`}
                className="rounded hover:bg-[var(--nim-bg-hover)]"
                onClick={() => removeAttachment(urn)}
              >
                <MaterialSymbol icon="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {(attachmentErrors.length > 0 || (showErrors && validation.errors.length > 0)) && (
        <ul className="comment-composer-errors m-0 mt-1.5 list-none p-0" data-testid="comment-composer-errors">
          {/* Attachment refusals are not gated on a send attempt: they answer
              an action the author just took, so they are stated immediately. */}
          {attachmentErrors.map((message, index) => (
            <li
              key={`attachment-${index}`}
              className="flex items-center gap-1.5 text-[12px] text-[var(--nim-error)]"
              data-error-code="attachmentRejected"
            >
              <MaterialSymbol icon="error" size={12} />
              {message}
            </li>
          ))}
          {showErrors && validation.errors.map((error, index) => (
            <li
              key={`${error.code}-${index}`}
              className="flex items-center gap-1.5 text-[12px] text-[var(--nim-error)]"
              data-error-code={error.code}
            >
              <MaterialSymbol icon="error" size={12} />
              {error.message}
              {error.actual !== undefined && error.limit !== undefined && ` (${error.actual} of ${error.limit})`}
            </li>
          ))}
        </ul>
      )}

      {/* No emoji button here on purpose: `:` shortcode typeahead in the input
          is the emoji entry point, and a second, permanently-visible control for
          the same thing is just clutter under every composer. */}
      <div className="comment-composer-footer mt-1.5 flex items-center gap-2">
        {attachmentHost && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              data-testid="comment-composer-file-input"
              onChange={(event) => {
                addFiles([...(event.target.files ?? [])]);
                // Reset, or picking the same file twice in a row is a no-op.
                event.target.value = '';
              }}
            />
            <button
              type="button"
              data-testid="comment-composer-attach-file"
              aria-label="Attach a file"
              title="Attach a file"
              onClick={() => fileInputRef.current?.click()}
              className="comment-composer-attach-file flex size-6 items-center justify-center rounded border border-transparent text-[var(--nim-text-muted)] hover:border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)]"
            >
              <MaterialSymbol icon="attach_file" size={14} />
            </button>
          </>
        )}

        {resourceCandidates.length > 0 && (
          <ResourceAttachMenu candidates={resourceCandidates} onAttach={attachResource} />
        )}

        <BoundsMeter
          overBody={overBody}
          nearBody={nearBody}
          validation={validation}
        />

        {onCancel && (
          <button
            type="button"
            data-testid="comment-composer-cancel"
            onClick={onCancel}
            className="comment-composer-cancel ml-auto shrink-0 rounded-md px-2.5 py-1 text-[12px] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)]"
          >
            Cancel
          </button>
        )}

        <button
          type="button"
          data-testid="comment-composer-send"
          disabled={sending || validation.isEmpty || attachmentsSettling}
          aria-disabled={!validation.canSend || attachmentsSettling}
          onClick={() => void submit()}
          className={`comment-composer-send flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium ${
            onCancel ? '' : 'ml-auto'
          } ${
            validation.canSend && !sending && !attachmentsSettling
              ? 'bg-[var(--nim-primary)] text-[var(--nim-on-primary)] hover:bg-[var(--nim-primary-hover)]'
              : 'cursor-not-allowed bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-disabled)]'
          }`}
        >
          <MaterialSymbol icon="send" size={13} />
          {sending ? 'Sending' : submitLabel}
        </button>
      </div>
    </div>
  );
}

/**
 * One file in the pre-send strip.
 *
 * An image shows itself, because "which screenshot did I just paste" is the
 * question the strip exists to answer; anything else shows a type glyph, its
 * name and its size. Both carry the same remove control -- an attachment added
 * by accident has to be removable without clearing the message.
 */
function PendingAttachmentChip({
  entry,
  onRemove,
}: {
  entry: PendingAttachment;
  onRemove: () => void;
}) {
  const failed = entry.status === 'failed';
  return (
    <span
      className={`comment-composer-pending-attachment relative flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-[12px] ${
        failed
          ? 'border-[var(--nim-error)] text-[var(--nim-error)]'
          : 'border-[var(--nim-border)] text-[var(--nim-text-muted)]'
      }`}
      data-testid="comment-composer-pending-attachment"
      data-status={entry.status}
      data-file-name={entry.fileName}
    >
      {entry.previewUrl ? (
        <img
          src={entry.previewUrl}
          alt={entry.fileName}
          className="size-9 rounded object-cover"
          data-testid="comment-composer-pending-attachment-preview"
        />
      ) : (
        <MaterialSymbol icon={failed ? 'error' : 'draft'} size={16} />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="max-w-[160px] truncate text-[var(--nim-text)]">{entry.fileName}</span>
        <span className="text-[11px] text-[var(--nim-text-faint)]">
          {entry.status === 'uploading'
            ? 'Attaching…'
            : failed
              ? 'Failed'
              : formatAttachmentSize(entry.byteSize)}
        </span>
      </span>
      <button
        type="button"
        aria-label={`Remove ${entry.fileName}`}
        className="rounded p-0.5 hover:bg-[var(--nim-bg-hover)]"
        onClick={onRemove}
      >
        <MaterialSymbol icon="close" size={12} />
      </button>
    </span>
  );
}

/**
 * Bound feedback.
 *
 * Quiet until it matters: counters that are always visible train people to
 * ignore them, so this stays hidden until a limit is within reach or exceeded.
 */
function BoundsMeter({
  overBody,
  nearBody,
  validation,
}: {
  overBody: boolean;
  nearBody: boolean;
  validation: ReturnType<typeof validateDraft>;
}) {
  const parts: string[] = [];
  if (overBody || nearBody) {
    parts.push(`${Math.round(validation.bodyBytes / 1024)}K of ${Math.round(validation.bodyBytesLimit / 1024)}K`);
  }
  if (validation.refCount > validation.refLimit * 0.75) {
    parts.push(`${validation.refCount}/${validation.refLimit} links`);
  }
  if (validation.mentionedUserCount > validation.mentionedUserLimit * 0.75) {
    parts.push(`${validation.mentionedUserCount}/${validation.mentionedUserLimit} mentions`);
  }
  if (validation.mentionedAgentCount > validation.mentionedAgentLimit * 0.75) {
    parts.push(`${validation.mentionedAgentCount}/${validation.mentionedAgentLimit} agents`);
  }
  if (parts.length === 0) return null;

  const bad = validation.errors.length > 0;
  return (
    <span
      className={`comment-composer-bounds text-[11px] tabular-nums ${bad ? 'text-[var(--nim-error)]' : 'text-[var(--nim-text-faint)]'}`}
      data-testid="comment-composer-bounds"
    >
      {parts.join(' · ')}
    </span>
  );
}

function ResourceAttachMenu({
  candidates,
  onAttach,
}: {
  candidates: ResourceCandidate[];
  onAttach: (candidate: ResourceCandidate) => void;
}) {
  const menu = useFloatingMenu({ placement: 'top-start' });
  return (
    <>
      <button
        ref={menu.refs.setReference}
        {...menu.getReferenceProps()}
        type="button"
        data-testid="composer-attach-trigger"
        aria-label="Attach a reference"
        title="Attach a reference"
        onClick={() => menu.setIsOpen(!menu.isOpen)}
        className="composer-attach-trigger flex size-6 items-center justify-center rounded border border-transparent text-[var(--nim-text-muted)] hover:border-[var(--nim-border)] hover:bg-[var(--nim-bg-hover)]"
      >
        <MaterialSymbol icon="add_link" size={14} />
      </button>

      {menu.isOpen && (
        <FloatingPortal>
          <div
            ref={menu.refs.setFloating}
            style={menu.floatingStyles}
            {...menu.getFloatingProps()}
            data-testid="composer-attach-menu"
            className="composer-attach-menu z-[10000] max-h-[280px] w-[280px] overflow-y-auto rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] p-1 shadow-[0_6px_18px_rgba(0,0,0,0.22)]"
          >
            {candidates.map((candidate) => (
              <button
                key={resourceRefToUrn(candidate.ref)}
                type="button"
                data-testid={`composer-attach-${candidate.ref.kind}-${candidate.ref.sourceId}`}
                className="composer-attach-option flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--nim-bg-hover)]"
                onClick={() => {
                  menu.setIsOpen(false);
                  onAttach(candidate);
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-[var(--nim-text)]">{candidate.label}</span>
                  {candidate.secondary && (
                    <span className="block truncate text-[11px] text-[var(--nim-text-faint)]">{candidate.secondary}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
