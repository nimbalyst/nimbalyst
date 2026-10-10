/**
 * Sharing an updated tracker item with its team room.
 *
 * The room refuses an item over its per-item limit, and the engine says so by
 * throwing `TrackerPayloadTooLargeError` before it queues anything. That check
 * has to run before the host saves the edit: run after, the refusal landed in
 * a catch that only logged, the row kept `synced` with nothing queued, and a
 * teammate's next edit overwrote the change.
 */
import type { TrackerItem } from '@nimbalyst/runtime';
import { encodeTrackerPayloadPlaintext, TrackerPayloadTooLargeError } from '@nimbalyst/tracker-engine';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import { isTrackerSyncActive, isTrackerSyncConfigured, syncTrackerItem, trackerItemToPayload } from '../TrackerSyncManager';
import { getEffectiveTrackerSharingPolicy, shouldSyncTrackerItem } from '../TrackerPolicyService';

/**
 * Throw `TrackerPayloadTooLargeError` when `item` belongs to a workspace with a
 * tracker room and could not be sent to it. Call with the item as it is about
 * to be written, and only when that item is shared.
 */
export function assertTrackerItemFitsRoom(item: TrackerItem): void {
  if (!isTrackerSyncConfigured(item.workspace)) return;
  encodeTrackerPayloadPlaintext(trackerItemToPayload(item));
}

/**
 * The refusal for an item, as it is about to be written, that its tracker
 * shares with the team and that would not fit the room; null otherwise.
 */
export function sharedTrackerItemTooLarge(item: TrackerItem, workspacePath?: string): TrackerPayloadTooLargeError | null {
  const policy = getEffectiveTrackerSharingPolicy(workspacePath || item.workspace, item.type, globalRegistry.get(item.type));
  return shouldSyncTrackerItem(policy, item) ? trackerItemTooLargeForRoom(item) : null;
}

/** The refusal `assertTrackerItemFitsRoom` would throw, or null. Other errors propagate. */
export function trackerItemTooLargeForRoom(item: TrackerItem): TrackerPayloadTooLargeError | null {
  try {
    assertTrackerItemFitsRoom(item);
    return null;
  } catch (error) {
    if (error instanceof TrackerPayloadTooLargeError) return error;
    throw error;
  }
}

/**
 * Push a saved, shared item to its room, or mark it `pending` for the
 * reconnect drain when the room is not connected. A failure is logged and
 * not thrown: the local save has already happened.
 */
export async function pushSharedTrackerItem(
  item: TrackerItem,
  markPending: (itemId: string) => Promise<unknown>,
  logPrefix = '[DocumentService] update-tracker-item',
): Promise<void> {
  try {
    if (isTrackerSyncActive(item.workspace)) {
      await syncTrackerItem(item);
    } else {
      await markPending(item.id);
      // console.log(`${logPrefix} skipped: sync not active for workspace`);
    }
  } catch (syncErr) {
    console.error(`${logPrefix} sync failed:`, syncErr);
  }
}
