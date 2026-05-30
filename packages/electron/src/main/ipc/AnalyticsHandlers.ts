import {AnalyticsService} from "../services/analytics/AnalyticsService.ts";
import { FeatureUsageService, FEATURES } from '../services/FeatureUsageService';
import {safeHandle, safeOn} from "../utils/ipcRegistry";

const analytics = AnalyticsService.getInstance();
const featureUsage = FeatureUsageService.getInstance();

export function registerAnalyticsHandlers() {
  safeHandle("analytics:allowed", (): boolean => {
    return analytics.allowedToSendAnalytics();
  })

  safeHandle("analytics:get-distinct-id", (): string => {
    return analytics.getDistinctId();
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
  safeOn("analytics:update-toast-shown", (_event, data: { releaseChannel: string; newVersion: string }) => {
    analytics.sendEvent('update_toast_shown', {
      release_channel: data.releaseChannel,
      new_version: data.newVersion,
    });
  });
}
