import { BrowserWindow } from 'electron';
import { AnalyticsService } from './AnalyticsService';

/**
 * Single place that applies the user's analytics setting.
 *
 * There are two ways to toggle analytics -- the settings UI (`analytics:set-enabled`)
 * and the `analytics_set_enabled` MCP tool -- and both previously wrote the
 * setting directly. That stopped main-process events (every `sendEvent` checks
 * `allowedToSendAnalytics()`) but left the renderer's posthog-js client
 * capturing, because nothing told the renderer anything had changed.
 *
 * Routing both paths through here guarantees three things happen together:
 * the setting is persisted, the posthog-node client opts in/out, and every
 * renderer window is told so its own client can follow.
 */
export async function applyAnalyticsEnabled(enabled: boolean): Promise<void> {
  const analytics = AnalyticsService.getInstance();
  // optIn/optOut persist the setting themselves.
  if (enabled) {
    await analytics.optIn();
  } else {
    await analytics.optOut();
  }
  broadcastAnalyticsEnabled(enabled);
}

/**
 * The renderer PostHog client is per-window, so a toggle in one window has to
 * reach all of them.
 */
function broadcastAnalyticsEnabled(enabled: boolean): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('analytics:enabled-changed', enabled);
    } catch {
      // Window is tearing down; nothing to notify.
    }
  }
}
