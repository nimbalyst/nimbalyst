/**
 * Tracker sync event atoms.
 *
 * Updated by store/listeners/trackerSyncListeners.ts. Components that
 * previously subscribed to `tracker-sync:*` IPC events directly now read
 * from these atoms.
 */

import { atom } from 'jotai';

/**
 * Latest `tracker-sync:config-changed` event from main.
 *
 * Request-atom shape: each event bumps `version` and replaces `payload`.
 * The Settings > Tracker Config panel uses this to mirror an issueKeyPrefix
 * change applied via sync. Consumers must filter by `payload.workspacePath`
 * (events are global) and use the skip-initial-mount idiom.
 */
export interface TrackerSyncConfigChange {
  version: number;
  payload: { workspacePath: string; config: { issueKeyPrefix: string } };
}

export const trackerSyncConfigChangeAtom = atom<TrackerSyncConfigChange | null>(null);

/**
 * Latest tracker-sync mutation rejection per code. Written by
 * `trackerSyncListeners` when `tracker-sync:mutation-rejected` fires.
 * `TrackerSyncRejectionBanner` reads this to surface key-rotation and
 * staleKeyEpoch failures that would otherwise silently roll back a user
 * edit.
 *
 * Indexed by code so a `rotationLocked` self-clears on the 30s TTL
 * without erasing a still-relevant `staleKeyEpoch`. `forbidden` and
 * `malformed` are bugs, not user-facing states -- the listener routes
 * them to console + toast instead of into this atom.
 *
 * `staleKeyEpoch` and `rotationLocked` are legacy codes: the server-managed
 * custody server can no longer produce them, but they stay typed for
 * compatibility with old servers. `custodyUnavailable` is the current
 * user-facing rejection -- the server could not load the team DEK (the
 * organization was never converted to server-managed custody).
 * `recoveryConflict` means an edit queued before organization recovery was
 * refused and retained in local history instead of being applied.
 */
export type TrackerSyncRejectionCode = 'staleKeyEpoch' | 'rotationLocked' | 'custodyUnavailable' | 'recoveryConflict';

export interface TrackerSyncRejection {
  workspacePath: string;
  code: TrackerSyncRejectionCode;
  itemId: string;
  message?: string;
  /** Wall-clock ms when the listener observed the rejection. */
  timestamp: number;
}

export type TrackerSyncRejectionState = {
  [K in TrackerSyncRejectionCode]: TrackerSyncRejection | null;
};

export const trackerSyncRejectionAtom = atom<TrackerSyncRejectionState>({
  staleKeyEpoch: null,
  rotationLocked: null,
  custodyUnavailable: null,
  recoveryConflict: null,
});

/**
 * The reconnect drain refused to run for this workspace, so team items are not
 * syncing. Written by `trackerSyncListeners` on `tracker-sync:drain-aborted`
 * and cleared on `tracker-sync:drain-recovered`.
 *
 * Not a `TrackerSyncRejection`: nothing was rejected and no edit rolled back.
 * The socket is `connected` and the client declined to push, because it could
 * not resolve the sharing policy and would otherwise have deleted previously
 * shared items from the room on a guess (NIM-2968).
 */
export interface TrackerSyncDrainHold {
  workspacePath: string;
  reason: 'unresolved-policy-would-delete' | 'zero-upserts-with-deletes';
  rowsHeldBack: number;
}

export const trackerSyncDrainHoldAtom = atom<TrackerSyncDrainHold | null>(null);

export interface TrackerSyncConnectionState {
  workspacePath: string;
  status: string;
  projectId: string | null;
}

export const trackerSyncConnectionAtom = atom<TrackerSyncConnectionState | null>(null);
