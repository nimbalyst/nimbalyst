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
