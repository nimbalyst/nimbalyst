/**
 * Hook that returns a ref callback for showing live elapsed time.
 *
 * Updates the DOM directly via requestAnimationFrame instead of triggering
 * React re-renders. This is critical because the transcript message reload
 * is debounced — a setState-based interval forces the widget to re-render
 * every second with stale props, keeping the timer running long after the
 * tool actually finishes.
 *
 * Usage:
 *   const elapsedRef = useElapsedTimeRef(message.timestamp);
 *   {isRunning && <span ref={elapsedRef} className="tabular-nums" />}
 *
 * React controls the element lifecycle via the `isRunning` conditional.
 * When `isRunning` becomes false, React removes the element, the ref
 * fires with null, and the animation stops.
 */

import { useRef, useCallback } from 'react';

/**
 * Format milliseconds into a human-readable elapsed time string.
 * - Under 60s: "5s"
 * - Under 60m: "2m 15s"
 * - 60m+: "1h 5m"
 */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Returns a ref callback that keeps an element's textContent updated
 * with the elapsed time, ticking every second via requestAnimationFrame.
 *
 * Attach the ref to a <span> inside an `{isRunning && ...}` block.
 * The timer starts when the element mounts and stops when it unmounts.
 *
 * @param startTimestamp - Epoch ms when the tool started (e.g., `message.timestamp`).
 *                         Pass `undefined` to disable.
 */
export function useElapsedTimeRef(startTimestamp: number | undefined): (node: HTMLElement | null) => void {
  const rafRef = useRef<number | null>(null);
  const lastTextRef = useRef('');

  return useCallback((node: HTMLElement | null) => {
    // Cancel any previous animation
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (!node || !startTimestamp) return;

    let lastSecond = -1;

    const tick = () => {
      const ms = Date.now() - startTimestamp;
      const sec = Math.floor(ms / 1000);

      // Only touch the DOM when the displayed second changes
      if (sec !== lastSecond && ms >= 0) {
        lastSecond = sec;
        const text = formatElapsed(ms);
        if (text !== lastTextRef.current) {
          lastTextRef.current = text;
          node.textContent = text;
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    // Set initial text immediately
    const ms = Date.now() - startTimestamp;
    if (ms >= 0) {
      const text = formatElapsed(ms);
      lastTextRef.current = text;
      node.textContent = text;
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [startTimestamp]);
}
