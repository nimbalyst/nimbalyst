/**
 * Keeps this window's Developer Mode in step with main, which owns the setting.
 *
 * Developer Mode has reverted to Standard Mode in a single window while
 * `app-settings.json` still held `true` (NIM-3963). This listener:
 * - logs every change to the atom with the stack that caused it, so the next
 *   spurious flip names its source;
 * - applies `developerMode` broadcasts from other windows;
 * - re-reads main's value when the window gains focus and, if the window
 *   disagrees, logs an error and adopts main's value.
 */
import { store } from '@nimbalyst/runtime/store';
import {
  developerFeatureSettingsAtom,
  developerModeAtom,
  hasPendingDeveloperFeaturePersist,
} from '../atoms/appSettings';

let listenerRegistered = false;

function applyDeveloperMode(enabled: boolean): void {
  store.set(developerFeatureSettingsAtom, (prev) =>
    prev.developerMode === enabled ? prev : { ...prev, developerMode: enabled },
  );
}

/** Compare this window against main and adopt main's value on a mismatch. */
export async function reconcileDeveloperMode(): Promise<void> {
  const stored = await window.electronAPI.invoke('developer-mode:get');
  if (typeof stored !== 'boolean') return;
  // A local toggle is still in its persist debounce; main is about to change.
  if (hasPendingDeveloperFeaturePersist()) return;
  const local = store.get(developerModeAtom);
  if (local === stored) return;
  console.error(`[developerModeListeners] window had developerMode=${local} but main has ${stored}; adopting main`);
  applyDeveloperMode(stored);
}

export function registerDeveloperModeListener(): void {
  if (listenerRegistered) return;
  if (typeof window === 'undefined' || !window.electronAPI?.onAppSettingsChanged) return;
  listenerRegistered = true;

  let last = store.get(developerModeAtom);
  console.info(`[developerModeListeners] hydrated developerMode=${last}`);
  store.sub(developerModeAtom, () => {
    const next = store.get(developerModeAtom);
    if (next === last) return;
    console.warn(`[developerModeListeners] developerMode ${last} -> ${next}`, new Error('developerMode changed').stack);
    last = next;
  });

  window.electronAPI.onAppSettingsChanged(({ key, value }) => {
    if (key === 'developerMode' && typeof value === 'boolean') applyDeveloperMode(value);
  });

  window.addEventListener('focus', () => {
    reconcileDeveloperMode().catch((error) => {
      console.error('[developerModeListeners] failed to reconcile developerMode with main:', error);
    });
  });
}
