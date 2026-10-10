/**
 * Tracker-type placements for TeamSync: which tracker types sit as nodes in
 * the team page tree, and under which folder.
 *
 * The cache holds server truth only. The TeamRoom echoes every upsert to its
 * author too, so callers that want an instant UI write optimistically on their
 * own side and let the echo replace it.
 *
 * A TeamRoom holds placements for every project in the org, while a
 * TeamSyncProvider serves one project. Rows for other projects are dropped
 * here so a type id placed in two projects never shows up twice.
 */

import type {
  TeamClientMessage,
  TypePlacementNode,
} from '@nimbalyst/collab-protocol';

export interface TypePlacementCallbacks {
  /** Full placement list for this project (teamSync or typePlacementIndexSync). */
  onTypePlacementsLoaded?: (placements: TypePlacementNode[]) => void;
  /** A type was placed or moved. */
  onTypePlacementChanged?: (placement: TypePlacementNode) => void;
  /** Placements were removed directly or with their folder subtree. */
  onTypePlacementsRemoved?: (typeIds: string[]) => void;
}

export class TeamTypePlacementCache {
  private entries = new Map<string, TypePlacementNode>();
  /** False until a server list arrives; an older server never sends one. */
  private loaded = false;
  /** Types with a mutation on the wire whose broadcast has not come back yet. */
  private unconfirmed = new Set<string>();
  private waiters: Array<(placements: TypePlacementNode[] | null) => void> = [];

  /**
   * @param projectId The provider's project, or null while it is unknown
   *   (pre-teamSync on a legacy scope). Unknown accepts every row.
   */
  constructor(
    private readonly projectId: () => string | null,
    private readonly callbacks: () => TypePlacementCallbacks,
  ) {}

  list(): TypePlacementNode[] {
    return Array.from(this.entries.values());
  }

  /** The server's list, or null while none has arrived (older servers never send one). */
  authoritativeList(): TypePlacementNode[] | null {
    return this.loaded ? this.list() : null;
  }

  /**
   * Replace the cache from a server list. An absent list (a `teamSyncResponse`
   * from an older server) says nothing, so it leaves the cache alone.
   */
  applySnapshot(placements: TypePlacementNode[] | undefined): void {
    if (!placements) return;
    this.loaded = true;
    this.unconfirmed.clear();
    this.entries.clear();
    for (const placement of placements) {
      if (this.isOwn(placement.projectId)) this.entries.set(placement.typeId, placement);
    }
    const list = this.list();
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter(list);
    this.callbacks().onTypePlacementsLoaded?.(list);
  }

  /** A placement mutation left on the socket; its broadcast confirms it. */
  noteSent(msg: TeamClientMessage): void {
    if (msg.type === 'typePlacementSet' || msg.type === 'typePlacementRemove') this.unconfirmed.add(msg.typeId);
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

  applyUpsert(placement: TypePlacementNode): void {
    if (!this.isOwn(placement.projectId)) return;
    this.unconfirmed.delete(placement.typeId);
    this.entries.set(placement.typeId, placement);
    this.callbacks().onTypePlacementChanged?.(placement);
  }

  applyRemove(projectId: string, typeIds: string[]): void {
    if (!this.isOwn(projectId)) return;
    for (const typeId of typeIds) {
      this.entries.delete(typeId);
      this.unconfirmed.delete(typeId);
    }
    this.callbacks().onTypePlacementsRemoved?.(typeIds);
  }

  /**
   * Resolves with the next applied snapshot, or null on timeout. `request`
   * sends the index read; it runs after the waiter is registered.
   */
  waitForSnapshot(request: () => void, timeoutMs: number): Promise<TypePlacementNode[] | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (placements: TypePlacementNode[] | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter(waiting => waiting !== waiter);
        resolve(placements);
      };
      const waiter = (placements: TypePlacementNode[] | null) => done(placements);
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

  private isOwn(projectId: string): boolean {
    const own = this.projectId();
    return own === null || own === projectId;
  }
}

/**
 * Offline-queue key for a placement mutation. Set and remove share one key per
 * type, so only the last intent for a type survives a disconnect; both are
 * idempotent server-side.
 */
export function typePlacementQueueKey(msg: TeamClientMessage): string | undefined {
  return msg.type === 'typePlacementSet' || msg.type === 'typePlacementRemove'
    ? `typePlacement:${msg.typeId}`
    : undefined;
}
