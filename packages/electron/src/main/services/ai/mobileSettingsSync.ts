
import { syncSettingsToMobile } from '../SyncManager';
import { logger } from '../../utils/logger';

// Debounced re-sync of the available-models list to mobile. The renderer can
// send rapid providerSettings slices when toggling providers, so coalesce them
// into a single mobile sync. Enabling an agent provider (e.g. openai-codex)
// must refresh the mobile model picker, which otherwise only happens on
// desktop startup / mobile reconnect / OpenAI-key change (NIM-976).
let mobileSettingsSyncTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleMobileSettingsSync(): void {
  if (mobileSettingsSyncTimer) clearTimeout(mobileSettingsSyncTimer);
  mobileSettingsSyncTimer = setTimeout(async () => {
    mobileSettingsSyncTimer = null;
    try {
      await syncSettingsToMobile();
    } catch (error) {
      // SyncManager also re-publishes settings when a mobile device reconnects.
      logger.main.warn('[mobileSettingsSync] Failed to publish mobile settings:', error);
    }
  }, 500);
}
