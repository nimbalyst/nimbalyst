/**
 * Centralized Dictation IPC Listeners
 *
 * The only subscriber to `dictation:event` and `dictation:settings-changed`.
 * Events are folded into dictationSessionAtomFamily(dictationId); the
 * dictation controller reacts to those atoms and inserts text. Components
 * never subscribe to IPC.
 */

import { store } from '@nimbalyst/runtime/store';
import {
  DEFAULT_DICTATION_SETTINGS,
  DICTATION_IPC,
  type DictationEvent,
  type DictationSettings,
} from '../../../shared/dictation';
import {
  dictationSessionAtomFamily,
  dictationSettingsAtom,
  type DictationSessionState,
} from '../atoms/dictation';

/** Fold one engine event into the per-dictation state. Exported for tests. */
export function reduceDictationEvent(
  state: DictationSessionState,
  event: DictationEvent,
): DictationSessionState {
  switch (event.type) {
    case 'preparing':
      return { ...state, status: 'preparing', engine: event.engine };
    case 'ready':
      return { ...state, status: state.status === 'stopping' ? 'stopping' : 'listening', engine: event.engine };
    case 'partial':
      return { ...state, partial: event.text };
    case 'final':
      return {
        ...state,
        partial: '',
        finals: event.text ? [...state.finals, event.text] : state.finals,
      };
    case 'error':
      return { ...state, status: 'error', error: event.message };
    case 'ended':
      return { ...state, status: state.status === 'error' ? 'error' : 'ended', partial: '' };
    default:
      return state;
  }
}

export function initDictationListeners(): () => void {
  const unsubEvent = window.electronAPI.on(DICTATION_IPC.event, (event: DictationEvent) => {
    if (!event?.dictationId) return;
    const atom = dictationSessionAtomFamily(event.dictationId);
    store.set(atom, reduceDictationEvent(store.get(atom), event));
  });

  const unsubSettings = window.electronAPI.on(
    DICTATION_IPC.settingsChanged,
    (settings: DictationSettings) => {
      store.set(dictationSettingsAtom, { ...DEFAULT_DICTATION_SETTINGS, ...settings });
    },
  );

  return () => {
    unsubEvent();
    unsubSettings();
  };
}
