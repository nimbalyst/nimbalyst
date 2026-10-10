/**
 * Tracker-item placements for TeamSync: which tracker items sit in the team
 * page tree, and under which page. An item with no placement sits under its
 * type. Mirrors `teamTypePlacements.ts`.
 *
 * The cache holds server truth only. The TeamRoom echoes every upsert to its
 * author too, so callers that want an instant UI write optimistically on their
 * own side and let the echo replace it.
 *
 * A TeamRoom holds placements for every project in the org, while a
 * TeamSyncProvider serves one project. Rows for other projects are dropped
 * here so an item placed in two projects never shows up twice.
 */

import type {
  ItemPlacementNode,
  TeamClientMessage,
} from '@nimbalyst/collab-protocol';

export interface ItemPlacementCallbacks {
  /** Full placement list for this project (teamSync or itemPlacementIndexSync). */
  onItemPlacementsLoaded?: (placements: ItemPlacementNode[]) => void;
  /** An item was placed or moved. */
  onItemPlacementChanged?: (placement: ItemPlacementNode) => void;
  /** Placements were removed directly or with the page holding them. */
  onItemPlacementsRemoved?: (itemIds: string[]) => void;
}

export class TeamItemPlacementCache {
  private entries = new Map<string, ItemPlacementNode>();
  /** False until a server list arrives; an older server never sends one. */
  private loaded = false;
  /** Items with a mutation on the wire whose broadcast has not come back yet. */
  private unconfirmed = new Set<string>();
  private waiters: Array<(placements: ItemPlacementNode[] | null) => void> = [];

  /**
   * @param projectId The provider's project, or null while it is unknown
   *   (pre-teamSync on a legacy scope). Unknown accepts every row.
   */
  constructor(
    private readonly projectId: () => string | null,
    private readonly callbacks: () => ItemPlacementCallbacks,
  ) {}

  list(): ItemPlacementNode[] {
    return Array.from(this.entries.values());
  }

  /** The server's list, or null while none has arrived (older servers never send one). */
  authoritativeList(): ItemPlacementNode[] | null {
    return this.loaded ? this.list() : null;
  }

  /**
   * Replace the cache from a server list. An absent list (a `teamSyncResponse`
   * from an older server) says nothing, so it leaves the cache alone.
   */
  applySnapshot(placements: ItemPlacementNode[] | undefined): void {
    if (!placements) return;
    this.loaded = true;
    this.unconfirmed.clear();
    this.entries.clear();
    for (const placement of placements) {
      if (this.isOwn(placement.projectId)) this.entries.set(placement.itemId, placement);
    }
    const list = this.list();
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter(list);
    this.callbacks().onItemPlacementsLoaded?.(list);
  }

  /** A placement mutation left on the socket; its broadcast confirms it. */
  noteSent(msg: TeamClientMessage): void {
    if (msg.type === 'itemPlacementSet' || msg.type === 'itemPlacementRemove') this.unconfirmed.add(msg.itemId);
  }

  /**
   * Called on a server `error`. Errors carry no request id, so any error while
   * a placement mutation is unconfirmed may be its refusal; the caller then
   * re-reads the list so the author's optimistic row is replaced. True when a
   * re-read is needed.
   */
  takeUnconfirmed(): boolean {
    if (this.unconfirmed.size === 0) return false;
    this.unconfirmed.clear();
    return true;
  }

  applyUpsert(placement: ItemPlacementNode): void {
    if (!this.isOwn(placement.projectId)) return;
    this.unconfirmed.delete(placement.itemId);
    this.entries.set(placement.itemId, placement);
    this.callbacks().onItemPlacementChanged?.(placement);
  }

  applyRemove(projectId: string, itemIds: string[]): void {
    if (!this.isOwn(projectId)) return;
    for (const itemId of itemIds) {
      this.entries.delete(itemId);
      this.unconfirmed.delete(itemId);
    }
    this.callbacks().onItemPlacementsRemoved?.(itemIds);
  }

  /**
   * Resolves with the next applied snapshot, or null on timeout. `request`
   * sends the index read; it runs after the waiter is registered.
   */
  waitForSnapshot(request: () => void, timeoutMs: number): Promise<ItemPlacementNode[] | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (placements: ItemPlacementNode[] | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter(waiting => waiting !== waiter);
        resolve(placements);
      };
      const waiter = (placements: ItemPlacementNode[] | null) => done(placements);
      this.waiters.push(waiter);
      const timer = setTimeout(() => done(null), timeoutMs);
      request();
    });
  }

  destroy(): void {
    this.entries.clear();
    this.loaded = false;
    this.unconfirmed.clear();
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter(null);
  }

  /** The server always resolves a project, so a null row is never this provider's. */
  private isOwn(projectId: string | null): boolean {
    const own = this.projectId();
    return own === null || own === projectId;
  }
}

/**
 * Offline-queue key for a placement mutation. Set and remove share one key per
 * item, so only the last intent for an item survives a disconnect; both are
 * idempotent server-side.
 */
export function itemPlacementQueueKey(msg: TeamClientMessage): string | undefined {
  return msg.type === 'itemPlacementSet' || msg.type === 'itemPlacementRemove'
    ? `itemPlacement:${msg.itemId}`
    : undefined;
}
