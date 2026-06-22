/**
 * Atoms for diff peek popover size persistence.
 *
 * The DiffPeekPopover (used by the git changes panel and the git commit
 * proposal widget) is user-resizable. The chosen size persists globally via
 * the AI settings store so that both consumers share the same preference.
 */

import { atom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { onSettingChanged } from './settingAtomFamily';

export interface DiffPeekSize {
  width: number;
  height: number;
}

/**
 * Default size when the user has not yet resized the popover.
 * Matches the historical fixed dimensions (640x380).
 */
export const DEFAULT_DIFF_PEEK_SIZE: DiffPeekSize = { width: 640, height: 380 };

/**
 * Current persisted diff peek size. `null` means "use default".
 */
export const diffPeekSizeAtom = atom<DiffPeekSize | null>(null);

// Mirror cross-window writes so a resize in another window reflects here.
onSettingChanged('ai.diffPeekSize', (size) => {
  store.set(diffPeekSizeAtom, size);
});

let diffPeekPersistTimer: ReturnType<typeof setTimeout> | null = null;
const DIFF_PEEK_PERSIST_DEBOUNCE_MS = 300;

function scheduleDiffPeekSizePersist(size: DiffPeekSize): void {
  if (diffPeekPersistTimer) {
    clearTimeout(diffPeekPersistTimer);
  }
  diffPeekPersistTimer = setTimeout(async () => {
    diffPeekPersistTimer = null;
    if (typeof window !== 'undefined' && window.electronAPI) {
      try {
        await window.electronAPI.aiSaveSettings({ diffPeekSize: size });
      } catch (error) {
        console.error('[diffPeekSizeAtoms] Failed to save diff peek size:', error);
      }
    }
  }, DIFF_PEEK_PERSIST_DEBOUNCE_MS);
}

/**
 * Setter atom: updates the in-memory size and persists to disk (debounced).
 */
export const setDiffPeekSizeAtom = atom(
  null,
  (_get, set, size: DiffPeekSize) => {
    set(diffPeekSizeAtom, size);
    scheduleDiffPeekSizePersist(size);
  }
);

/**
 * Initialize the diff peek size from disk. Call once at app startup.
 */
export async function initDiffPeekSize(): Promise<DiffPeekSize | null> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return null;
  }
  try {
    const settings = await window.electronAPI.aiGetSettings();
    return (settings as { diffPeekSize?: DiffPeekSize | null })?.diffPeekSize ?? null;
  } catch (error) {
    console.error('[diffPeekSizeAtoms] Failed to load diff peek size:', error);
    return null;
  }
}
