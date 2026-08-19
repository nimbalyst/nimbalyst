/**
 * Decides whether one preview is allowed to mount a live editor right now.
 *
 * `EmbedFrame` says in its own header that it has neither visibility gating nor
 * a mount cap -- "Phase 1: always mount the extension". That is defensible for
 * a document with a couple of embeds in it. It is not defensible here: a
 * three-option request mounts three collaborative editors, inside an Inbox pane
 * that may be scrolled past entirely, and a recipient with several requests
 * open would pay for every one of them at once.
 *
 * Two gates, and they are different in kind:
 *
 * - **Visibility** is per-preview and reversible in principle; a preview
 *   scrolled out of view was never worth mounting.
 * - **The cap** is global and deliberately sticky. Once a preview has a slot it
 *   keeps it for its lifetime rather than yielding to whatever scrolled into
 *   view next, because a cap that reshuffles turns scrolling into a mount storm
 *   -- the exact cost it exists to prevent.
 */

import { useEffect, useRef, useState } from 'react';

/**
 * Enough for the "pick one of these three" case with headroom, low enough that
 * a long list of requests cannot mount editors without bound.
 */
export const MAX_CONCURRENT_LIVE_PREVIEWS = 4;

let livePreviewCount = 0;
const slotListeners = new Set<() => void>();

function notifySlotListeners(): void {
  for (const listener of slotListeners) listener();
}

/** Test-only: the module counter outlives a single render tree. */
export function resetLivePreviewSlots(): void {
  livePreviewCount = 0;
  notifySlotListeners();
}

export function livePreviewSlotsInUse(): number {
  return livePreviewCount;
}

export function useLivePreviewSlot<T extends HTMLElement>(enabled: boolean) {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);
  const [hasSlot, setHasSlot] = useState(false);
  const [slotVersion, setSlotVersion] = useState(0);

  useEffect(() => {
    const listener = () => setSlotVersion((version) => version + 1);
    slotListeners.add(listener);
    return () => {
      slotListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!enabled || !node) return;
    if (typeof IntersectionObserver === 'undefined') {
      // No observer (jsdom, older embedders) means we cannot tell what is on
      // screen. Mounting is the honest default -- the cap below still bounds
      // the damage, and a preview that never appears is the worse failure.
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled]);

  useEffect(() => {
    if (!enabled && hasSlot) {
      setHasSlot(false);
      return;
    }
    if (!enabled || !visible || hasSlot) return;
    if (livePreviewCount >= MAX_CONCURRENT_LIVE_PREVIEWS) return;
    livePreviewCount += 1;
    setHasSlot(true);
  }, [enabled, visible, hasSlot, slotVersion]);

  useEffect(() => () => {
    if (hasSlot) {
      livePreviewCount -= 1;
      notifySlotListeners();
    }
  }, [hasSlot]);

  return { ref, mounted: enabled && hasSlot };
}
