/**
 * IPC handlers for Voice Mode settings
 */

import { BrowserWindow, systemPreferences, shell } from 'electron';
import Store from '../../utils/privateSettingsStore';
import { safeHandle } from '../../utils/ipcRegistry';
import {
  getMicrophoneSettingsUrl,
  type MicAccessStatus,
} from './microphoneAccess';

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

// Selectable OpenAI Realtime speech-to-speech models.
type RealtimeModel = 'gpt-realtime-2' | 'gpt-realtime';

// Realtime reasoning-effort throttle.
type RealtimeReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

// Which speech transport to connect to. GPT-Live is the default.
type VoiceEngineId = 'realtime' | 'live';

interface VoiceModeSettings {
  enabled: boolean;
  // Speech transport. Default 'live'.
  engine?: VoiceEngineId;
  voice?: VoiceId;
  // Realtime speech-to-speech model. Default 'gpt-realtime-2'. Realtime-only:
  // this must never be sent to the Live endpoint, and the Live path must not
  // read it. The two engines' model settings are independent so a Live startup
  // failure falls back to Realtime with Realtime's own configuration intact.
  model?: RealtimeModel;
  // Reasoning-effort throttle for the realtime model. Default 'low'. Realtime-only.
  reasoningEffort?: RealtimeReasoningEffort;
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

export interface VoiceEngineResolution {
  /** The engine to actually connect with. */
  engine: VoiceEngineId;
  /** Set only when the requested engine could not be used. */
  fallbackFrom?: VoiceEngineId;
  /** User-facing reason for the fallback. Empty when none happened. */
  reason: string;
}

/**
 * Decide which engine to start, given what the user asked for and whether this
 * account/build can actually run Live.
 *
 * Falling back must be reported, not silent: a user who opted into Live and
 * quietly got Realtime would attribute Realtime's behavior to Live for the rest
 * of the evaluation.
 */
export function resolveVoiceEngine(requested: unknown, liveSupported: boolean): VoiceEngineResolution {
  if (requested === 'realtime') return { engine: 'realtime', reason: '' };
  if (liveSupported) return { engine: 'live', reason: '' };
  return {
    engine: 'realtime',
    fallbackFrom: 'live',
    reason: 'GPT-Live is not available for this account; using the Realtime engine instead.',
  };
}

/**
 * The Realtime model string, or `undefined` on any other engine.
 *
 * Realtime model names are meaningless to the Live endpoint, and sending one
 * there produces a confusing startup error rather than a clean fallback. Route
 * the setting through here so that cannot happen by omission.
 */
export function realtimeModelForEngine(
  engine: VoiceEngineId,
  model: RealtimeModel | undefined,
): RealtimeModel | undefined {
  return engine === 'realtime' ? (model ?? 'gpt-realtime-2') : undefined;
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
        engine: 'live',
        voice: 'alloy',
        showTranscription: true,
        submitDelayMs: 3000,
      };
    } catch (error) {
      console.error('[VoiceModeSettings] Failed to get settings', { error });
      return {
        enabled: false,
        engine: 'live',
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
   * Open the native microphone privacy settings pane on supported platforms.
   */
  safeHandle('voice-mode:open-mic-settings', async () => {
    const settingsUrl = getMicrophoneSettingsUrl(process.platform);
    if (settingsUrl) {
      await shell.openExternal(settingsUrl);
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
