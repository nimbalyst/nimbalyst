import React, { useId, useState } from 'react';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useFloating,
} from '@floating-ui/react';

interface FullTitleTooltipProps {
  /** Full, untruncated label to reveal on hover. */
  label: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * A session-pane label with a viewport-aware tooltip that wraps instead of
 * relying on Chromium's width-limited native `title` tooltip.
 */
export function FullTitleTooltip({ label, className, children }: FullTitleTooltipProps) {
  const [isOpen, setIsOpen] = useState(false);
  const tooltipId = useId();
  const { refs, floatingStyles } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'bottom-start',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  return (
    <>
      <span
        ref={refs.setReference}
        className={className}
        aria-describedby={isOpen ? tooltipId : undefined}
        onMouseEnter={() => setIsOpen(true)}
        onMouseLeave={() => setIsOpen(false)}
      >
        {children}
      </span>
      {isOpen && (
        <FloatingPortal>
          <span
            ref={refs.setFloating}
            id={tooltipId}
            style={floatingStyles}
            className="fixed z-[10002] max-w-[min(36rem,calc(100vw-1rem))] whitespace-pre-wrap break-all rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-1.5 text-xs leading-normal text-[var(--nim-text)] shadow-[0_4px_16px_rgba(0,0,0,0.2)] pointer-events-none"
            role="tooltip"
          >
            {label}
          </span>
        </FloatingPortal>
      )}
    </>
  );
}
