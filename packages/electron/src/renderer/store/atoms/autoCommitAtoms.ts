/**
 * Atoms for auto-commit setting
 *
 * When enabled, the GitCommitConfirmationWidget automatically commits
 * without waiting for user confirmation.
 * Persisted via AI settings (same store as other AI settings).
 */

import { atom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { onSettingChanged } from './settingAtomFamily';

/**
 * Whether auto-commit is enabled for git commit proposals.
 * Defaults to false (opt-in).
 */
export const autoCommitEnabledAtom = atom<boolean>(false);

// Mirror cross-window writes into the atom so a toggle in another window
// reflects here without waiting for a reload.
onSettingChanged('ai.autoCommitEnabled', (enabled) => {
  store.set(autoCommitEnabledAtom, enabled);
});

/**
 * Debounce timer for persistence.
 */
let autoCommitPersistTimer: ReturnType<typeof setTimeout> | null = null;
const AUTO_COMMIT_PERSIST_DEBOUNCE_MS = 500;

/**
 * Persist auto-commit setting to main process.
 */
function scheduleAutoCommitPersist(enabled: boolean): void {
  if (autoCommitPersistTimer) {
    clearTimeout(autoCommitPersistTimer);
  }
  autoCommitPersistTimer = setTimeout(async () => {
    autoCommitPersistTimer = null;
    if (typeof window === 'undefined' || !window.electronAPI?.settingsSet) return;
    try {
      // Per-key write via SettingsService -- one validated, broadcasted write,
      // no shared payload to step on adjacent fields.
      await window.electronAPI.settingsSet('ai.autoCommitEnabled', enabled);
    } catch (error) {
      console.error('[autoCommitAtoms] Failed to save auto-commit setting:', error);
    }
  }, AUTO_COMMIT_PERSIST_DEBOUNCE_MS);
}

/**
 * Setter atom for auto-commit enabled state.
 * Updates the atom and persists to IPC.
 */
export const setAutoCommitEnabledAtom = atom(
  null,
  (_get, set, enabled: boolean) => {
    set(autoCommitEnabledAtom, enabled);
    scheduleAutoCommitPersist(enabled);
  }
);

/**
 * Initialize auto-commit setting from IPC.
 * Call this once at app startup.
 */
export async function initAutoCommitSetting(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return false;
  }

  try {
    const settings = await window.electronAPI.aiGetSettings();
    return settings?.autoCommitEnabled ?? false;
  } catch (error) {
    console.error('[autoCommitAtoms] Failed to load auto-commit setting:', error);
  }

  return false;
}
