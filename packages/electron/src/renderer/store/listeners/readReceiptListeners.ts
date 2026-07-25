/**
 * Read Receipt Listener (Electron)
 *
 * Centralized IPC listener for read receipts arriving from the user's other
 * devices (personal-sync inbound / server replay). Merges them advance-only
 * into the reactive receipts atoms; the tracker/doc unread hooks recompute off
 * those atoms. Components never subscribe to this IPC directly.
 *
 * Call initReadReceiptListeners() once in App.tsx on mount.
 */

import { store } from '@nimbalyst/runtime/store';
import { mergeReceipt, trackerReceiptsAtom } from '@nimbalyst/runtime';
import type { ReadReceipt, SyncedReadReceipt } from '@nimbalyst/runtime';
import { docReceiptsAtom } from '../atoms/docUnread';
import { applyTrackerPersonalStateRowAtom } from '../atoms/trackerPersonalState';
import type { TrackerPersonalStateDto } from '../../services/RendererTrackerPersonalStateService';

export function initReadReceiptListeners(): () => void {
  const cleanups: Array<() => void> = [];

  const unsubscribe = window.electronAPI?.on?.(
    'read-receipts:remote-updated',
    (receipt: SyncedReadReceipt) => {
      if (!receipt?.entityKind || !receipt.entityId) return;
      const incoming: ReadReceipt = {
        lastSeenVersion: receipt.lastSeenVersion ?? null,
        lastViewedAt: receipt.lastViewedAt,
      };
      if (receipt.entityKind === 'tracker') {
        const next = new Map(store.get(trackerReceiptsAtom));
        next.set(receipt.entityId, mergeReceipt(next.get(receipt.entityId), incoming));
        store.set(trackerReceiptsAtom, next);
      } else if (receipt.entityKind === 'doc') {
        const next = new Map(store.get(docReceiptsAtom));
        next.set(receipt.entityId, mergeReceipt(next.get(receipt.entityId), incoming));
        store.set(docReceiptsAtom, next);
      }
    },
  );
  if (typeof unsubscribe === 'function') cleanups.push(unsubscribe);

  const unsubscribeTrackerPersonalState = window.electronAPI?.on?.(
    'tracker-personal-state:remote-updated',
    (row: TrackerPersonalStateDto) => store.set(applyTrackerPersonalStateRowAtom, row),
  );
  if (typeof unsubscribeTrackerPersonalState === 'function') cleanups.push(unsubscribeTrackerPersonalState);

  return () => {
    cleanups.forEach((cleanup) => cleanup());
  };
}
