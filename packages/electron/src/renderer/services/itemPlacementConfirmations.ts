/**
 * Settles a team item-placement write from what the server sends back.
 * TeamSync's `setItemPlacement` / `removeItemPlacement` are fire-and-forget
 * sends, and a server error carries no request id, so the outcome is read
 * from the stream:
 *
 * - the `itemPlacementBroadcast` / `itemPlacementRemoveBroadcast` for the item
 *   (the server echoes every write to its author) confirms it;
 * - after a server error TeamSync re-reads the placement list; a list that
 *   does not hold the change, on the same connection, is a refusal;
 * - nothing within the timeout is a failure.
 */
import type { ItemPlacementNode } from '@nimbalyst/collab-protocol';

export const ITEM_PLACEMENT_CONFIRM_TIMEOUT_MS = 6000;

/** The wanted parent for a set, or `null` for a remove (back under the type). */
type Want = { parentId: string | null } | null;

interface Pending {
  itemId: string;
  want: Want;
  connection: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ItemPlacementConfirmations {
  private pending = new Set<Pending>();
  /** Bumped whenever the connection drops; a list from a later connection says nothing about an earlier send. */
  private connection = 0;

  constructor(private readonly timeoutMs = ITEM_PLACEMENT_CONFIRM_TIMEOUT_MS) {}

  /** Register before sending; resolves on confirmation, rejects on refusal or timeout. */
  expect(itemId: string, want: Want): Promise<void> {
    return new Promise((resolve, reject) => {
      const entry: Pending = {
        itemId,
        want,
        connection: this.connection,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.settle(entry, new Error('The server did not confirm the move in time.'));
        }, this.timeoutMs),
      };
      this.pending.add(entry);
    });
  }

  placementChanged(placement: ItemPlacementNode): void {
    for (const entry of this.pending) {
      if (entry.itemId === placement.itemId && entry.want && entry.want.parentId === (placement.parentId ?? null)) {
        this.settle(entry);
      }
    }
  }

  placementsRemoved(itemIds: string[]): void {
    const removed = new Set(itemIds);
    for (const entry of this.pending) {
      if (entry.want === null && removed.has(entry.itemId)) this.settle(entry);
    }
  }

  placementsLoaded(placements: ItemPlacementNode[]): void {
    const byItem = new Map(placements.map((placement) => [placement.itemId, placement]));
    for (const entry of this.pending) {
      const row = byItem.get(entry.itemId);
      const holds = entry.want === null
        ? !row
        : !!row && (row.parentId ?? null) === entry.want.parentId;
      if (holds) this.settle(entry);
      else if (entry.connection === this.connection) {
        this.settle(entry, new Error('The server refused the move.'));
      }
    }
  }

  connectionChanged(connected: boolean): void {
    if (!connected) this.connection += 1;
  }

  dispose(): void {
    for (const entry of this.pending) this.settle(entry, new Error('The team connection closed.'));
  }

  private settle(entry: Pending, error?: Error): void {
    if (!this.pending.delete(entry)) return;
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve();
  }
}
