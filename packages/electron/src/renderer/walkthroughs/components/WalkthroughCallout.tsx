/**
 * WalkthroughCallout Component
 *
 * A floating callout/bubble that attaches to UI elements to guide users
 * through features. Supports multi-step navigation, dismissal, and theming.
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { WalkthroughStep, WalkthroughDefinition } from '../types';
import {
  resolveTarget,
  isTargetValid,
  calculateCalloutPosition,
  type CalloutPosition,
} from '../WalkthroughService';
import { getShortcutDisplay } from '../../../shared/KeyboardShortcuts';

/**
 * Parse basic markdown in walkthrough body text.
 * Supports: **bold**, line breaks (paragraphs), and bullet lists (- or *).
 */
function parseMarkdownBody(text: string): React.ReactNode {
  // Split into paragraphs by double newlines
  const paragraphs = text.split(/\n\n+/);

  return paragraphs.map((paragraph, pIndex) => {
    const trimmed = paragraph.trim();
    if (!trimmed) return null;

    // Check if this paragraph is a bullet list
    const lines = trimmed.split('\n');
    const isBulletList = lines.every((line) => /^[-*]\s/.test(line.trim()));

    if (isBulletList) {
      return (
        <ul key={pIndex} className="walkthrough-list list-disc pl-4 my-2 space-y-1">
          {lines.map((line, lIndex) => (
            <li key={lIndex}>{parseBoldText(line.replace(/^[-*]\s*/, '').trim())}</li>
          ))}
        </ul>
      );
    }

    // Regular paragraph - parse bold and render
    return (
      <p key={pIndex} className="walkthrough-paragraph my-2 first:mt-0 last:mb-0">
        {parseBoldText(trimmed.replace(/\n/g, ' '))}
      </p>
    );
  });
}

/**
 * Parse **bold** text within a string.
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

interface WalkthroughCalloutProps {
  /** The walkthrough definition */
  definition: WalkthroughDefinition;
  /** Current step index */
  stepIndex: number;
  /** Called when user clicks Next */
  onNext: () => void;
  /** Called when user clicks Back */
  onBack: () => void;
  /** Called when user dismisses (X button, Escape, or click outside) */
  onDismiss: () => void;
  /** Called when user completes the walkthrough (Done on last step) */
  onComplete: () => void;
}

export function WalkthroughCallout({
  definition,
  stepIndex,
  onNext,
  onBack,
  onDismiss,
  onComplete,
}: WalkthroughCalloutProps) {
  const calloutRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CalloutPosition | null>(null);
  const [targetElement, setTargetElement] = useState<HTMLElement | null>(null);

  const step = definition.steps[stepIndex];
  const isFirstStep = stepIndex === 0;
  const isLastStep = stepIndex === definition.steps.length - 1;
  const totalSteps = definition.steps.length;

  // Find and validate target element
  useEffect(() => {
    if (!step) return;

    const findTarget = () => {
      const target = resolveTarget(step.target);
      if (target && isTargetValid(target)) {
        // Check visibility condition if provided
        if (step.visibilityCondition && !step.visibilityCondition()) {
          setTargetElement(null);
          setPosition(null);
          return;
        }
        setTargetElement(target);
        const pos = calculateCalloutPosition(target, step.placement, step.wide ?? false);
        setPosition(pos);
      } else {
        setTargetElement(null);
        setPosition(null);
      }
    };

    // Find immediately
    findTarget();

    // Re-check periodically in case target becomes available
    const interval = setInterval(findTarget, 500);

    // Also re-check on resize/scroll
    const handleResize = () => findTarget();
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize, true);

    return () => {
      clearInterval(interval);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleResize, true);
    };
  }, [step]);

  // Add/remove highlight class on target element
  useEffect(() => {
    if (!targetElement) return;

    // Add highlight class
    targetElement.classList.add('walkthrough-target-highlight');

    return () => {
      // Remove highlight class on cleanup
      targetElement.classList.remove('walkthrough-target-highlight');
    };
  }, [targetElement]);

  // Handle Escape key and click outside
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (
        calloutRef.current &&
        !calloutRef.current.contains(e.target as Node) &&
        // Don't dismiss if clicking on the target element
        targetElement &&
        !targetElement.contains(e.target as Node)
      ) {
        onDismiss();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onDismiss, targetElement]);

  // Handle action button click
  const handleActionClick = useCallback(() => {
    if (step?.action) {
      step.action.onClick();
    }
  }, [step]);

  // Handle next/complete
  const handleNextOrComplete = useCallback(() => {
    if (isLastStep) {
      onComplete();
    } else {
      onNext();
    }
  }, [isLastStep, onComplete, onNext]);

  // Parse markdown body
  const renderedBody = useMemo(() => parseMarkdownBody(step?.body ?? ''), [step?.body]);

  // Don't render if no valid target
  if (!position || !step) {
    return null;
  }

  // Get arrow position classes
  const getArrowClasses = (arrowPosition: string) => {
    const base =
      'walkthrough-callout-arrow absolute w-3.5 h-3.5 bg-[var(--nim-bg)] border border-[var(--nim-border)]';
    switch (arrowPosition) {
      case 'top':
        return `${base} walkthrough-callout-arrow--top -top-2 border-b-0 border-r-0`;
      case 'bottom':
        return `${base} walkthrough-callout-arrow--bottom -bottom-2 border-t-0 border-l-0`;
      case 'left':
        return `${base} walkthrough-callout-arrow--left -left-2 border-t-0 border-r-0`;
      case 'right':
        return `${base} walkthrough-callout-arrow--right -right-2 border-b-0 border-l-0`;
      default:
        return base;
    }
  };

  // Width classes: default 320px (w-80), wide 420px (w-[420px])
  const widthClass = step.wide ? 'w-[420px]' : 'w-80';

  const callout = (
    <div
      ref={calloutRef}
      className={`walkthrough-callout fixed ${widthClass} bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-[10px] z-[10001] overflow-visible animate-[walkthrough-fade-in_0.2s_ease-out_forwards] shadow-[0_8px_32px_rgba(0,0,0,0.25),0_2px_8px_rgba(0,0,0,0.15)]`}
      style={{
        top: position.top,
        left: position.left,
      }}
      role="dialog"
      aria-labelledby="walkthrough-title"
      aria-describedby="walkthrough-body"
    >
      {/* Arrow - positioned dynamically based on target element */}
      <div
        className={getArrowClasses(position.arrowPosition)}
        style={
          position.arrowPosition === 'left' || position.arrowPosition === 'right'
            ? { top: position.arrowOffset, transform: 'translateY(-50%) rotate(45deg)' }
            : { left: position.arrowOffset, transform: 'translateX(-50%) rotate(45deg)' }
        }
      />

      {/* Content */}
      <div className="walkthrough-callout-content px-5 py-4">
        <div className="walkthrough-callout-title-row flex items-center gap-2.5 mb-2">
          <div
            id="walkthrough-title"
            className="walkthrough-callout-title text-[15px] font-semibold text-[var(--nim-text)] leading-tight"
          >
            {step.title}
          </div>
          {step.shortcut && (
            <kbd className="walkthrough-shortcut inline-flex items-center justify-center h-6 px-2 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-[5px] font-sans text-xs font-medium text-[var(--nim-text-muted)] shadow-[0_1px_2px_rgba(0,0,0,0.05)] whitespace-nowrap shrink-0">
              {getShortcutDisplay(step.shortcut)}
            </kbd>
          )}
          <button
            className="walkthrough-callout-dismiss nim-btn-icon ml-auto shrink-0 text-[var(--nim-text-faint)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text-muted)]"
            onClick={onDismiss}
            aria-label="Dismiss"
          >
            <svg
              className="w-[18px] h-[18px]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div
          id="walkthrough-body"
          className="walkthrough-callout-body text-[13px] leading-relaxed text-[var(--nim-text-muted)]"
        >
          {renderedBody}
        </div>

        {/* Optional action button */}
        {step.action && (
          <div className="walkthrough-callout-action mt-3">
            <button
              className="walkthrough-callout-action-btn inline-flex items-center gap-1.5 px-3.5 py-2 bg-[color-mix(in_srgb,var(--nim-primary)_10%,transparent)] text-[var(--nim-primary)] border border-[color-mix(in_srgb,var(--nim-primary)_20%,transparent)] rounded-md text-[13px] font-medium cursor-pointer transition-all duration-150 hover:bg-[color-mix(in_srgb,var(--nim-primary)_15%,transparent)] hover:border-[color-mix(in_srgb,var(--nim-primary)_30%,transparent)]"
              onClick={handleActionClick}
            >
              {step.action.label}
            </button>
          </div>
        )}
      </div>

      {/* Footer with navigation */}
      <div className="walkthrough-callout-footer flex items-center justify-between px-4 py-3 border-t border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] rounded-b-[10px]">
        <div className="walkthrough-callout-nav flex items-center gap-2">
          {!isFirstStep && (
            <button
              className="walkthrough-callout-btn walkthrough-callout-btn--back px-3 py-1.5 rounded-[5px] text-[13px] font-medium border-none cursor-pointer transition-all duration-150 bg-transparent text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
              onClick={onBack}
            >
              Back
            </button>
          )}
          <button
            className={`walkthrough-callout-btn walkthrough-callout-btn--next px-3 py-1.5 rounded-[5px] text-[13px] font-medium border-none cursor-pointer transition-all duration-150 text-white hover:brightness-110 ${isLastStep ? 'walkthrough-callout-btn--done bg-[#10b981]' : 'bg-[var(--nim-primary)]'}`}
            onClick={handleNextOrComplete}
          >
            {isLastStep ? 'Done' : 'Next'}
          </button>
        </div>
        {totalSteps > 1 && (
          <div className="walkthrough-callout-progress text-xs text-[var(--nim-text-faint)] font-medium">
            {stepIndex + 1} of {totalSteps}
          </div>
        )}
      </div>
    </div>
  );

  // Render in a portal at the document body to avoid z-index issues
  return createPortal(callout, document.body);
}
