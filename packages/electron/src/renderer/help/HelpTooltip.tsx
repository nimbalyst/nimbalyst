/**
 * HelpTooltip Component
 *
 * A styled tooltip that displays help content from the centralized HelpContent registry.
 * Shows title, description, and keyboard shortcut (if available).
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { atom, useSetAtom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { getHelpContent, type HelpEntry } from './HelpContent';
import { getShortcutDisplay } from '../../shared/KeyboardShortcuts';

// Atom to track when window last regained focus - shared across all HelpTooltip instances
export const lastWindowFocusTimeAtom = atom(0);

/**
 * Parse basic markdown in help text.
 * Supports: **bold**, line breaks (paragraphs), and bullet lists (- or *).
 * Same implementation as WalkthroughCallout for consistency.
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
        <ul key={pIndex} className="help-tooltip-list list-disc pl-4 my-1.5 space-y-0.5">
          {lines.map((line, lIndex) => (
            <li key={lIndex}>{parseBoldText(line.replace(/^[-*]\s*/, '').trim())}</li>
          ))}
        </ul>
      );
    }

    // Regular paragraph - parse bold and render
    return (
      <p key={pIndex} className="help-tooltip-paragraph my-1.5 first:mt-0 last:mb-0">
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

interface HelpTooltipProps {
  /** The data-testid to look up help content for */
  testId: string;
  /** The element to wrap with tooltip functionality */
  children: React.ReactElement;
  /** Override placement (default: auto) */
  placement?: 'top' | 'bottom' | 'left' | 'right' | 'auto';
  /** Delay before showing tooltip in ms (default: 500) */
  delay?: number;
  /** Whether to disable the tooltip */
  disabled?: boolean;
  /** Optional dynamic content rendered below the help body */
  extraContent?: React.ReactNode;
}

interface HelpTooltipChildProps {
  ref?: React.Ref<HTMLElement>;
  onMouseEnter?: React.MouseEventHandler<HTMLElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLElement>;
  onMouseDown?: React.MouseEventHandler<HTMLElement>;
  onFocus?: React.FocusEventHandler<HTMLElement>;
  onBlur?: React.FocusEventHandler<HTMLElement>;
}

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

interface TooltipPosition {
  top: number;
  left: number;
  placement: 'top' | 'bottom' | 'left' | 'right';
}

const TOOLTIP_MARGIN = 8;
const CLICK_COOLDOWN_MS = 5000; // Don't show tooltip for 5 seconds after clicking
const WINDOW_FOCUS_COOLDOWN_MS = 1000; // Don't show tooltip for 1s after window regains focus (must be > tooltip delay)

function calculatePosition(
  targetRect: DOMRect,
  tooltipWidth: number,
  tooltipHeight: number,
  preferredPlacement: 'top' | 'bottom' | 'left' | 'right' | 'auto'
): TooltipPosition {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let placement = preferredPlacement;

  if (placement === 'auto') {
    // Prefer bottom, then top, then right, then left
    const spaceBelow = viewportHeight - targetRect.bottom;
    const spaceAbove = targetRect.top;
    const spaceRight = viewportWidth - targetRect.right;
    const spaceLeft = targetRect.left;

    if (spaceBelow >= tooltipHeight + TOOLTIP_MARGIN) {
      placement = 'bottom';
    } else if (spaceAbove >= tooltipHeight + TOOLTIP_MARGIN) {
      placement = 'top';
    } else if (spaceRight >= tooltipWidth + TOOLTIP_MARGIN) {
      placement = 'right';
    } else if (spaceLeft >= tooltipWidth + TOOLTIP_MARGIN) {
      placement = 'left';
    } else {
      placement = 'bottom';
    }
  }

  let top: number;
  let left: number;

  const targetCenterX = targetRect.left + targetRect.width / 2;
  const targetCenterY = targetRect.top + targetRect.height / 2;

  switch (placement) {
    case 'top':
      top = targetRect.top - tooltipHeight - TOOLTIP_MARGIN;
      left = targetCenterX - tooltipWidth / 2;
      break;
    case 'bottom':
      top = targetRect.bottom + TOOLTIP_MARGIN;
      left = targetCenterX - tooltipWidth / 2;
      break;
    case 'left':
      top = targetCenterY - tooltipHeight / 2;
      left = targetRect.left - tooltipWidth - TOOLTIP_MARGIN;
      break;
    case 'right':
      top = targetCenterY - tooltipHeight / 2;
      left = targetRect.right + TOOLTIP_MARGIN;
      break;
  }

  // Clamp to viewport
  left = Math.max(8, Math.min(left, viewportWidth - tooltipWidth - 8));
  top = Math.max(8, Math.min(top, viewportHeight - tooltipHeight - 8));

  return { top, left, placement };
}

export function HelpTooltip({
  testId,
  children,
  placement = 'auto',
  delay = 500,
  disabled = false,
  extraContent,
}: HelpTooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClickTimeRef = useRef<number>(0);

  const setLastWindowFocusTime = useSetAtom(lastWindowFocusTimeAtom);

  const helpContent = getHelpContent(testId);

  const showTooltip = useCallback(() => {
    // Read current value from store at callback time, not stale closure value
    const lastWindowFocusTime = store.get(lastWindowFocusTimeAtom);

    // console.log('[HelpTooltip] showTooltip called', {
    //   testId,
    //   disabled,
    //   hasHelpContent: !!helpContent,
    //   hasTargetRef: !!targetRef.current,
    //   visibilityState: document.visibilityState,
    //   timeSinceClick: Date.now() - lastClickTimeRef.current,
    //   timeSinceWindowFocus: Date.now() - lastWindowFocusTime,
    // });

    if (disabled || !helpContent || !targetRef.current) return;

    // Don't show if window is not visible (user tabbed away)
    if (document.visibilityState !== 'visible') return;

    // Don't show if we're in the cooldown period after a click
    if (Date.now() - lastClickTimeRef.current < CLICK_COOLDOWN_MS) return;

    // Don't show if we're in the cooldown period after window regained focus
    // This prevents tooltips from appearing on elements that had focus when the user tabbed away
    // Uses store.get() to read CURRENT atom value, not stale closure from render time
    if (Date.now() - lastWindowFocusTime < WINDOW_FOCUS_COOLDOWN_MS) return;

    // console.log('[HelpTooltip] showing tooltip for', testId);
    const rect = targetRef.current.getBoundingClientRect();
    // Estimate tooltip size (will be refined after render)
    const estimatedWidth = 280;
    const estimatedHeight = 80;
    const pos = calculatePosition(rect, estimatedWidth, estimatedHeight, placement);
    setPosition(pos);
    setIsVisible(true);
  }, [disabled, helpContent, placement, testId]);

  const hideTooltip = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsVisible(false);
  }, []);

  const handleMouseEnter = useCallback(() => {
    // console.log('[HelpTooltip] handleMouseEnter', testId);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = setTimeout(showTooltip, delay);
  }, [delay, showTooltip, testId]);

  const handleMouseLeave = useCallback(() => {
    hideTooltip();
  }, [hideTooltip]);

  // Refine position after tooltip renders
  useEffect(() => {
    if (isVisible && tooltipRef.current && targetRef.current) {
      const tooltipRect = tooltipRef.current.getBoundingClientRect();
      const targetRect = targetRef.current.getBoundingClientRect();
      const pos = calculatePosition(
        targetRect,
        tooltipRect.width,
        tooltipRect.height,
        placement
      );
      setPosition(pos);
    }
  }, [isVisible, placement]);

  // Hide tooltip when window loses focus or page becomes hidden (e.g., user tabs away from app)
  // and track when window regains focus to prevent tooltips from appearing
  // on elements that retained focus while the window was inactive
  useEffect(() => {
    const handleWindowBlur = () => {
      // console.log('[HelpTooltip] window blur', testId);
      hideTooltip();
    };
    const handleWindowFocus = () => {
      // console.log('[HelpTooltip] window focus', testId);
      // Set cooldown so focus events on previously-focused elements don't trigger tooltips
      // Uses shared Jotai atom so ALL tooltip instances see this update immediately
      setLastWindowFocusTime(Date.now());
    };
    const handleVisibilityChange = () => {
      // console.log('[HelpTooltip] visibilitychange', testId, document.visibilityState);
      if (document.visibilityState === 'hidden') {
        hideTooltip();
      } else if (document.visibilityState === 'visible') {
        // Set cooldown when page becomes visible again
        setLastWindowFocusTime(Date.now());
      }
    };
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('focus', handleWindowFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [hideTooltip, setLastWindowFocusTime, testId]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // Parse markdown body
  const renderedBody = useMemo(
    () => (helpContent ? parseMarkdownBody(helpContent.body) : null),
    [helpContent]
  );

  // If no help content, just render children without tooltip
  if (!helpContent) {
    return children;
  }

  // Clone children to add event handlers and ref
  const child = children as React.ReactElement<HelpTooltipChildProps>;
  const childWithHandlers = React.cloneElement(child, {
    ref: (el: HTMLElement | null) => {
      targetRef.current = el;
      assignRef(child.props.ref, el);
    },
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      handleMouseEnter();
      child.props.onMouseEnter?.(e);
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      handleMouseLeave();
      child.props.onMouseLeave?.(e);
    },
    onMouseDown: (e: React.MouseEvent<HTMLElement>) => {
      // Hide tooltip immediately on click and start cooldown
      lastClickTimeRef.current = Date.now();
      hideTooltip();
      child.props.onMouseDown?.(e);
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      // console.log('[HelpTooltip] onFocus', testId);
      handleMouseEnter();
      child.props.onFocus?.(e);
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      handleMouseLeave();
      child.props.onBlur?.(e);
    },
  });

  return (
    <>
      {childWithHandlers}
      {isVisible &&
        position &&
        createPortal(
          <div
            ref={tooltipRef}
            className={`help-tooltip help-tooltip--${position.placement} fixed z-[10002] max-w-[280px] px-3 py-2.5 bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-lg shadow-[0_4px_16px_rgba(0,0,0,0.15),0_2px_4px_rgba(0,0,0,0.1)] pointer-events-none nim-animate-slide-up`}
            style={{ top: position.top, left: position.left }}
            role="tooltip"
          >
            <div className="help-tooltip-header flex items-center gap-2 mb-1">
              <span className="help-tooltip-title text-[13px] font-semibold text-[var(--nim-text)]">{helpContent.title}</span>
              {helpContent.shortcut && (
                <kbd className="help-tooltip-shortcut inline-flex items-center justify-center h-5 px-1.5 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded text-[11px] font-medium text-[var(--nim-text-muted)] ml-auto shrink-0 font-sans">
                  {getShortcutDisplay(helpContent.shortcut)}
                </kbd>
              )}
            </div>
            <div className="help-tooltip-body text-xs leading-normal text-[var(--nim-text-muted)]">{renderedBody}</div>
            {extraContent && <div className="help-tooltip-extra mt-2 pt-2 border-t border-[var(--nim-border)]">{extraContent}</div>}
          </div>,
          document.body
        )}
    </>
  );
}
