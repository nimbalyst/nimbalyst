import {
  getTrackerItemForSync,
  onTrackerSyncWorkspaceConnected,
} from '../TrackerSyncManager';
import { publishPendingTrackerCreations } from './publishTrackerCreation';

let registered = false;

/**
 * Resume creation-body publication whenever a workspace's tracker sync connects.
 * Metadata already self-heals through the sync backfill; the body and its
 * receipt did not, so an item created offline stayed team-invisible until a
 * human pressed Retry. Idempotent: the IPC registrar calls this per window.
 */
export function registerTrackerCreationResume(): void {
  if (registered) return;
  registered = true;
  onTrackerSyncWorkspaceConnected((workspacePath) => {
    void publishPendingTrackerCreations(workspacePath, {
      getItem: (id) => getTrackerItemForSync(workspacePath, id),
    }).then((results) => {
      for (const result of results) {
        if (result.status === 'pending')
          console.warn('[TrackerCreation] Publication still pending after reconnect:', result);
      }
    }).catch((error) => {
      console.error('[TrackerCreation] Resuming pending publications failed:', error);
    });
  });
}
