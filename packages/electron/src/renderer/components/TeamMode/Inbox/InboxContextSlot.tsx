import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useResizeDragShield } from '../../../hooks/useResizeDragShield';
import {
  INBOX_CONTEXT_PANE_MAX_WIDTH,
  INBOX_CONTEXT_PANE_MIN_WIDTH,
  clampInboxContextPaneWidth,
} from './inboxPreferences';

/** Keyboard nudge per arrow press, matching the coarse feel of the drag. */
const KEYBOARD_STEP = 24;

/**
 * The Inbox's right-hand context pane and the divider that sizes it.
 *
 * The pane holds a whole conversation or a feedback-request form, so a fixed
 * 340px made it a preview of a thing rather than a place to work. Width is the
 * user's, persisted through `inboxPreferences`.
 *
 * The transient drag width lives here and `onWidthChange` fires once, on
 * release: the pane follows the pointer without writing a setting per
 * pointermove. Drags go through `useResizeDragShield` so crossing an
 * iframe-backed editor inside the pane cannot swallow the pointer stream.
 */
export function InboxContextSlot({
  width,
  onWidthChange,
  children,
}: {
  width: number;
  onWidthChange: (width: number) => void;
  children: React.ReactNode;
}) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const [dragWidth, setDragWidth] = useState(width);
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);
  const availableRef = useRef<number | undefined>(undefined);
  const latestRef = useRef(width);

  useEffect(() => {
    setDragWidth(width);
    latestRef.current = width;
  }, [width]);

  const commit = useCallback((next: number) => {
    latestRef.current = next;
    setDragWidth(next);
  }, []);

  const beginDrag = useResizeDragShield({
    cursor: 'col-resize',
    onMove: (event) => {
      // The divider is on the pane's left edge, so dragging left widens it.
      commit(clampInboxContextPaneWidth(
        startWidthRef.current + (startXRef.current - event.clientX),
        availableRef.current,
      ));
    },
    onEnd: () => {
      setDragging(false);
      onWidthChange(latestRef.current);
    },
  });

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    startXRef.current = event.clientX;
    startWidthRef.current = latestRef.current;
    availableRef.current = slotRef.current?.parentElement?.getBoundingClientRect().width;
    setDragging(true);
    beginDrag(event);
  }, [beginDrag]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    const step = event.key === 'ArrowLeft' ? KEYBOARD_STEP : event.key === 'ArrowRight' ? -KEYBOARD_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    const available = slotRef.current?.parentElement?.getBoundingClientRect().width;
    const next = clampInboxContextPaneWidth(latestRef.current + step, available);
    commit(next);
    onWidthChange(next);
  }, [commit, onWidthChange]);

  return (
    <div
      ref={slotRef}
      className="inbox-context-slot flex shrink-0"
      style={{ width: `${dragWidth}px` }}
      data-testid="inbox-context-slot"
      data-width={dragWidth}
    >
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize context pane"
        aria-valuenow={dragWidth}
        aria-valuemin={INBOX_CONTEXT_PANE_MIN_WIDTH}
        aria-valuemax={INBOX_CONTEXT_PANE_MAX_WIDTH}
        data-testid="inbox-context-resizer"
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
        // No border of its own: the pane already draws one, and a second line
        // here would read as a seam. The strip only paints while it is the
        // thing being grabbed.
        className={`inbox-context-resizer org-window-no-drag w-1 shrink-0 cursor-col-resize transition-colors hover:bg-[var(--nim-primary)] ${
          dragging ? 'bg-[var(--nim-primary)]' : 'bg-transparent'
        }`}
      />
      {/* A column so the pane inside is height-bounded rather than
          content-sized: its own scroll regions are `min-h-0 flex-1
          overflow-y-auto`, which scrolls nothing until something above them
          actually constrains the height. */}
      <div className="inbox-context-slot-body flex min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
