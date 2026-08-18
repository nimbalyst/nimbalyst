/**
 * Central Flush-Before-Close Listener
 *
 * Subscribes to `window:flush-before-close` ONCE (see
 * `main/window/flushWindowBeforeClose.ts`). Main sends this to a donor
 * window right before "Merge All Windows" would close it, so any dirty
 * editor gets a chance to reach disk first instead of being silently
 * discarded -- the window's own `documentEdited` guard never fires (nothing
 * sets it `true`), so this ack is the only real protection.
 *
 * Reuses `DocumentModelRegistry.flushAll()` -- the same "flush every dirty
 * editor" primitive `store/atoms/windowMode.ts` already calls on every
 * Files<->Agent mode switch -- rather than adding a second save-all
 * mechanism. `flushAll()` covers every currently-attached editor in this
 * renderer, not just the active tab: per `TabContent.tsx`'s lazy-mount
 * design, a `TabEditor` stays mounted and attached to its `DocumentModel`
 * once created, even while hidden behind another active tab.
 *
 * `DocumentModel.flushDirtyEditors()` swallows per-callback save errors
 * (logs, does not reject) so a resolved `flushAll()` promise is not proof a
 * write actually landed -- re-check `isDirty()` on every registered path
 * afterwards and report `'still-dirty'` if anything remains. That is what
 * tells main not to close the window.
 *
 * Collaborative (Y.Doc-backed) tabs are intentionally out of scope here --
 * `CollaborativeTabEditor`'s EditorHost has no flush-to-disk operation to
 * perform ("Save: no-op. Content syncs via Y.Doc."), so there is nothing for
 * `flushAll()` to miss. The narrow residual risk is a donor whose *only*
 * unsaved state is collab-unsynced (`hasCollabUnsyncedChanges`); this ack
 * still reports `'flushed'` for that case, same as the existing
 * `close-window-save` path.
 *
 * Call initWindowCloseFlushListeners() once at app startup.
 */

import { DocumentModelRegistry } from '../../services/document-model/DocumentModelRegistry';

const FLUSH_BEFORE_CLOSE_CHANNEL = 'window:flush-before-close';
const FLUSH_BEFORE_CLOSE_RESULT_CHANNEL = 'window:flush-before-close-result';

type FlushBeforeCloseOutcome = 'flushed' | 'still-dirty';

interface FlushBeforeClosePayload {
  requestId?: string;
}

let initialized = false;

export function initWindowCloseFlushListeners(): () => void {
  if (initialized) {
    return () => {};
  }
  initialized = true;

  const unsubscribe = window.electronAPI?.on?.(
    FLUSH_BEFORE_CLOSE_CHANNEL,
    (data: FlushBeforeClosePayload) => {
      void handleFlushRequest(data?.requestId);
    },
  );

  return () => {
    initialized = false;
    if (typeof unsubscribe === 'function') {
      unsubscribe();
    }
  };
}

function sendAck(requestId: string, outcome: FlushBeforeCloseOutcome): void {
  window.electronAPI?.send?.(FLUSH_BEFORE_CLOSE_RESULT_CHANNEL, { requestId, outcome });
}

async function handleFlushRequest(requestId: string | undefined): Promise<void> {
  if (!requestId) return;

  try {
    await DocumentModelRegistry.flushAll();
    const stillDirty = DocumentModelRegistry.getRegisteredPaths().some(
      (path) => DocumentModelRegistry.get(path)?.isDirty(),
    );
    sendAck(requestId, stillDirty ? 'still-dirty' : 'flushed');
  } catch (err) {
    // flushAll()/getRegisteredPaths()/isDirty() throwing means the registry
    // itself is in an unknown state, not that a specific save failed --
    // 'still-dirty' is a conservative "can't confirm it's safe" signal here,
    // not a literal dirty-flag report. Either way main must not close the
    // window on it.
    console.error('[windowCloseFlushListeners] flush-before-close failed:', err);
    sendAck(requestId, 'still-dirty');
  }
}
