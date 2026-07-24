/**
 * Atoms for tracker automation settings.
 *
 * Two-level opt-in:
 * - `enabled`: master toggle for commit-tracker linking. Covers session-based
 *   linking (always on if the session has linked items) AND issue-key parsing
 *   from all commit messages (e.g. NIM-123 in terminal commits).
 * - `autoCloseOnCommit`: only when enabled AND a commit message uses a closing
 *   keyword (Fixes/Closes/Resolves), the tracker item's status changes to done.
 *
 * Disabled by default (opt-in). Persisted via AI settings.
 */

import { atom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { onSettingChanged } from './settingAtomFamily';

export interface TrackerAutomationSettings {
  enabled: boolean;
  autoCloseOnCommit: boolean;
}

const DEFAULT_TRACKER_AUTOMATION: TrackerAutomationSettings = {
  enabled: false,
  autoCloseOnCommit: true,
};

export const trackerAutomationAtom = atom<TrackerAutomationSettings>({ ...DEFAULT_TRACKER_AUTOMATION });

// Mirror cross-window writes so a toggle in another window reflects here.
onSettingChanged('ai.trackerAutomation', (value) => {
  store.set(trackerAutomationAtom, {
    enabled: value?.enabled ?? DEFAULT_TRACKER_AUTOMATION.enabled,
    autoCloseOnCommit: value?.autoCloseOnCommit ?? DEFAULT_TRACKER_AUTOMATION.autoCloseOnCommit,
  });
});

let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 500;

function scheduleTrackerAutomationPersist(settings: TrackerAutomationSettings): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    if (typeof window !== 'undefined' && window.electronAPI) {
      try {
        await window.electronAPI.aiSaveSettings({ trackerAutomation: settings });
      } catch (error) {
        console.error('[trackerAutomationAtoms] Failed to save tracker automation settings:', error);
      }
    }
  }, PERSIST_DEBOUNCE_MS);
}

export const setTrackerAutomationAtom = atom(
  null,
  (get, set, update: Partial<TrackerAutomationSettings>) => {
    const current = get(trackerAutomationAtom);
    const merged = { ...current, ...update };
    set(trackerAutomationAtom, merged);
    scheduleTrackerAutomationPersist(merged);
  }
);

export async function initTrackerAutomationSettings(): Promise<TrackerAutomationSettings> {
  if (typeof window === 'undefined' || !window.electronAPI) {
    return { ...DEFAULT_TRACKER_AUTOMATION };
  }

  try {
    const settings = await window.electronAPI.aiGetSettings();
    const ta = settings?.trackerAutomation;
    if (ta) {
      return {
        enabled: ta.enabled ?? DEFAULT_TRACKER_AUTOMATION.enabled,
        autoCloseOnCommit: ta.autoCloseOnCommit ?? DEFAULT_TRACKER_AUTOMATION.autoCloseOnCommit,
      };
    }
  } catch (error) {
    console.error('[trackerAutomationAtoms] Failed to load tracker automation settings:', error);
  }

  return { ...DEFAULT_TRACKER_AUTOMATION };
}
