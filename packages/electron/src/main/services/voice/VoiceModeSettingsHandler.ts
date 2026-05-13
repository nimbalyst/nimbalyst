/**
 * IPC handlers for Voice Mode settings
 */

import { BrowserWindow, systemPreferences, shell } from 'electron';
import Store from 'electron-store';
import { safeHandle } from '../../utils/ipcRegistry';

type MicAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

interface SystemPromptConfig {
  prepend?: string;
  append?: string;
}

interface TurnDetectionConfig {
  // 'server_vad' for automatic voice activity detection, 'push_to_talk' for manual
  mode: 'server_vad' | 'push_to_talk';
  // VAD threshold (0.0 to 1.0) - higher = less sensitive, requires louder speech
  vadThreshold?: number;
  // How long to wait (ms) after speech stops before processing (100-2000ms)
  silenceDuration?: number;
  // Whether user can interrupt the assistant while it's speaking
  interruptible?: boolean;
}

// All available OpenAI Realtime API voices
type VoiceId = 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar';

interface VoiceModeSettings {
  enabled: boolean;
  voice?: VoiceId;
  showTranscription?: boolean;
  // Turn detection / VAD settings
  turnDetection?: TurnDetectionConfig;
  // System prompt customization for voice agent (GPT-4 Realtime)
  voiceAgentPrompt?: SystemPromptConfig;
  // System prompt customization for coding agent (Claude) during voice mode
  codingAgentPrompt?: SystemPromptConfig;
  // Delay before auto-submitting voice commands (0-10000ms, default 3000)
  submitDelayMs?: number;
}

export function initVoiceModeSettingsHandler() {
  // Voice mode settings are stored in nimbalyst-settings (app settings)
  // NOT ai-settings (AI provider API keys)
  const settingsStore = new Store<Record<string, unknown>>({
    name: 'nimbalyst-settings',
    watch: true,
  });

  /**
   * Get voice mode settings
   */
  safeHandle('voice-mode:get-settings', async () => {
    try {
      const settings = settingsStore.get('voiceMode') as VoiceModeSettings | undefined;
      return settings || {
        enabled: false,
        voice: 'alloy',
        showTranscription: true,
        submitDelayMs: 3000,
      };
    } catch (error) {
      console.error('[VoiceModeSettings] Failed to get settings', { error });
      return {
        enabled: false,
        voice: 'alloy',
        showTranscription: true,
        submitDelayMs: 3000,
      };
    }
  });

  /**
   * Read the current OS-level microphone access status without prompting.
   *
   * Why: the audio-input entitlement is intentionally omitted so background
   * agent processes never trigger a system mic prompt. That means the renderer
   * can't rely on getUserMedia to surface "denied" cleanly -- we need to
   * inspect the OS state directly and offer the user a deep link to System
   * Settings when access isn't granted.
   */
  safeHandle('voice-mode:get-mic-status', async () => {
    const platform = process.platform;
    if (platform !== 'darwin' && platform !== 'win32') {
      return { status: 'granted' as MicAccessStatus, platform };
    }
    const status = systemPreferences.getMediaAccessStatus('microphone') as MicAccessStatus;
    return { status, platform };
  });

  /**
   * Open the macOS System Settings pane for microphone privacy.
   *
   * Why: shell.openExternal handles the x-apple.systempreferences scheme on
   * macOS, but we want a dedicated channel so it's a no-op on other platforms
   * rather than a broken hyperlink.
   */
  safeHandle('voice-mode:open-mic-settings', async () => {
    if (process.platform === 'darwin') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
      return { success: true };
    }
    return { success: false, error: `unsupported platform: ${process.platform}` };
  });

  /**
   * Set voice mode settings
   */
  safeHandle('voice-mode:set-settings', async (_event, settings: VoiceModeSettings) => {
    try {
      settingsStore.set('voiceMode', settings);

      // Broadcast to all windows so Jotai atoms stay in sync
      BrowserWindow.getAllWindows().forEach(window => {
        if (!window.isDestroyed()) {
          window.webContents.send('voice-mode:settings-changed', settings);
        }
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}
