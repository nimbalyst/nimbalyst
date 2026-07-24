/**
 * Auto-sizing for the tracker detail title field (NIM-1615).
 *
 * The title editor is a textarea rather than an `<input>` so long titles wrap
 * instead of scrolling horizontally. A textarea has a fixed row height, so its
 * height has to be recomputed from the content whenever the text or the
 * available width changes.
 */

import { useCallback, useEffect, useRef } from 'react';

/** Beyond this the title scrolls internally instead of pushing the header down. */
export const TITLE_MAX_HEIGHT_PX = 160;

/** Titles are single-line values; pasted newlines become spaces. */
export function sanitizeTitleInput(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

/**
 * Fit a textarea to its content, capped at `maxHeightPx`. Height is reset to
 * `auto` first so the element can shrink as well as grow.
 */
export function resizeTitleField(
  el: HTMLTextAreaElement | null,
  maxHeightPx: number = TITLE_MAX_HEIGHT_PX
): void {
  if (!el) return;
  el.style.height = 'auto';
  const contentHeight = el.scrollHeight;
  el.style.height = `${Math.min(contentHeight, maxHeightPx)}px`;
  el.style.overflowY = contentHeight > maxHeightPx ? 'auto' : 'hidden';
}

/**
 * Keeps the title textarea sized to its content. Re-fits when `value` changes
 * and when the element's width changes (pane resize), but not when its own
 * height changes -- that would feed back into the observer.
 */
export function useAutoSizedTitle(value: string) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const lastWidthRef = useRef<number | null>(null);

  useEffect(() => {
    resizeTitleField(ref.current);
  }, [value]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return useCallback((el: HTMLTextAreaElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    lastWidthRef.current = null;
    ref.current = el;
    if (!el) return;
    resizeTitleField(el);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined || width === lastWidthRef.current) return;
      lastWidthRef.current = width;
      resizeTitleField(ref.current);
    });
    observer.observe(el);
    observerRef.current = observer;
  }, []);
}
