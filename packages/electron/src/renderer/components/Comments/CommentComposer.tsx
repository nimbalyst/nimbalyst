import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';

import { FloatingPortal, useFloatingMenu } from '../../hooks/useFloatingMenu';
import { CommentBody } from './CommentBody';
import { EmojiAutocomplete, EmojiPicker, EmojiTriggerButton } from './EmojiPicker';
import { MentionPicker } from './MentionPicker';
import { caretRect } from './caretRect';
import { parseCommentBody } from './commentBodyParser';
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
  detectTrigger,
  labeledToken,
  replaceRange,
  urnsInText,
  type DraftPool,
} from './composerDraft';
import { useResourcePreviews } from './useResourcePreviews';
import { resourceRefToUrn } from './resourceUrn';
import type {
  CommentCapabilities,
  ConversationContext,
  MentionDirectory,
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
 * The shared composer.
 *
 * Text is the model. The mention and reference lists are derived from it (see
 * composerDraft.ts), the preview under the input renders through the same
 * `CommentBody` the posted message will use, and the protocol validators are
 * enforced here rather than approximated -- so what the composer accepts is
 * exactly what the server will accept.
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
  placeholder,
  replyingTo,
  onCancelReply,
  onSubmit,
  autoFocus = false,
  initialText = '',
  initialPool = EMPTY_POOL,
  submitLabel = 'Send',
  onCancel,
}: {
  capabilities: CommentCapabilities;
  context: ConversationContext;
  directory: MentionDirectory;
  orgId: string;
  resolver?: ResourcePreviewResolver | null;
  resourceCandidates?: ResourceCandidate[];
  placeholder?: string;
  /** One displayed level of reply context, mirroring the row. */
  replyingTo?: { commentId: string; actorLabel: string; snippet: string } | null;
  onCancelReply?: () => void;
  onSubmit: (submission: ComposerSubmission) => Promise<void> | void;
  autoFocus?: boolean;
  /** Edit mode seeds the existing body and its resolved pool. */
  initialText?: string;
  initialPool?: DraftPool;
  submitLabel?: string;
  onCancel?: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [pool, setPool] = useState<DraftPool>(initialPool);
  const [caret, setCaret] = useState(initialText.length);
  const [activeIndex, setActiveIndex] = useState(0);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [sending, setSending] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const restriction = describeComposerRestriction(capabilities, context);

  const draft = useMemo(() => deriveDraft(text, 'nimbalystMarkdown', pool), [text, pool]);
  const validation = useMemo(() => validateDraft(draft), [draft]);
  const previews = useResourcePreviews(draft.resourceRefs, resolver);
  const pills = useMemo(
    () => buildPillViews(draft.resourceRefs, previews),
    [draft.resourceRefs, previews],
  );

  // Escape dismisses the autocomplete for the token it is currently on, without
  // dismissing autocomplete for the rest of the message.
  const [suppressedStart, setSuppressedStart] = useState<number | null>(null);
  const trigger = useMemo(() => {
    const detected = detectTrigger(text, caret);
    if (detected && detected.start === suppressedStart) return null;
    return detected;
  }, [text, caret, suppressedStart]);
  const candidates = useMemo<MentionCandidate[]>(
    () => (trigger?.kind === 'mention' ? mentionCandidates(directory, context, trigger.query) : []),
    [trigger, directory, context],
  );
  const emojiSuggestions = useMemo(
    () => (trigger?.kind === 'emoji' ? searchEmoji(trigger.query, 8) : []),
    [trigger],
  );

  const openList = trigger?.kind === 'mention' ? candidates.length : emojiSuggestions.length;

  useEffect(() => {
    setActiveIndex(0);
  }, [trigger?.kind, trigger?.query]);

  // Re-anchor the autocomplete to the caret whenever the query moves.
  useEffect(() => {
    if (!trigger || !textareaRef.current) {
      setAnchorRect(null);
      return;
    }
    const measured = caretRect(textareaRef.current, caret);
    setAnchorRect(measured ?? textareaRef.current.getBoundingClientRect());
  }, [trigger?.start, trigger?.query, caret, trigger]);

  const applyEdit = useCallback((next: { text: string; caret: number }) => {
    setText(next.text);
    setCaret(next.caret);
    // Selection has to be restored after React commits the new value, or the
    // caret snaps to the end and the next keystroke lands in the wrong place.
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(next.caret, next.caret);
    });
  }, []);

  const selectMention = useCallback(
    (candidate: MentionCandidate) => {
      if (!trigger) return;
      if (candidate.kind === 'person') {
        const { pool: nextPool, urn } = addPersonToPool(pool, candidate.person);
        setPool(nextPool);
        applyEdit(replaceRange(text, trigger.start, trigger.end, `${labeledToken(`@${candidate.person.displayName}`, urn)} `));
      } else {
        const { pool: nextPool, urn } = addAgentToPool(pool, candidate.agent, orgId);
        setPool(nextPool);
        applyEdit(replaceRange(text, trigger.start, trigger.end, `${labeledToken(`@${candidate.agent.sessionName}`, urn)} `));
      }
    },
    [applyEdit, orgId, pool, text, trigger],
  );

  const attachResource = useCallback(
    (candidate: ResourceCandidate) => {
      const { pool: nextPool, urn } = addRefToPool(pool, candidate.ref);
      setPool(nextPool);
      const insertAt = caret;
      applyEdit(replaceRange(text, insertAt, insertAt, `${labeledToken(candidate.label, urn)} `));
    },
    [applyEdit, caret, pool, text],
  );

  const removeAttachment = useCallback(
    (urn: string) => {
      // Remove the token, not just the ref, so the body and the derived list
      // cannot disagree about what the message references.
      const escaped = urn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const stripped = text
        .replace(new RegExp(`\\[[^\\]\\n]{0,160}\\]\\(${escaped}\\)\\s?`, 'g'), '')
        .replace(new RegExp(`${escaped}\\s?`, 'g'), '');
      applyEdit({ text: stripped, caret: Math.min(caret, stripped.length) });
    },
    [applyEdit, caret, text],
  );

  const submit = useCallback(async () => {
    if (!validation.canSend) {
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
      setText('');
      setPool(EMPTY_POOL);
      setCaret(0);
      setSuppressedStart(null);
      setShowErrors(false);
    } finally {
      setSending(false);
    }
  }, [draft, onSubmit, validation.canSend]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (openList > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % openList);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + openList) % openList);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        if (trigger?.kind === 'mention') selectMention(candidates[activeIndex]);
        else if (trigger) {
          const entry = emojiSuggestions[activeIndex];
          applyEdit(replaceRange(text, trigger.start, trigger.end, `${entry.glyph} `));
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSuppressedStart(trigger?.start ?? null);
        setAnchorRect(null);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const syncCaret = () => {
    const node = textareaRef.current;
    if (node) setCaret(node.selectionStart ?? 0);
  };

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

      <textarea
        ref={textareaRef}
        value={text}
        rows={2}
        autoFocus={autoFocus}
        data-testid="comment-composer-input"
        aria-label={`Message ${context.surfaceLabel}`}
        placeholder={placeholder ?? `Message ${context.surfaceLabel}. Type @ to mention someone or an agent.`}
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
        }}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onSelect={syncCaret}
        onKeyDown={onKeyDown}
        className="comment-composer-input max-h-[220px] w-full resize-y rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] px-2.5 py-2 text-[13px] leading-[1.5] text-[var(--nim-text)] outline-none placeholder:text-[var(--nim-text-faint)] focus:border-[var(--nim-border-focus)]"
      />

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

      {text.trim().length > 0 && (
        <div className="comment-composer-preview mt-1.5 rounded border border-dashed border-[var(--nim-border)] px-2 py-1.5" data-testid="comment-composer-preview">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)]">Preview</div>
          <CommentBody
            segments={parseCommentBody(draft.body, {
              resourceRefs: draft.resourceRefs,
              mentionedUserIds: draft.mentionedUserIds,
              mentionedAgentSessionIds: draft.mentionedAgentSessionIds,
              directory,
              viewerUserId: '',
              pills,
            })}
          />
        </div>
      )}

      {showErrors && validation.errors.length > 0 && (
        <ul className="comment-composer-errors m-0 mt-1.5 list-none p-0" data-testid="comment-composer-errors">
          {validation.errors.map((error, index) => (
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

      <div className="comment-composer-footer mt-1.5 flex items-center gap-2">
        <EmojiPicker
          placement="top-start"
          testId="composer-emoji-picker"
          onSelect={(shortcode) => {
            const entry = searchEmoji(shortcode, 1)[0];
            applyEdit(replaceRange(text, caret, caret, `${entry ? entry.glyph : `:${shortcode}:`} `));
          }}
          trigger={(props) => (
            <EmojiTriggerButton label="Insert emoji" testId="composer-emoji-trigger" triggerProps={props} />
          )}
        />

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
          disabled={sending || validation.isEmpty}
          aria-disabled={!validation.canSend}
          onClick={() => void submit()}
          className={`comment-composer-send flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium ${
            onCancel ? '' : 'ml-auto'
          } ${
            validation.canSend && !sending
              ? 'bg-[var(--nim-primary)] text-[var(--nim-on-primary)] hover:bg-[var(--nim-primary-hover)]'
              : 'cursor-not-allowed bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-disabled)]'
          }`}
        >
          <MaterialSymbol icon="send" size={13} />
          {sending ? 'Sending' : submitLabel}
        </button>
      </div>

      {trigger?.kind === 'mention' && candidates.length > 0 && (
        <MentionPicker
          anchorRect={anchorRect}
          candidates={candidates}
          activeIndex={activeIndex}
          onSelect={selectMention}
          onActiveIndexChange={setActiveIndex}
        />
      )}

      {trigger?.kind === 'emoji' && emojiSuggestions.length > 0 && (
        <EmojiAutocomplete
          anchorRect={anchorRect}
          entries={emojiSuggestions}
          activeIndex={activeIndex}
          onSelect={(entry) => applyEdit(replaceRange(text, trigger.start, trigger.end, `${entry.glyph} `))}
          onActiveIndexChange={setActiveIndex}
        />
      )}
    </div>
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
