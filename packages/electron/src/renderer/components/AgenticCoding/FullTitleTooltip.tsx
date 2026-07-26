import React, { useId, useState } from 'react';
import {
  autoUpdate,
  FloatingPortal,
  offset,
  size,
  useFloating,
} from '@floating-ui/react';

interface FullTitleTooltipProps {
  /** Full, untruncated label to reveal on hover. */
  label: string;
  className?: string;
  children: React.ReactNode;
}

const HORIZONTAL_PADDING_PX = 6;
const VERTICAL_PADDING_PX = 2;

/**
 * A session-pane label with a viewport-aware tooltip that wraps instead of
 * relying on Chromium's width-limited native `title` tooltip.
 */
export function FullTitleTooltip({ label, className, children }: FullTitleTooltipProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [textStyle, setTextStyle] = useState<React.CSSProperties>();
  const tooltipId = useId();
  const { refs, floatingStyles } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom-start',
    middleware: [
      offset(({ rects }) => ({
        mainAxis: -rects.reference.height - VERTICAL_PADDING_PX,
        crossAxis: -HORIZONTAL_PADDING_PX,
      })),
      size({
        padding: 8,
        apply({ availableWidth, elements }) {
          elements.floating.style.maxWidth = `${availableWidth}px`;
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  return (
    <>
      <span
        ref={refs.setReference}
        className={className}
        aria-describedby={isOpen ? tooltipId : undefined}
        onMouseEnter={(event) => {
          const titleElement = event.currentTarget;
          const computedStyle = window.getComputedStyle(titleElement);
          setTextStyle({
            color: computedStyle.color,
            fontFamily: computedStyle.fontFamily,
            fontSize: computedStyle.fontSize,
            fontWeight: computedStyle.fontWeight,
            letterSpacing: computedStyle.letterSpacing,
            lineHeight: computedStyle.lineHeight,
          });
          setIsOpen(titleElement.scrollWidth > titleElement.clientWidth);
        }}
        onMouseLeave={() => setIsOpen(false)}
      >
        {children}
      </span>
      {isOpen && (
        <FloatingPortal>
          <span
            ref={refs.setFloating}
            id={tooltipId}
            style={{ ...floatingStyles, ...textStyle }}
            className="fixed z-[10002] whitespace-pre-wrap break-all rounded-sm bg-[var(--nim-bg)] px-1.5 py-0.5 text-[var(--nim-text)] shadow-[0_4px_16px_rgba(0,0,0,0.2)] pointer-events-none"
            role="tooltip"
          >
            {label}
          </span>
        </FloatingPortal>
      )}
    </>
  );
}
