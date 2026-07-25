/**
 * TipCard Component
 *
 * A compact card with two rendering variants:
 * - 'floating' (default): fixed bottom-left, rendered through a portal;
 *   shows a dismiss X when `onDismiss` is provided.
 * - 'inline': flows in the parent layout, no portal, no fixed position, no
 *   dismiss affordance.
 *
 * Both variants share the same internal structure (header / body / actions).
 */

import React, { useEffect, useRef, useCallback, useId, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { TipDefinition } from './types';

/**
 * Parse basic markdown in tip body text.
 * Supports: **bold**, line breaks (paragraphs), and bullet lists (- or *).
 */
function parseMarkdownBody(text: string): React.ReactNode {
  const paragraphs = text.split(/\n\n+/);

  return paragraphs.map((paragraph, pIndex) => {
    const trimmed = paragraph.trim();
    if (!trimmed) return null;

    const lines = trimmed.split('\n');
    const isBulletList = lines.every((line) => /^[-*]\s/.test(line.trim()));

    if (isBulletList) {
      return (
        <ul key={pIndex} className="tip-card-list list-disc pl-4 my-2 space-y-1">
          {lines.map((line, lIndex) => (
            <li key={lIndex}>{parseBoldText(line.replace(/^[-*]\s*/, '').trim())}</li>
          ))}
        </ul>
      );
    }

    return (
      <p key={pIndex} className="tip-card-paragraph my-2 first:mt-0 last:mb-0">
        {parseBoldText(trimmed.replace(/\n/g, ' '))}
      </p>
    );
  });
}

/**
 * Parse basic **bold** text within a string.
 */
function parseBoldText(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={index} className="font-semibold text-[var(--nim-text)]">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}

interface TipCardProps {
  /** The tip definition to display */
  tip: TipDefinition;
  /**
   * Called when user clicks X or presses Escape. Only relevant to the
   * floating variant; when omitted, no dismiss affordance is rendered.
   */
  onDismiss?: () => void;
  /** Called when user clicks the primary action */
  onAction: () => void;
  /** Called when user clicks the secondary action */
  onSecondaryAction?: () => void;
  /**
   * Rendering variant.
   * - 'floating' (default): fixed bottom-left via portal.
   * - 'inline': renders in place; no portal, no fixed positioning, no Escape handler.
   */
  variant?: 'floating' | 'inline';
  /**
   * Inline-only: extra controls rendered in the card footer (e.g. "next tip",
   * "all tips" buttons). Floating cards do not render these.
   */
  inlineFooterExtras?: React.ReactNode;
}

export function TipCard({
  tip,
  onDismiss,
  onAction,
  onSecondaryAction,
  variant = 'floating',
  inlineFooterExtras,
}: TipCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const isFloating = variant === 'floating';

  // Handle Escape key for the floating variant only -- inline cards live
  // inside a transcript and shouldn't capture Escape globally.
  useEffect(() => {
    if (!isFloating || !onDismiss) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onDismiss, isFloating]);

  const handleActionClick = useCallback(() => {
    onAction();
  }, [onAction]);

  const handleSecondaryClick = useCallback(() => {
    onSecondaryAction?.();
  }, [onSecondaryAction]);

  const renderedBody = useMemo(() => parseMarkdownBody(tip.content.body), [tip.content.body]);

  const floatingClasses =
    'tip-card fixed bottom-5 left-[50px] w-[340px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-[10px] z-[10000] overflow-hidden shadow-[0_8px_32px_rgba(0,0,0,0.35),0_2px_8px_rgba(0,0,0,0.2)] motion-safe:animate-[tip-slide-in_0.3s_ease-out_forwards]';
  const inlineClasses =
    'tip-card tip-card--inline w-full max-w-[560px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-xl overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,0.04)]';

  // Inline cards use larger spacing and typography than the compact floating card.
  const headerPadding = isFloating ? 'gap-2.5 px-3.5 pt-3.5' : 'gap-3.5 px-5 pt-5';
  const iconSize = isFloating
    ? 'w-8 h-8 rounded-[7px]'
    : 'w-11 h-11 rounded-lg';
  const titleClasses = isFloating
    ? 'text-[13px] font-semibold text-[var(--nim-text)] leading-tight'
    : 'text-[16px] font-semibold text-[var(--nim-text)] leading-snug';
  const bodyClasses = isFloating
    ? 'text-[12.5px] leading-relaxed text-[var(--nim-text-muted)] px-3.5 pt-2 pb-3.5'
    : 'text-[14px] leading-relaxed text-[var(--nim-text-muted)] px-5 pt-3 pb-4';
  const bodyIndent = isFloating
    ? (tip.content.icon ? '3.5rem' : '0.875rem')
    : (tip.content.icon ? '4.75rem' : '1.25rem');
  const actionsClasses = isFloating
    ? 'flex items-center gap-3 px-3.5 pb-3.5'
    : 'flex items-center gap-3 px-5 pb-5';
  const primaryButtonClasses = isFloating
    ? 'inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-[var(--nim-primary)] text-white border-none rounded-md text-[12.5px] font-medium cursor-pointer transition-all duration-150 hover:brightness-110 font-[inherit]'
    : 'inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-[color-mix(in_srgb,var(--nim-primary)_12%,transparent)] text-[var(--nim-primary)] border border-[color-mix(in_srgb,var(--nim-primary)_20%,transparent)] rounded-md text-[13px] font-medium cursor-pointer transition-all duration-150 hover:bg-[color-mix(in_srgb,var(--nim-primary)_18%,transparent)] font-[inherit]';
  const secondaryButtonClasses = isFloating
    ? 'text-[12.5px] text-[var(--nim-text-faint)] bg-transparent border-none cursor-pointer font-[inherit] transition-colors duration-150 hover:text-[var(--nim-text-muted)] hover:underline'
    : 'text-[13px] text-[var(--nim-text-faint)] bg-transparent border-none cursor-pointer font-[inherit] transition-colors duration-150 hover:text-[var(--nim-text-muted)] hover:underline';

  const card = (
    <div
      ref={cardRef}
      className={isFloating ? floatingClasses : inlineClasses}
      role={isFloating ? 'alert' : 'note'}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
    >
      {/* Header: icon + title + dismiss */}
      <div className={`flex items-start ${headerPadding}`}>
        {tip.content.icon && (
          <div className={`${iconSize} bg-[color-mix(in_srgb,var(--nim-primary)_10%,transparent)] border border-[color-mix(in_srgb,var(--nim-primary)_20%,transparent)] flex items-center justify-center shrink-0 mt-px text-[var(--nim-primary)]`}>
            {tip.content.icon}
          </div>
        )}
        <div className="flex-1 min-w-0">
          {!isFloating && (
            <div className="tip-card-overline mb-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--nim-text-faint)]">
              Tip
            </div>
          )}
          <div id={titleId} className={titleClasses}>
            {tip.content.title}
          </div>
        </div>
        {isFloating && onDismiss && (
          <button
            className="nim-btn-icon w-6 h-6 flex items-center justify-center shrink-0 -mt-0.5 -mr-1 text-[var(--nim-text-faint)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text-muted)] rounded transition-all duration-150"
            onClick={onDismiss}
            aria-label="Dismiss tip"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Body */}
      <div
        id={bodyId}
        className={bodyClasses}
        style={{ paddingLeft: bodyIndent }}
      >
        {renderedBody}
      </div>

      {/* Actions */}
      {(tip.content.action || tip.content.secondaryAction || (!isFloating && inlineFooterExtras)) && (
        <div
          className={actionsClasses}
          style={{ paddingLeft: bodyIndent }}
        >
          {tip.content.action && (
            <button
              className={primaryButtonClasses}
              onClick={handleActionClick}
            >
              {tip.content.action.label}
            </button>
          )}
          {tip.content.secondaryAction && (
            <button
              className={secondaryButtonClasses}
              onClick={handleSecondaryClick}
            >
              {tip.content.secondaryAction.label}
            </button>
          )}
          {!isFloating && inlineFooterExtras && (
            <div className="ml-auto flex items-center gap-1.5">{inlineFooterExtras}</div>
          )}
        </div>
      )}
    </div>
  );

  return isFloating ? createPortal(card, document.body) : card;
}
