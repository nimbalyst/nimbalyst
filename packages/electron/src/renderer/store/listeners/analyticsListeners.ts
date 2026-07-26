import { setAnalyticsConsent } from '../../utils/analyticsConsent';

/**
 * Centralized listener for the analytics opt-in/opt-out broadcast.
 *
 * The renderer PostHog client is per-window, so main broadcasts
 * `analytics:enabled-changed` to every window when the setting is toggled from
 * the settings UI or the `analytics_set_enabled` MCP tool. This listener feeds
 * that into the renderer consent gate, which `posthog.init`'s `before_send`
 * consults before letting any event out.
 *
 * Subscribed once at startup from `index.tsx`, per docs/IPC_LISTENERS.md.
 */
let unsubscribe: (() => void) | null = null;

export function initAnalyticsListeners(): void {
  if (unsubscribe) return;
  unsubscribe = window.electronAPI.on?.(
    'analytics:enabled-changed',
    (enabled: boolean) => setAnalyticsConsent(enabled),
  ) ?? null;
}

/** Test seam. */
export function teardownAnalyticsListeners(): void {
  unsubscribe?.();
  unsubscribe = null;
}
