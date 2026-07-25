export type MicAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

interface MediaAccessPreferences {
  getMediaAccessStatus(mediaType: 'microphone'): string;
  askForMediaAccess(mediaType: 'microphone'): Promise<boolean>;
}

const MACOS_MICROPHONE_ERROR = 'Microphone access is required for Voice Mode.\n\nPlease grant permission:\n1. Open System Settings\n2. Go to Privacy & Security > Microphone\n3. Enable access for Nimbalyst\n4. Try again';

const WINDOWS_MICROPHONE_ERROR = 'Microphone access is required for Voice Mode.\n\nOpen Windows Settings > Privacy & security > Microphone, then enable Microphone access and Let desktop apps access your microphone. Return to Nimbalyst and try again.';

const WINDOWS_RESTRICTED_MICROPHONE_ERROR = 'Microphone access is restricted by Windows or your organization. Open Windows Settings > Privacy & security > Microphone to review the policy, or contact your administrator.';

/**
 * Verify the OS-level microphone permission before starting the remote voice
 * session. Windows cannot be prompted through Electron, so a denied global
 * Win32 microphone setting must be surfaced with an actionable settings path.
 */
export async function ensureVoiceMicrophoneAccess(
  platform: NodeJS.Platform,
  preferences: MediaAccessPreferences,
): Promise<void> {
  if (platform === 'darwin') {
    let status = preferences.getMediaAccessStatus('microphone') as MicAccessStatus;
    if (status !== 'granted') {
      const granted = await preferences.askForMediaAccess('microphone');
      status = granted
        ? 'granted'
        : preferences.getMediaAccessStatus('microphone') as MicAccessStatus;
    }

    if (status !== 'granted') {
      throw new Error(MACOS_MICROPHONE_ERROR);
    }
    return;
  }

  if (platform === 'win32') {
    const status = preferences.getMediaAccessStatus('microphone') as MicAccessStatus;
    if (status === 'restricted') {
      throw new Error(WINDOWS_RESTRICTED_MICROPHONE_ERROR);
    }
    if (status === 'denied') {
      throw new Error(WINDOWS_MICROPHONE_ERROR);
    }
  }
}

export function getMicrophoneSettingsUrl(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') {
    return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
  }
  if (platform === 'win32') {
    return 'ms-settings:privacy-microphone';
  }
  return null;
}
