import type { TeamInboxSnapshot } from '@nimbalyst/runtime/sync';
import type { Store } from 'jotai/vanilla/store';

import { teamInboxSnapshotAtom } from '../atoms/teamInbox';
import { store } from '../index';
import { setIfChanged } from './atomRevalidation';

function isTeamInboxSnapshot(value: unknown): value is TeamInboxSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TeamInboxSnapshot>;
  return (
    typeof candidate.status === 'string'
    && Array.isArray(candidate.deliveries)
    && Array.isArray(candidate.organizations)
  );
}

/**
 * Subscribe once for the renderer lifetime, including the dedicated
 * `mode=team-management` window. The event subscription is installed before
 * requesting the initial snapshot so no delivery broadcast can fall through
 * the startup gap.
 */
export function initTeamInboxListeners(
  targetStore: Store = store,
): () => void {
  let disposed = false;
  let receivedBroadcast = false;
  const unsubscribe = window.electronAPI.on(
    'team-inbox:state-changed',
    (snapshot: TeamInboxSnapshot) => {
      if (!isTeamInboxSnapshot(snapshot)) return;
      receivedBroadcast = true;
      // The fan-in re-broadcasts the whole snapshot for presence heartbeats and
      // for the read receipts this window's own mark-read produces. Writing a
      // fresh object for unchanged data repainted every row subscribed to it.
      setIfChanged(targetStore, teamInboxSnapshotAtom, snapshot);
    },
  );

  void window.electronAPI.invoke('team-inbox:start')
    .then((snapshot: unknown) => {
      if (
        !disposed
        && !receivedBroadcast
        && isTeamInboxSnapshot(snapshot)
      ) {
        setIfChanged(targetStore, teamInboxSnapshotAtom, snapshot);
      }
    })
    .catch((error) => {
      console.error('[TeamInbox] Failed to start organization fan-in:', error);
    });

  return () => {
    disposed = true;
    unsubscribe();
  };
}
