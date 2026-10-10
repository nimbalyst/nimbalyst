/**
 * Sizes a block in a page with the shared block resizer's bottom-right grip:
 * placed views, and also code excerpts, transclusions and link cards, which
 * map these attrs to their own markdown. `width` is the block's width in px (unset fills the column); `height`
 * is the view body's height, the element marked `data-placed-view-body` (unset
 * lets the view pick, e.g. fitting a table to its rows). A drag writes both
 * through `onAttrsChange`; double-clicking the grip clears them. With no
 * `onAttrsChange` (read-only page) the saved size applies and there is no grip.
 */

import React, { useLayoutEffect, useRef, type JSX, type ReactNode } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import BlockResizer from '../../ui/BlockResizer';

/** The smallest body a drag can leave, matching the view's own floor. */
export const MIN_PLACED_VIEW_BODY_HEIGHT = 120;
const MIN_PLACED_VIEW_WIDTH = 240;
const BODY_SELECTOR = '[data-placed-view-body]';

/** Px from a view attr, or undefined when unset or not a number. */
export function parsePlacedViewWidth(value: string | undefined): number | undefined {
  const parsed = value ? parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(parsed, MIN_PLACED_VIEW_WIDTH) : undefined;
}

/**
 * The attrs one drag writes: the body height, and the width unless the block
 * was dragged to the column's edge, which means "fill the column".
 */
export function placedViewSizePatch(size: { width: number; height: number; chrome: number; column: number }): Record<string, string | null> {
  const fill = size.width >= size.column - 1;
  return {
    width: fill ? null : String(Math.round(size.width)),
    height: String(Math.max(MIN_PLACED_VIEW_BODY_HEIGHT, Math.round(size.height - size.chrome))),
  };
}

export function PlacedViewResizeFrame({ attrs, onAttrsChange, children }: {
  attrs: Readonly<Record<string, string>>;
  onAttrsChange?: (patch: Readonly<Record<string, string | null>>) => void;
  children: ReactNode;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const frameRef = useRef<HTMLDivElement | null>(null);
  // Frame height minus body height (header, footer, new-item row), measured
  // when a drag starts so the frame's edge maps to the body's height.
  const chromeRef = useRef(0);
  const resizingRef = useRef(false);
  const width = parsePlacedViewWidth(attrs.width);
  const body = () => frameRef.current?.querySelector<HTMLElement>(BODY_SELECTOR) ?? null;
  const measureChrome = () => {
    const frame = frameRef.current;
    const element = body();
    chromeRef.current = frame && element ? frame.offsetHeight - element.offsetHeight : 0;
  };
  useLayoutEffect(() => {
    if (!resizingRef.current) measureChrome();
  });
  const save = (patch: Record<string, string | null>) => {
    try { onAttrsChange?.(patch); } catch (error) { console.warn('[PlacedViewResizeFrame] could not save the view size', error); }
  };
  return (
    <div
      ref={frameRef}
      className="placed-view-resize-frame relative max-w-full"
      style={width ? { width: `${width}px` } : undefined}
    >
      {children}
      {onAttrsChange ? (
        <BlockResizer
          editor={editor}
          targetRef={frameRef}
          handles="corner"
          keepAspectRatio={false}
          minWidth={MIN_PLACED_VIEW_WIDTH}
          minHeight={MIN_PLACED_VIEW_BODY_HEIGHT + chromeRef.current}
          maxWidth={frameRef.current?.parentElement?.clientWidth}
          onResizeStart={() => {
            resizingRef.current = true;
            measureChrome();
          }}
          // The body has a fixed height, so it follows the frame live.
          onResize={(_width, height) => {
            const element = body();
            if (element) element.style.height = `${Math.max(MIN_PLACED_VIEW_BODY_HEIGHT, height - chromeRef.current)}px`;
          }}
          onResizeEnd={(nextWidth, nextHeight) => {
            const column = frameRef.current?.parentElement?.clientWidth ?? Infinity;
            resizingRef.current = false;
            const patch = placedViewSizePatch({ width: nextWidth, height: nextHeight, chrome: chromeRef.current, column });
            const frame = frameRef.current;
            const element = body();
            // Leave the DOM at exactly the saved size: React only rewrites a
            // style whose value changed, so a cleared one could stick.
            if (frame) {
              frame.style.height = '';
              frame.style.width = patch.width ? `${patch.width}px` : '';
            }
            if (element) element.style.height = `${patch.height}px`;
            // Without a body there is no height to save (e.g. a note in place of the view).
            else delete patch.height;
            save(patch);
          }}
          onReset={() => save({ width: null, height: null })}
        />
      ) : null}
    </div>
  );
}
