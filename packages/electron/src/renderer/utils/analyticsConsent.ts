/**
 * Renderer-side analytics consent gate.
 *
 * The main process has always honored the user's analytics setting -- every
 * `AnalyticsService.sendEvent` call checks `allowedToSendAnalytics()`. The
 * renderer did not: `posthog.init` ran unconditionally and no renderer code
 * ever called `opt_out_capturing()`, so turning analytics off in settings
 * stopped main-process events while every `posthog.capture(...)` in the
 * renderer kept firing.
 *
 * This module is the single source of truth the renderer consults. It is
 * deliberately independent of posthog-js's own persisted opt-out state so the
 * user's setting always wins, and so the decision is unit-testable without a
 * PostHog client.
 */

type ConsentListener = (enabled: boolean) => void;

// Default to denied. The bootstrap resolves the real value from the main
// process before React mounts; failing closed means a startup error cannot
// silently produce tracking the user did not agree to.
let consentGranted = false;
const listeners = new Set<ConsentListener>();

/** True when the user's analytics setting permits sending events. */
export function isAnalyticsConsentGranted(): boolean {
  return consentGranted;
}

/**
 * Apply the user's analytics setting. Called once at bootstrap and again
 * whenever main broadcasts a change, in every window.
 */
export function setAnalyticsConsent(enabled: boolean): void {
  if (consentGranted === enabled) return;
  consentGranted = enabled;
  for (const listener of listeners) {
    try {
      listener(enabled);
    } catch (error) {
      console.error('[analytics] Consent listener failed', error);
    }
  }
}

/** Subscribe to consent changes. Returns an unsubscribe closure. */
export function onAnalyticsConsentChange(listener: ConsentListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam. */
export function resetAnalyticsConsentForTests(): void {
  consentGranted = false;
  listeners.clear();
}
