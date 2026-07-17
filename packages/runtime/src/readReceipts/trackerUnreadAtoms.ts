/**
 * Tracker unread atoms — the reactive "unread dot" state for tracker items,
 * mirroring the AI-session unread pattern (`sessionUnreadAtom`).
 *
 * Lives in runtime (not electron) so BOTH the runtime `TrackerTable` and the
 * electron Kanban/Tag cards can read `trackerUnreadAtom(itemId)` from the same
 * shared Jotai store. The IPC/receipt plumbing that DRIVES these atoms stays in
 * the electron renderer (it fetches receipts + calls the mark-viewed IPC) and
 * writes here through the exported write-atoms.
 *
 * Decision logic is the pure resolver in `./readReceipts`. Trackers have no
 * numeric version in the renderer record, so the snapshot uses the `updatedAt`
 * timestamp + `lastModifiedBy.email` and the resolver's timestamp-fallback path.
 */

import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { TrackerRecord } from '../core/TrackerRecord';
import {
  isEntityUnread,
  type ReadReceipt,
  type UnreadEntitySnapshot,
} from './readReceipts';

// ============================================================
// Per-item reactive flag
// ============================================================

/** Whether a single tracker item is unread. The dot components subscribe here. */
export const trackerUnreadAtom = atomFamily((_itemId: string) => atom(false));

/**
 * Per-workspace rollup of unread item ids. Not surfaced on the nav rail in v1
 * (inline dots only), but kept so list rendering / future counts have a cheap
 * source. Map<workspacePath, Set<itemId>>.
 */
export const trackerUnreadByWorkspaceAtom = atom<Map<string, Set<string>>>(new Map());

/**
 * The current user's tracker read receipts, keyed by item id. Seeded from the
 * local DB (and, in Phase 2, updated by inbound personal-sync). The electron
 * renderer owns fetching/updating this; the recompute atom reads it.
 */
export const trackerReceiptsAtom = atom<Map<string, ReadReceipt>>(new Map());

// ============================================================
// Snapshot builder
// ============================================================

/** Build the pure unread snapshot from a renderer tracker record. */
export function trackerSnapshot(record: TrackerRecord): UnreadEntitySnapshot {
  const updatedMs = Date.parse(record.system.updatedAt);
  return {
    currentVersion: null, // no numeric version projected to the renderer
    currentVersionTimestamp: Number.isNaN(updatedMs) ? 0 : updatedMs,
    lastChangeActorId: record.system.lastModifiedBy?.email ?? null,
  };
}

// ============================================================
// Write atoms
// ============================================================

function setWorkspaceUnread(
  map: Map<string, Set<string>>,
  workspace: string,
  itemId: string,
  unread: boolean,
): Map<string, Set<string>> {
  const next = new Map(map);
  const existing = next.get(workspace);
  if (unread) {
    const set = new Set(existing ?? []);
    if (set.has(itemId)) return map; // no change
    set.add(itemId);
    next.set(workspace, set);
  } else {
    if (!existing || !existing.has(itemId)) return map; // no change
    const set = new Set(existing);
    set.delete(itemId);
    if (set.size === 0) next.delete(workspace);
    else next.set(workspace, set);
  }
  return next;
}

/** Set (or clear) a single item's unread flag and keep the workspace rollup in sync. */
export const setTrackerUnreadAtom = atom(
  null,
  (get, set, payload: { itemId: string; workspace: string; unread: boolean }) => {
    const { itemId, workspace, unread } = payload;
    set(trackerUnreadAtom(itemId), unread);
    const rollup = get(trackerUnreadByWorkspaceAtom);
    const nextRollup = setWorkspaceUnread(rollup, workspace, itemId, unread);
    if (nextRollup !== rollup) set(trackerUnreadByWorkspaceAtom, nextRollup);
  },
);

/**
 * Recompute unread for a batch of items against the current receipts. Called by
 * the electron renderer whenever tracker items or receipts change. `receipts`
 * is keyed by item id; a missing entry means "never viewed".
 */
export const recomputeTrackerUnreadAtom = atom(
  null,
  (
    get,
    set,
    payload: {
      workspace: string;
      items: TrackerRecord[];
      receipts: Map<string, ReadReceipt>;
      currentEmail: string | null;
    },
  ) => {
    const { workspace, items, receipts, currentEmail } = payload;
    for (const record of items) {
      const unread = isEntityUnread(
        trackerSnapshot(record),
        receipts.get(record.id) ?? null,
        currentEmail,
      );
      const current = get(trackerUnreadAtom(record.id));
      if (current !== unread) {
        set(setTrackerUnreadAtom, { itemId: record.id, workspace, unread });
      }
    }
  },
);

/**
 * Record a local mark-viewed in the receipts atom (advance-only handled by the
 * store; here we just reflect the new watermark) and clear the item's dot.
 */
export const applyTrackerReceiptAtom = atom(
  null,
  (
    get,
    set,
    payload: { itemId: string; workspace: string; receipt: ReadReceipt },
  ) => {
    const { itemId, workspace, receipt } = payload;
    const next = new Map(get(trackerReceiptsAtom));
    next.set(itemId, receipt);
    set(trackerReceiptsAtom, next);
    set(setTrackerUnreadAtom, { itemId, workspace, unread: false });
  },
);
