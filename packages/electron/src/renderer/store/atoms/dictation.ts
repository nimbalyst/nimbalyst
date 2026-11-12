/**
 * Dictation (speech-to-text) state.
 *
 * Settings load once at startup from `dictation:get-settings`, persist through
 * `dictation:set-settings`, and follow other windows via the
 * `dictation:settings-changed` broadcast (store/listeners/dictationListeners.ts).
 *
 * Per-dictation state is an atom family keyed by dictationId. Only the central
 * listener writes events into it; the dictation controller drains the finals
 * queue into whichever surface the dictation targets.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import posthog from 'posthog-js';
import {
  DEFAULT_DICTATION_SETTINGS,
  DICTATION_IPC,
  type DictationAvailability,
  type DictationEngineId,
  type DictationSettings,
} from '../../../shared/dictation';

// ============================================================================
// Settings
// ============================================================================

export const dictationSettingsAtom = atom<DictationSettings>(DEFAULT_DICTATION_SETTINGS);

/** The single switch that hides every dictation affordance. */
export const dictationEnabledAtom = atom((get) => get(dictationSettingsAtom).enabled);

export const setDictationSettingsAtom = atom(
  null,
  async (get, set, updates: Partial<DictationSettings>) => {
    const current = get(dictationSettingsAtom);
    const next = { ...current, ...updates };
    if (updates.enabled !== undefined && updates.enabled !== current.enabled) {
      posthog.capture(updates.enabled ? 'dictation_enabled' : 'dictation_disabled');
    }
    // Optimistic; main normalizes ('' language = system default) and returns
    // the full saved settings, which replace the local copy.
    set(dictationSettingsAtom, { ...next, language: next.language || undefined });
    try {
      const saved: DictationSettings | undefined = await window.electronAPI.invoke(DICTATION_IPC.setSettings, updates);
      if (saved) set(dictationSettingsAtom, { ...DEFAULT_DICTATION_SETTINGS, ...saved });
    } catch (error) {
      console.error('[dictation] Failed to save settings:', error);
    }
  },
);

export async function initDictationSettings(): Promise<DictationSettings> {
  if (typeof window === 'undefined' || !window.electronAPI) return DEFAULT_DICTATION_SETTINGS;
  try {
    const loaded = await window.electronAPI.invoke(DICTATION_IPC.getSettings);
    return { ...DEFAULT_DICTATION_SETTINGS, ...(loaded ?? {}) };
  } catch (error) {
    console.error('[dictation] Failed to load settings:', error);
    return DEFAULT_DICTATION_SETTINGS;
  }
}

/** Engine availability, fetched on demand by the settings panel. Null until fetched. */
export const dictationAvailabilityAtom = atom<DictationAvailability | null>(null);

export const refreshDictationAvailabilityAtom = atom(null, async (_get, set) => {
  try {
    const availability = await window.electronAPI.invoke(DICTATION_IPC.getAvailability);
    set(dictationAvailabilityAtom, availability ?? { onDevice: false, openai: false });
  } catch (error) {
    console.error('[dictation] Failed to read availability:', error);
    set(dictationAvailabilityAtom, { system: false, onDevice: false, openai: false });
  }
});

// ============================================================================
// Per-dictation state
// ============================================================================

export type DictationStatus = 'starting' | 'preparing' | 'listening' | 'stopping' | 'ended' | 'error';

export interface DictationSessionState {
  status: DictationStatus;
  engine: DictationEngineId | null;
  /** Current uncommitted text (replaced by each partial, cleared by a final). */
  partial: string;
  /** Committed segments not yet inserted into the target. */
  finals: string[];
  error: string | null;
}

export const INITIAL_DICTATION_SESSION: DictationSessionState = {
  status: 'starting',
  engine: null,
  partial: '',
  finals: [],
  error: null,
};

export const dictationSessionAtomFamily = atomFamily((_dictationId: string) =>
  atom<DictationSessionState>(INITIAL_DICTATION_SESSION),
);

/** Surfaces dictation can insert into. Also the PostHog `surface` property. */
export type DictationSurface = 'agent-input' | 'markdown' | 'code';

/** The dictation currently recording, if any. One at a time per window. */
export interface ActiveDictation {
  dictationId: string;
  targetKey: string;
  surface: DictationSurface;
  /** Non-silent audio is arriving; until then the user should wait to speak. */
  hearing?: boolean;
}

export const activeDictationAtom = atom<ActiveDictation | null>(null);

/**
 * Host-painted partial for targets that cannot draw it themselves (Lexical).
 * Read by DictationPendingOverlay.
 */
export const dictationOverlayAtom = atom<{ text: string; targetKey: string } | null>(null);
