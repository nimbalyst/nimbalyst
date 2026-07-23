import { describe, expect, it, vi } from 'vitest';
import {
  ensureVoiceMicrophoneAccess,
  getMicrophoneSettingsUrl,
} from '../microphoneAccess';

function makePreferences(statuses: string[], askResult = false) {
  return {
    getMediaAccessStatus: vi.fn(() => statuses.shift() ?? 'unknown'),
    askForMediaAccess: vi.fn(async () => askResult),
  };
}

describe('ensureVoiceMicrophoneAccess', () => {
  it('rejects denied Windows microphone access with actionable privacy steps', async () => {
    const preferences = makePreferences(['denied']);

    await expect(ensureVoiceMicrophoneAccess('win32', preferences)).rejects.toThrow(
      'Windows Settings > Privacy & security > Microphone',
    );
    expect(preferences.askForMediaAccess).not.toHaveBeenCalled();
  });

  it('rejects Windows microphone access restricted by policy', async () => {
    const preferences = makePreferences(['restricted']);

    await expect(ensureVoiceMicrophoneAccess('win32', preferences)).rejects.toThrow(
      'restricted by Windows or your organization',
    );
  });

  it('allows granted Windows microphone access without prompting', async () => {
    const preferences = makePreferences(['granted']);

    await expect(ensureVoiceMicrophoneAccess('win32', preferences)).resolves.toBeUndefined();
    expect(preferences.askForMediaAccess).not.toHaveBeenCalled();
  });

  it('prompts for undetermined macOS access and accepts the grant', async () => {
    const preferences = makePreferences(['not-determined'], true);

    await expect(ensureVoiceMicrophoneAccess('darwin', preferences)).resolves.toBeUndefined();
    expect(preferences.askForMediaAccess).toHaveBeenCalledWith('microphone');
  });

  it('does not inspect microphone permission on other platforms', async () => {
    const preferences = makePreferences(['denied']);

    await expect(ensureVoiceMicrophoneAccess('linux', preferences)).resolves.toBeUndefined();
    expect(preferences.getMediaAccessStatus).not.toHaveBeenCalled();
  });
});

describe('getMicrophoneSettingsUrl', () => {
  it('returns the native privacy settings URI for macOS and Windows', () => {
    expect(getMicrophoneSettingsUrl('darwin')).toBe(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    );
    expect(getMicrophoneSettingsUrl('win32')).toBe('ms-settings:privacy-microphone');
    expect(getMicrophoneSettingsUrl('linux')).toBeNull();
  });
});
