/**
 * Central Sound Listeners
 *
 * Subscribes to `play-completion-sound` and `play-permission-sound` IPC
 * events ONCE and plays the sound via the SoundPlayer service. Components
 * never subscribe to these events directly (otherwise sounds play twice).
 *
 * Call initSoundListeners() once at app startup.
 */

import { store } from '@nimbalyst/runtime/store';
import { getSoundPlayer } from '../../services/SoundPlayer';
import { notificationSettingsAtom } from '../atoms/appSettings';

let initialized = false;

export function initSoundListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const cleanups: Array<() => void> = [];

  const u1 = window.electronAPI?.on?.('play-completion-sound', (soundType: string) => {
    getSoundPlayer().playSound(soundType as any).catch((err: unknown) => {
      console.error('Failed to play completion sound:', err);
    });
  });
  if (typeof u1 === 'function') cleanups.push(u1);

  const u2 = window.electronAPI?.on?.('play-permission-sound', () => {
    getSoundPlayer().playSound('bell').catch((err: unknown) => {
      console.error('Failed to play permission sound:', err);
    });
  });
  if (typeof u2 === 'function') cleanups.push(u2);

  // Keep the custom-sound name in sync when another window changes it.
  const u3 = window.electronAPI?.on?.('completion-sound:custom-changed', (payload: { fileName: string | null }) => {
    const fileName = payload?.fileName ?? null;
    store.set(notificationSettingsAtom, (prev) => ({ ...prev, completionSoundCustomName: fileName }));
  });
  if (typeof u3 === 'function') cleanups.push(u3);

  return () => {
    initialized = false;
    cleanups.forEach((c) => c());
  };
}
