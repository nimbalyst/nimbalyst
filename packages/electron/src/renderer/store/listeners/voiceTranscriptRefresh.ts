import { store } from '@nimbalyst/runtime/store';
import { reloadSessionDataAtom } from '../atoms/sessions';
import { voiceDbSessionIdAtom, voiceWorkspacePathAtom } from '../atoms/voiceModeState';

/**
 * Voice appends bypass transcript:event. Reload the canonical DB projection
 * after a burst of persisted speech/diagnostic/tool entries so they paint live.
 * Each listener lifetime owns its timer and callbacks: an append that finishes
 * after disposal must not arm another refresh, even after listeners remount.
 */
export function createVoiceTranscriptRefresh() {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule: () => {
      if (disposed || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        const sessionId = store.get(voiceDbSessionIdAtom);
        const workspacePath = store.get(voiceWorkspacePathAtom);
        if (!sessionId || !workspacePath) return;
        void store.set(reloadSessionDataAtom, { sessionId, workspacePath }).catch(error => {
          console.error('[voiceModeListeners] Failed to refresh transcript:', error);
        });
      }, 250);
    },
    dispose: () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
