import {AnalyticsService} from "../services/analytics/AnalyticsService.ts";
import { FeatureUsageService, FEATURES } from '../services/FeatureUsageService';
import {safeHandle, safeOn} from "../utils/ipcRegistry";

const analytics = AnalyticsService.getInstance();
const featureUsage = FeatureUsageService.getInstance();

/**
 * Last version we reported `update_toast_shown` for, deduped across every
 * renderer window for the process lifetime. See the handler below.
 */
let lastToastShownVersion: string | null = null;

export function registerAnalyticsHandlers() {
  safeHandle("analytics:allowed", (): boolean => {
    return analytics.allowedToSendAnalytics();
  })

  safeHandle("analytics:get-distinct-id", (): string => {
    return analytics.getDistinctId();
  });

  // Release attribution for the renderer's PostHog super-properties, so both
  // sides stamp the same values from the same source rather than each deriving
  // its own from env vars.
  safeHandle("analytics:get-release-attribution", (): { release_channel: string; build_type: string } => {
    return analytics.releaseAttributionForRenderer();
  });

  safeHandle("analytics:opt-in", async (): Promise<void> => {
    return await analytics.optIn();
  });

  safeHandle("analytics:opt-out", async (): Promise<void> => {
    return await analytics.optOut();
  });

  safeHandle("analytics:set-session-id", (_event, sessionId: string): void => {
    return analytics.setSessionId(sessionId);
  });

  // Track keyboard shortcut usage from renderer
  safeOn("analytics:keyboard-shortcut", (_event, data: { shortcut: string; context: string }) => {
    analytics.sendEvent('keyboard_shortcut_used', {
      shortcut: data.shortcut,
      context: data.context,
    });
    featureUsage.recordUsage(FEATURES.KEYBOARD_SHORTCUT_USED);
  });

  // Track toolbar button clicks from renderer
  safeOn("analytics:toolbar-button", (_event, data: { button: string; isFirstUse: boolean }) => {
    analytics.sendEvent('toolbar_button_clicked', {
      button: data.button,
      isFirstUse: data.isFirstUse,
    });
  });

  // Track feature first use
  safeOn("analytics:feature-first-use", (_event, data: { feature: string; daysSinceInstall: string }) => {
    analytics.sendEvent('feature_first_use', {
      feature: data.feature,
      daysSinceInstall: data.daysSinceInstall,
    });
  });

  // Track update toast actually displayed. Fired from the renderer after
  // suppression checks pass, so the count reflects real toast displays
  // rather than every electron-updater 'update-available' callback.
  //
  // Deduped here rather than in the renderer: `initUpdateListeners()` runs per
  // window (App.tsx), and each renderer window is its own JS context, so a
  // guard on that side -- closure or module scope -- is per-window and still
  // multiplies by the number of open windows. Main is the only single owner.
  safeOn("analytics:update-toast-shown", (_event, data: { releaseChannel: string; newVersion: string }) => {
    if (lastToastShownVersion === data.newVersion) return;
    lastToastShownVersion = data.newVersion;
    analytics.sendEvent('update_toast_shown', {
      release_channel: data.releaseChannel,
      new_version: data.newVersion,
    });
  });
}
