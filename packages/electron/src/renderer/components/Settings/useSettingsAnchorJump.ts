import { useEffect, useRef, type RefObject } from 'react';

/** Panels load their data asynchronously; give the row this long to appear. */
const MAX_WAIT_FRAMES = 120;

/**
 * After Settings search opens a page, scroll the chosen row into view and
 * flash it once (#1574). The row is found by its `data-testid` inside the
 * settings content area.
 *
 * Rows that only render conditionally (a platform, a parent toggle that is
 * off) may never appear. The page is already open by then, so the jump is
 * simply dropped rather than reported.
 */
export function useSettingsAnchorJump(
  containerRef: RefObject<HTMLElement | null>,
  anchor: string | null,
  onDone: () => void,
): void {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!anchor) return;
    let frame = 0;
    let waited = 0;

    const attempt = () => {
      const row = containerRef.current?.querySelector<HTMLElement>(`[data-testid="${CSS.escape(anchor)}"]`);
      if (row) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        flash(row);
        onDoneRef.current();
        return;
      }
      if (++waited >= MAX_WAIT_FRAMES) {
        onDoneRef.current();
        return;
      }
      frame = requestAnimationFrame(attempt);
    };

    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [anchor, containerRef]);
}

function flash(row: HTMLElement): void {
  // Resolved here because a var() reference inside animation keyframes is not
  // reliably resolved; the theme's accent is read once at flash time instead.
  const accent = getComputedStyle(row).getPropertyValue('--nim-primary').trim() || 'currentColor';
  row.animate?.(
    [
      { backgroundColor: `color-mix(in srgb, ${accent} 22%, transparent)` },
      { backgroundColor: 'transparent' },
    ],
    { duration: 1800, easing: 'ease-out' },
  );
}
