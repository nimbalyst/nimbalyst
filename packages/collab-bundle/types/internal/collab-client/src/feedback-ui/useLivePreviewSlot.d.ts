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
/**
 * Enough for the "pick one of these three" case with headroom, low enough that
 * a long list of requests cannot mount editors without bound.
 */
export declare const MAX_CONCURRENT_LIVE_PREVIEWS = 4;
/** Test-only: the module counter outlives a single render tree. */
export declare function resetLivePreviewSlots(): void;
export declare function livePreviewSlotsInUse(): number;
export declare function useLivePreviewSlot<T extends HTMLElement>(enabled: boolean): {
    ref: import("react").RefObject<T | null>;
    mounted: boolean;
};
