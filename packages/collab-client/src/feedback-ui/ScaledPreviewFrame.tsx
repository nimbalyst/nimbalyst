/**
 * Renders a full-size document inside a card-sized box.
 *
 * The problem this solves is specific. An option card's preview panel is 128px
 * tall, and the artifacts people put in one -- mockups, documents -- are
 * authored for a full window. Mounting such a thing at natural size in a small
 * box does not "shrink" it; it shows the top-left corner, which is usually a
 * header and tells you nothing about which design you are looking at.
 *
 * So the child renders at its authored width in an off-flow layer and the whole
 * layer is scaled down to fit. Three consequences worth stating:
 *
 * - **`pointer-events: none`.** A scaled document is not a document you can
 *   use; letting clicks land inside it would mean a click that sometimes
 *   selects the option and sometimes does something inside a mockup. Expanding
 *   is what interaction with a preview means.
 * - **`aria-hidden`.** The preview is decorative. The option's real label and
 *   the artifact's own name are already in the card's accessible name, and a
 *   screen reader walking a scaled-down copy of an entire document would be
 *   worse than silence.
 * - **The scale is measured, not assumed.** The card is grid-sized and the grid
 *   is container-query responsive, so the width is not knowable up front.
 */

import React, { useEffect, useRef, useState } from 'react';

/**
 * The width previews are composed at. Mockups in this codebase are authored
 * around 800-1200px; rendering at the low end of that and scaling produces a
 * legible layout rather than a mobile reflow.
 */
export const PREVIEW_AUTHORED_WIDTH = 1000;

export interface ScaledPreviewFrameProps {
  children: React.ReactNode;
  /** Overridden only where an artifact type composes at a different width. */
  authoredWidth?: number;
}

export const ScaledPreviewFrame: React.FC<ScaledPreviewFrameProps> = ({
  children,
  authoredWidth = PREVIEW_AUTHORED_WIDTH,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box) setSize({ width: box.width, height: box.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const scale = size ? size.width / authoredWidth : 0;

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      data-testid="feedback-scaled-preview"
      className="feedback-scaled-preview relative h-full w-full overflow-hidden rounded bg-nim-tertiary"
    >
      {/* Until the first measurement the scale is unknown, and rendering at
          scale 0 would mount the child only to hide it. */}
      {size && (
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{
            width: authoredWidth,
            // Enough vertical extent that the child lays out as it would in a
            // real window; the frame's overflow crops whatever runs past.
            height: size.height / (scale || 1),
            transform: `scale(${scale})`,
            pointerEvents: 'none',
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
};
