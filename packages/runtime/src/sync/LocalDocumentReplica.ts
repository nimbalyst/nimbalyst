import * as Y from "yjs";
import type {
  LocalReplicaIdentity,
  LocalDocumentReplicaOutboxState,
  LocalReplicaOutboxEntry,
  LocalReplicaStore,
  LocalReplicaUpdateSource,
} from "./LocalReplicaStore";

export type LocalDocumentReplicaState =
  | "loading"
  | "ready"
  | "corrupt"
  | "unavailable";

export interface LocalDocumentReplicaOptions {
  identity: LocalReplicaIdentity;
  documentType: string;
  store: LocalReplicaStore;
  ydoc?: Y.Doc;
  onReplicaStateChange?: (state: LocalDocumentReplicaState) => void;
  onOutboxStateChange?: (state: LocalDocumentReplicaOutboxState) => void;
  onOfflineMetric?: (event: {
    metric: string;
    [property: string]: string | number | boolean | null;
  }) => void;
  compaction?: Partial<LocalReplicaCompactionOptions>;
}

export interface LocalReplicaCompactionOptions {
  updateCountThreshold: number;
  byteThreshold: number;
  idleIntervalMs: number;
  remotePersistenceWindowMs: number;
}

export interface ApplyRemoteReplicaUpdate {
  update: Uint8Array;
  source: Exclude<LocalReplicaUpdateSource, "local">;
  serverSequence: number | null;
}

export interface LocalReplicaReplayBatch {
  batchId: string;
  batchIds: string[];
  update: Uint8Array;
}

const HYDRATION_ORIGIN = Symbol("local-replica-hydration");
const REMOTE_ORIGIN = Symbol("local-replica-remote");
const SIBLING_ORIGIN = Symbol("local-replica-sibling");

export const DEFAULT_LOCAL_REPLICA_COMPACTION: LocalReplicaCompactionOptions = {
  updateCountThreshold: 256,
  byteThreshold: 1024 * 1024,
  idleIntervalMs: 60_000,
  remotePersistenceWindowMs: 150,
};

function newId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

/**
 * Owns the in-memory Y.Doc and its durable local lifecycle. Editors and the
 * network provider attach independently to this object.
 */
export class LocalDocumentReplica {
  readonly identity: LocalReplicaIdentity;
  readonly documentType: string;
  readonly whenReady: Promise<void>;

  private readonly store: LocalReplicaStore;
  private readonly onReplicaStateChange?: (
    state: LocalDocumentReplicaState
  ) => void;
  private readonly onOutboxStateChange?: (
    state: LocalDocumentReplicaOutboxState
  ) => void;
  private readonly onOfflineMetric?: LocalDocumentReplicaOptions["onOfflineMetric"];
  private readonly ydoc: Y.Doc;
  private readonly compactionOptions: LocalReplicaCompactionOptions;
  private readonly unsubscribeSiblingUpdates: (() => void) | null;
  private state: LocalDocumentReplicaState = "loading";
  private snapshotGeneration = 0;
  private lastServerSeq = 0;
  private complete = true;
  private hydratedFromStore = false;
  private destroyed = false;
  private discarded = false;
  private repairingCorruption = false;
  private cleanHydrationRequired = false;
  private writeTail: Promise<void> = Promise.resolve();
  private compactionTail: Promise<boolean> | null = null;
  private idleCompactionTimer: ReturnType<typeof setTimeout> | null = null;
  private tailUpdateCount = 0;
  private tailBytes = 0;
  private remotePersistenceTimer: ReturnType<typeof setTimeout> | null = null;
  private remotePersistenceBuffer: Array<{
    updateId: string;
    update: Uint8Array;
    source: Exclude<LocalReplicaUpdateSource, "local">;
    serverSequence: number | null;
  }> = [];
  private remotePersistenceCursor = 0;
  private remotePersistencePromise: Promise<void> | null = null;
  private outbox = new Map<string, LocalReplicaOutboxEntry>();
  private readonly updateHandler: (update: Uint8Array, origin: unknown) => void;

  constructor(options: LocalDocumentReplicaOptions) {
    this.identity = options.identity;
    this.documentType = options.documentType;
    this.store = options.store;
    this.onReplicaStateChange = options.onReplicaStateChange;
    this.onOutboxStateChange = options.onOutboxStateChange;
    this.onOfflineMetric = options.onOfflineMetric;
    this.compactionOptions = {
      ...DEFAULT_LOCAL_REPLICA_COMPACTION,
      ...options.compaction,
    };
    this.ydoc = options.ydoc ?? new Y.Doc();
    this.updateHandler = (update, origin) => {
      if (
        origin === HYDRATION_ORIGIN ||
        origin === REMOTE_ORIGIN ||
        origin === SIBLING_ORIGIN ||
        this.destroyed ||
        this.discarded
      )
        return;
      const updateId = newId();
      const now = Date.now();
      const entry: LocalReplicaOutboxEntry = {
        batchId: updateId,
        update: update.slice(),
        state: "queued",
        attemptCount: 0,
        lastErrorCode: null,
        createdAt: now,
        updatedAt: now,
      };
      this.outbox.set(updateId, entry);
      this.notifyOutboxState();
      this.onOfflineMetric?.({
        metric: "offline_edit",
        editCount: 1,
        outboxBytes: update.byteLength,
      });
      this.enqueueWrite(async () => {
        await this.whenReady;
        if (this.state !== "ready" || !this.complete) {
          throw new Error(
            `local replica is ${this.state}; refusing to append an unloadable local update`
          );
        }
        await this.store.appendLocalUpdate({
          identity: this.identity,
          documentType: this.documentType,
          updateId,
          update: update.slice(),
          snapshotGeneration: this.snapshotGeneration,
        });
        this.recordPersistedTail(update.byteLength);
      });
    };
    this.ydoc.on("update", this.updateHandler);
    this.unsubscribeSiblingUpdates =
      this.store.subscribeToSiblingLocalUpdates?.(
        this.identity,
        (update) => this.applySiblingLocalUpdate(update)
      ) ?? null;
    this.whenReady = this.open();
  }

  getYDoc(): Y.Doc {
    return this.ydoc;
  }

  isInternalOrigin(origin: unknown): boolean {
    return (
      origin === HYDRATION_ORIGIN ||
      origin === REMOTE_ORIGIN ||
      origin === SIBLING_ORIGIN
    );
  }

  getState(): LocalDocumentReplicaState {
    return this.state;
  }

  getLastServerSeq(): number {
    return this.lastServerSeq;
  }

  isComplete(): boolean {
    return this.complete;
  }

  needsCleanServerHydration(): boolean {
    return this.cleanHydrationRequired;
  }

  wasHydratedFromStore(): boolean {
    return this.hydratedFromStore;
  }

  hasPendingOutbox(): boolean {
    return this.outbox.size > 0;
  }

  getOutboxState(): LocalDocumentReplicaOutboxState {
    const states = [...this.outbox.values()].map((entry) => entry.state);
    if (states.includes("rejected")) return "rejected";
    if (states.includes("inflight")) return "replaying";
    if (states.includes("queued")) return "pending";
    return "clean";
  }

  getPendingOutboxUpdate(): Uint8Array | null {
    const updates = [...this.outbox.values()]
      .filter((entry) => entry.state !== "rejected")
      .map((entry) => entry.update);
    return updates.length > 0 ? Y.mergeUpdates(updates) : null;
  }

  async persistPendingOutboxUpdate(update: Uint8Array): Promise<string> {
    await this.whenReady;
    if (this.state !== "ready" || !this.complete) {
      throw new Error(
        `local replica is ${this.state}; refusing to persist a replay batch`
      );
    }
    await this.flush();
    const updateId = newId();
    const now = Date.now();
    this.outbox.set(updateId, {
      batchId: updateId,
      update: update.slice(),
      state: "queued",
      attemptCount: 0,
      lastErrorCode: null,
      createdAt: now,
      updatedAt: now,
    });
    this.notifyOutboxState();
    try {
      await this.store.appendLocalUpdate({
        identity: this.identity,
        documentType: this.documentType,
        updateId,
        update: update.slice(),
        snapshotGeneration: this.snapshotGeneration,
      });
      this.recordPersistedTail(update.byteLength);
    } catch (error) {
      this.outbox.delete(updateId);
      this.notifyOutboxState();
      throw error;
    }
    return updateId;
  }

  async applyRemoteUpdates(
    updates: ApplyRemoteReplicaUpdate[],
    lastServerSeq: number,
    options: { coalescePersistence?: boolean } = {}
  ): Promise<boolean> {
    if (this.discarded) {
      throw new Error("Local replica was discarded");
    }
    const validUpdates: ApplyRemoteReplicaUpdate[] = [];
    for (const item of updates) {
      try {
        // Structural decoding is independent of document size. Applying each
        // valid update separately preserves the provider's per-payload skip
        // semantics without cloning the complete Y.Doc for every broadcast.
        Y.decodeUpdate(item.update);
        Y.applyUpdate(this.ydoc, item.update, REMOTE_ORIGIN);
        validUpdates.push(item);
      } catch (error) {
        console.warn(
          "[LocalDocumentReplica] Skipping invalid remote update:",
          error
        );
      }
    }

    const completeBatch = validUpdates.length === updates.length;
    const durableCursor = completeBatch ? lastServerSeq : this.lastServerSeq;

    if (validUpdates.length > 0 || durableCursor > this.lastServerSeq) {
      if (options.coalescePersistence) {
        await this.enqueueRemotePersistence(validUpdates, durableCursor);
      } else {
        await this.persistRemoteUpdates(validUpdates, durableCursor);
      }
    }
    if (!completeBatch) await this.markIncomplete();
    return completeBatch;
  }

  async beginOutboxReplay(): Promise<LocalReplicaReplayBatch | null> {
    // IDs present before the async flush are safe to reconcile. Edits arriving
    // after this snapshot may not be durable yet and must never be dropped.
    let reconcileCandidates = new Set(this.outbox.keys());
    await this.flush();

    // A drainer can acknowledge rows after open() loaded them. Reconcile the
    // durable truth before selecting work, while preserving edits appended to
    // the in-memory map during the async load.
    for (;;) {
      await this.reconcileOutboxFromStore(reconcileCandidates);
      const replayable = [...this.outbox.values()]
        .filter((entry) => entry.state !== "rejected")
        .sort(
          (left, right) =>
            left.createdAt - right.createdAt ||
            left.batchId.localeCompare(right.batchId)
        );
      if (replayable.length === 0) return null;

      const inflight = replayable.filter((entry) => entry.state === "inflight");
      if (inflight.length > 0) return this.mergeReplayEntries(inflight);

      const queued = replayable.filter((entry) => entry.state === "queued");
      if (queued.length === 0) return null;
      const batchIds = queued.map((entry) => entry.batchId);
      const now = Date.now();
      for (const entry of queued) {
        entry.state = "inflight";
        entry.attemptCount += 1;
        entry.updatedAt = now;
      }
      this.notifyOutboxState();
      try {
        if (await this.store.claimOutboxBatch(this.identity, batchIds)) {
          return this.mergeReplayEntries(queued);
        }
      } catch (error) {
        for (const entry of queued) entry.state = "queued";
        this.notifyOutboxState();
        throw error;
      }

      // Another sender changed the durable rows between load and claim. The
      // next reconciliation drops acknowledgements and advances to later work.
      for (const entry of queued) entry.state = "queued";
      this.notifyOutboxState();
      reconcileCandidates = new Set(this.outbox.keys());
    }
  }

  async acknowledgeOutbox(
    batchIds: string[],
    serverSequence: number
  ): Promise<void> {
    if (batchIds.length === 0) return;
    await this.store.acknowledgeOutbox(this.identity, batchIds, serverSequence);
    for (const id of batchIds) this.outbox.delete(id);
    this.notifyOutboxState();
  }

  async requeueOutbox(batchIds: string[]): Promise<void> {
    if (batchIds.length === 0) return;
    for (const id of batchIds) {
      const entry = this.outbox.get(id);
      if (entry) {
        entry.state = "queued";
        entry.updatedAt = Date.now();
      }
    }
    await this.store.setOutboxState(this.identity, batchIds, "queued");
    this.notifyOutboxState();
  }

  async rejectOutbox(batchIds: string[], errorCode: string): Promise<void> {
    if (batchIds.length === 0) return;
    for (const id of batchIds) {
      const entry = this.outbox.get(id);
      if (entry) {
        entry.state = "rejected";
        entry.lastErrorCode = errorCode;
        entry.updatedAt = Date.now();
      }
    }
    await this.store.setOutboxState(
      this.identity,
      batchIds,
      "rejected",
      errorCode
    );
    this.notifyOutboxState();
  }

  async recordOutboxError(batchIds: string[], errorCode: string): Promise<void> {
    if (batchIds.length === 0) return;
    for (const id of batchIds) {
      const entry = this.outbox.get(id);
      if (entry) {
        entry.lastErrorCode = errorCode;
        entry.updatedAt = Date.now();
      }
    }
    await this.store.recordOutboxError(this.identity, batchIds, errorCode);
  }

  async markIncomplete(): Promise<void> {
    this.complete = false;
    this.cleanHydrationRequired = true;
    this.clearIdleCompactionTimer();
    this.setState("unavailable");
    await this.store.markIncomplete(this.identity);
  }

  /**
   * Prepares a corrupt or incomplete replica for a full server replay without
   * discarding rejected/queued local edits. The visible error state remains
   * until a complete server hydration is durably applied.
   */
  async beginCleanServerHydration(): Promise<void> {
    await this.whenReady;
    if (!this.cleanHydrationRequired || this.repairingCorruption) return;
    // The quarantined snapshot/tail is not trusted, but durable outbox rows are
    // independently encrypted and checksummed. Reapply them to the fresh Y.Doc
    // so a clean server replay merges rather than erases legitimate local edits.
    for (const entry of this.outbox.values()) {
      Y.decodeUpdate(entry.update);
      Y.applyUpdate(this.ydoc, entry.update, HYDRATION_ORIGIN);
    }
    await this.store.resetForCleanHydration(this.identity);
    this.snapshotGeneration = 0;
    this.lastServerSeq = 0;
    this.tailUpdateCount = 0;
    this.tailBytes = 0;
    this.clearIdleCompactionTimer();
    this.complete = true;
    this.repairingCorruption = true;
  }

  async completeCleanServerHydration(complete: boolean): Promise<void> {
    if (!this.repairingCorruption) return;
    if (!complete) {
      this.complete = false;
      this.repairingCorruption = false;
      return;
    }
    await this.store.markComplete(this.identity);
    this.repairingCorruption = false;
    this.cleanHydrationRequired = false;
    this.complete = true;
    this.hydratedFromStore = true;
    this.setState("ready");
    this.scheduleOrRequestCompaction();
  }

  async discardLocalCopy(): Promise<void> {
    await this.whenReady;
    await this.flush();
    if (this.getOutboxState() !== "rejected") {
      throw new Error("Only a rejected local outbox can be discarded explicitly");
    }
    this.discarded = true;
    try {
      await this.store.discard(this.identity);
    } catch (error) {
      this.discarded = false;
      throw error;
    }
    this.outbox.clear();
    this.notifyOutboxState();
    this.complete = false;
    this.setState("unavailable");
  }

  async flush(): Promise<void> {
    await this.flushRemotePersistence();
    await this.writeTail;
    await this.compactionTail;
  }

  async compactNow(): Promise<boolean> {
    const startedAt = Date.now();
    await this.whenReady;
    await this.flushRemotePersistence();
    await this.writeTail;
    if (
      this.destroyed ||
      this.discarded ||
      this.state !== "ready" ||
      !this.complete ||
      this.cleanHydrationRequired ||
      this.repairingCorruption
    ) {
      return false;
    }

    const basis = await this.store.load(this.identity);
    if (!basis || basis.completeness !== "complete") return false;
    const expectedGeneration = basis.snapshotGeneration;
    const compacted = new Y.Doc();
    let snapshot: Uint8Array;
    try {
      // The prune list comes from this exact durable basis, so build the new
      // snapshot from the same bytes before merging this window's live state.
      // A lagging window can therefore never claim coverage for a sibling-
      // persisted row that its own Y.Doc has not seen yet.
      if (basis.snapshot) {
        Y.applyUpdate(compacted, basis.snapshot, HYDRATION_ORIGIN);
      }
      for (const update of basis.updates) {
        Y.applyUpdate(compacted, update.update, HYDRATION_ORIGIN);
      }
      Y.applyUpdate(
        compacted,
        Y.encodeStateAsUpdate(this.ydoc),
        HYDRATION_ORIGIN
      );
      snapshot = Y.encodeStateAsUpdate(compacted);
    } catch (error) {
      this.complete = false;
      this.cleanHydrationRequired = true;
      this.clearIdleCompactionTimer();
      this.setState("corrupt");
      await this.store.quarantine(
        this.identity,
        error instanceof Error ? error.message : String(error)
      );
      return false;
    } finally {
      compacted.destroy();
    }
    const basisTailBytes = basis.updates.reduce(
      (sum, update) => sum + update.update.byteLength,
      0,
    );
    const replaced = await this.store.replaceSnapshot({
      identity: this.identity,
      documentType: this.documentType,
      snapshot,
      expectedGeneration,
      nextGeneration: expectedGeneration + 1,
      // The store intentionally preserves its existing cursor.
      lastServerSeq: basis.lastServerSeq,
      coveredUpdateIds: basis.updates.map((update) => update.updateId),
    });
    const refreshed = await this.store.load(this.identity);
    if (refreshed?.completeness === "complete") {
      this.snapshotGeneration = refreshed.snapshotGeneration;
      this.lastServerSeq = Math.max(this.lastServerSeq, refreshed.lastServerSeq);
      this.tailUpdateCount = refreshed.updates.length;
      this.tailBytes = refreshed.updates.reduce(
        (sum, update) => sum + update.update.byteLength,
        0
      );
    }
    this.onOfflineMetric?.({
      metric: "local_compaction",
      durationMs: Date.now() - startedAt,
      reclaimedBytes: Math.max(
        0,
        basisTailBytes - (refreshed?.updates.reduce(
          (sum, update) => sum + update.update.byteLength,
          0,
        ) ?? basisTailBytes),
      ),
      committed: replaced,
    });
    this.scheduleIdleCompaction();
    return replaced;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribeSiblingUpdates?.();
    this.clearIdleCompactionTimer();
    this.ydoc.off("update", this.updateHandler);
    await this.flush();
    this.ydoc.destroy();
  }

  private async open(): Promise<void> {
    try {
      const loaded = await this.store.load(this.identity);
      if (!loaded) {
        this.setState("ready");
        return;
      }
      this.hydratedFromStore = true;
      const editsDuringHydration = this.outbox;
      const durableOutbox =
        loaded.completeness === "complete"
          ? loaded.outbox
          : await this.store.loadOutbox(this.identity);
      this.outbox = new Map(
        durableOutbox.map((entry) => [entry.batchId, entry])
      );
      for (const [batchId, entry] of editsDuringHydration) {
        this.outbox.set(batchId, entry);
      }
      this.notifyOutboxState();
      if (loaded.completeness !== "complete") {
        this.complete = false;
        this.cleanHydrationRequired = true;
        this.setState(
          loaded.completeness === "corrupt" ? "corrupt" : "unavailable"
        );
        return;
      }

      const hydrated = new Y.Doc();
      try {
        if (loaded.snapshot)
          Y.applyUpdate(hydrated, loaded.snapshot, HYDRATION_ORIGIN);
        for (const item of loaded.updates) {
          Y.applyUpdate(hydrated, item.update, HYDRATION_ORIGIN);
        }
        Y.applyUpdate(
          this.ydoc,
          Y.encodeStateAsUpdate(hydrated),
          HYDRATION_ORIGIN
        );
      } catch (error) {
        this.complete = false;
        this.cleanHydrationRequired = true;
        this.setState("corrupt");
        await this.store.quarantine(
          this.identity,
          error instanceof Error ? error.message : String(error)
        );
        return;
      } finally {
        hydrated.destroy();
      }

      this.snapshotGeneration = loaded.snapshotGeneration;
      this.lastServerSeq = loaded.lastServerSeq;
      this.tailUpdateCount = loaded.updates.length;
      this.tailBytes = loaded.updates.reduce(
        (sum, update) => sum + update.update.byteLength,
        0
      );
      // Inflight rows are a durable merged batch. The attach handshake has
      // already stopped any headless sender, so resuming the claim preserves
      // its stable wire ID and bytes across process restarts and handoffs.
      this.notifyOutboxState();
      this.setState("ready");
      this.scheduleOrRequestCompaction();
    } catch (error) {
      this.complete = false;
      this.cleanHydrationRequired =
        error instanceof Error &&
        error.message.includes("CORRUPT_LOCAL_REPLICA");
      this.setState(
        error instanceof Error &&
          error.message.includes("CORRUPT_LOCAL_REPLICA")
          ? "corrupt"
          : "unavailable"
      );
      this.clearIdleCompactionTimer();
    }
  }

  private enqueueWrite(work: () => Promise<void>): void {
    this.writeTail = this.writeTail.then(work).catch((error) => {
      console.error("[LocalDocumentReplica] Durable write failed:", error);
      this.complete = false;
      this.cleanHydrationRequired = true;
      this.clearIdleCompactionTimer();
      this.setState("unavailable");
    });
  }

  private async persistRemoteUpdates(
    updates: ApplyRemoteReplicaUpdate[],
    durableCursor: number
  ): Promise<void> {
    await this.store.appendRemoteUpdates({
      identity: this.identity,
      documentType: this.documentType,
      updates: updates.map((item) => ({
        updateId: newId(),
        update: item.update.slice(),
        source: item.source,
        serverSequence: item.serverSequence,
      })),
      snapshotGeneration: this.snapshotGeneration,
      lastServerSeq: durableCursor,
    });
    this.lastServerSeq = Math.max(this.lastServerSeq, durableCursor);
    for (const update of updates) this.recordPersistedTail(update.update.byteLength);
  }

  private enqueueRemotePersistence(
    updates: ApplyRemoteReplicaUpdate[],
    durableCursor: number
  ): Promise<void> {
    this.remotePersistenceBuffer.push(
      ...updates.map((item) => ({
        updateId: newId(),
        update: item.update.slice(),
        source: item.source,
        serverSequence: item.serverSequence,
      }))
    );
    this.remotePersistenceCursor = Math.max(
      this.remotePersistenceCursor,
      durableCursor
    );
    if (!this.remotePersistencePromise) {
      this.remotePersistencePromise = new Promise<void>((resolve, reject) => {
        this.remotePersistenceTimer = setTimeout(() => {
          this.remotePersistenceTimer = null;
          void this.flushRemotePersistenceBuffer().then(resolve, reject);
        }, this.compactionOptions.remotePersistenceWindowMs);
      }).finally(() => {
        this.remotePersistencePromise = null;
      });
    }
    return this.remotePersistencePromise;
  }

  private async flushRemotePersistence(): Promise<void> {
    await this.remotePersistencePromise;
  }

  private async flushRemotePersistenceBuffer(): Promise<void> {
    // New broadcasts can arrive while the current transaction is in flight.
    // Drain them before resolving the shared promise so no caller observes a
    // successful coalesced flush while its bytes remain only in memory.
    while (
      this.remotePersistenceBuffer.length > 0 ||
      this.remotePersistenceCursor > this.lastServerSeq
    ) {
      const updates = this.remotePersistenceBuffer;
      const durableCursor = this.remotePersistenceCursor;
      this.remotePersistenceBuffer = [];
      this.remotePersistenceCursor = 0;
      await this.store.appendRemoteUpdates({
        identity: this.identity,
        documentType: this.documentType,
        updates,
        snapshotGeneration: this.snapshotGeneration,
        lastServerSeq: durableCursor,
      });
      this.lastServerSeq = Math.max(this.lastServerSeq, durableCursor);
      for (const update of updates) {
        this.recordPersistedTail(update.update.byteLength);
      }
    }
  }

  private applySiblingLocalUpdate(update: Uint8Array): void {
    if (this.destroyed || this.discarded) return;
    try {
      Y.decodeUpdate(update);
      Y.applyUpdate(this.ydoc, update, SIBLING_ORIGIN);
      this.recordPersistedTail(update.byteLength);
    } catch (error) {
      console.warn("[LocalDocumentReplica] Invalid sibling update broadcast:", error);
      void this.markIncomplete().catch(() => undefined);
    }
  }

  private recordPersistedTail(byteLength: number): void {
    this.tailUpdateCount += 1;
    this.tailBytes += byteLength;
    this.scheduleOrRequestCompaction();
  }

  private scheduleOrRequestCompaction(): void {
    if (
      this.tailUpdateCount >= this.compactionOptions.updateCountThreshold ||
      this.tailBytes >= this.compactionOptions.byteThreshold
    ) {
      this.requestCompaction();
    } else {
      this.scheduleIdleCompaction();
    }
  }

  private requestCompaction(): void {
    if (this.compactionTail || this.destroyed) return;
    this.compactionTail = Promise.resolve()
      .then(() => this.compactNow())
      .catch((error) => {
        console.warn("[LocalDocumentReplica] Local compaction failed:", error);
        return false;
      })
      .finally(() => {
        this.compactionTail = null;
      });
  }

  private scheduleIdleCompaction(): void {
    this.clearIdleCompactionTimer();
    if (this.destroyed || this.tailUpdateCount === 0) return;
    this.idleCompactionTimer = setTimeout(() => {
      this.idleCompactionTimer = null;
      this.requestCompaction();
    }, this.compactionOptions.idleIntervalMs);
  }

  private clearIdleCompactionTimer(): void {
    if (this.idleCompactionTimer) clearTimeout(this.idleCompactionTimer);
    this.idleCompactionTimer = null;
  }

  private mergeReplayEntries(
    entries: LocalReplicaOutboxEntry[]
  ): LocalReplicaReplayBatch {
    const sorted = [...entries].sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        left.batchId.localeCompare(right.batchId)
    );
    return {
      batchId: sorted[0].batchId,
      batchIds: sorted.map((entry) => entry.batchId),
      update: Y.mergeUpdates(sorted.map((entry) => entry.update)),
    };
  }

  private async reconcileOutboxFromStore(
    candidates: Set<string>
  ): Promise<void> {
    const durable = await this.store.loadOutbox(this.identity);
    const durableById = new Map(durable.map((entry) => [entry.batchId, entry]));
    for (const batchId of candidates) {
      const entry = durableById.get(batchId);
      if (entry) this.outbox.set(batchId, entry);
      else this.outbox.delete(batchId);
    }
    for (const entry of durable) {
      if (!this.outbox.has(entry.batchId)) this.outbox.set(entry.batchId, entry);
    }
    this.notifyOutboxState();
  }

  private notifyOutboxState(): void {
    try {
      this.onOutboxStateChange?.(this.getOutboxState());
    } catch (error) {
      console.error("[LocalDocumentReplica] Outbox state callback failed:", error);
    }
  }

  private setState(state: LocalDocumentReplicaState): void {
    if (this.state === state) return;
    this.state = state;
    try {
      this.onReplicaStateChange?.(state);
    } catch (error) {
      console.error(
        "[LocalDocumentReplica] Replica state callback failed:",
        error
      );
    }
  }
}
