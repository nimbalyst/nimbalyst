/**
 * useColdPaintFallback
 *
 * Defensive recovery for shared `fullDocument` tracker bodies: after the
 * collab WebSocket reaches `connected`, if the editor still reads as
 * visually empty despite a cached body markdown being available, force-paint
 * the cached markdown into the editor so the room finally gets seeded.
 *
 * NIM-1589: a single point-in-time "empty" read races the async
 * Yjs->Lexical reconciliation on a large/slow-to-render doc -- a real,
 * non-empty room can still read as empty at a fixed delay if the binding
 * hasn't finished converting the synced Y.Doc into Lexical nodes yet. That
 * false positive force-paints a duplicate copy of the body straight into
 * the shared Y.Doc, and each duplicate makes the doc bigger and the next
 * render slower -- a runaway feedback loop. Two defenses:
 *   1. A provider-epoch guard so this fires at most once per collab-provider
 *      lifecycle, even if the effect re-arms (e.g. because painting updates
 *      `bodyCacheMarkdown` itself).
 *   2. Two empty reads spaced apart before concluding the room is genuinely
 *      empty, rather than trusting a single early snapshot.
 */

import { useEffect, useRef } from 'react';

export interface UseColdPaintFallbackOptions {
  collabStatus: string;
  bodyCacheMarkdown: string | null;
  providerEpoch: number;
  itemId: string;
  /** Reads whether the editor currently renders as empty. Should read live refs. */
  isVisuallyEmpty: () => boolean;
  /** Applies the cached markdown to the editor. Should read live refs. */
  paint: () => void;
  firstDelayMs?: number;
  secondDelayMs?: number;
}

export function useColdPaintFallback({
  collabStatus,
  bodyCacheMarkdown,
  providerEpoch,
  itemId,
  isVisuallyEmpty,
  paint,
  firstDelayMs = 600,
  secondDelayMs = 1200,
}: UseColdPaintFallbackOptions): void {
  const firedForEpochRef = useRef<number | null>(null);

  useEffect(() => {
    if (collabStatus !== 'connected') return;
    if (!bodyCacheMarkdown || bodyCacheMarkdown.trim().length === 0) return;
    if (firedForEpochRef.current === providerEpoch) return;

    let secondTimer: ReturnType<typeof setTimeout> | undefined;
    const firstTimer = setTimeout(() => {
      if (!isVisuallyEmpty()) return;
      // Confirm on a second, later read. A doc that was mid-render at the
      // first check has had more time to finish reconciling by now; if it
      // still reads empty, the room really is empty.
      secondTimer = setTimeout(() => {
        if (firedForEpochRef.current === providerEpoch) return;
        if (!isVisuallyEmpty()) return;
        firedForEpochRef.current = providerEpoch;
        paint();
      }, secondDelayMs);
    }, firstDelayMs);

    return () => {
      clearTimeout(firstTimer);
      clearTimeout(secondTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collabStatus, bodyCacheMarkdown, providerEpoch, itemId, firstDelayMs, secondDelayMs]);
}
