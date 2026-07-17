import { expect } from "vitest";
import * as Y from "yjs";
import { DocumentSyncProvider } from "../../DocumentSync";
import { LocalDocumentReplica } from "../../LocalDocumentReplica";
import { OutboxDrainer } from "../../OutboxDrainer";
import type {
  AppendLocalReplicaUpdateInput,
  AppendRemoteReplicaUpdatesInput,
  LoadedLocalReplica,
  LocalReplicaIdentity,
  LocalReplicaOutboxState,
  LocalReplicaPendingOutbox,
  LocalReplicaStorageUsage,
  LocalReplicaStore,
  ReplaceLocalReplicaSnapshotInput,
} from "../../LocalReplicaStore";
import type {
  DocClientMessage,
  DocServerMessage,
  DocumentSyncStatus,
} from "../../documentSyncTypes";

export type HarnessOutboxState = "clean" | "pending" | "replaying";

export interface HarnessReadiness {
  localReady: boolean;
  networkReady: boolean;
  outbox: HarnessOutboxState;
}

interface PersistedClientState {
  /** Today's workspace-settings `collabPendingUpdates` value. */
  pendingUpdateBase64: string | null;
}

class HarnessReplicaStore implements LocalReplicaStore {
  private loaded: LoadedLocalReplica | null = null;
  private nextLocalAppendGate: {
    started: () => void;
    wait: Promise<void>;
  } | null = null;

  delayNextLocalAppend(): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextLocalAppendGate = { started: markStarted, wait };
    return { started, release };
  }

  async load(
    identity: LocalReplicaIdentity
  ): Promise<LoadedLocalReplica | null> {
    if (!this.loaded) return null;
    return {
      ...this.loaded,
      identity,
      snapshot: this.loaded.snapshot?.slice() ?? null,
      updates: this.loaded.updates.map((item) => ({
        ...item,
        update: item.update.slice(),
      })),
      outbox: this.loaded.outbox.map((item) => ({
        ...item,
        update: item.update.slice(),
      })),
    };
  }

  async appendLocalUpdate(input: AppendLocalReplicaUpdateInput): Promise<void> {
    const gate = this.nextLocalAppendGate;
    if (gate) {
      this.nextLocalAppendGate = null;
      gate.started();
      await gate.wait;
    }
    const replica = this.ensure(input.identity, input.documentType);
    const now = Date.now();
    replica.updates.push({
      updateId: input.updateId,
      update: input.update.slice(),
      source: "local",
      serverSequence: null,
      snapshotGeneration: input.snapshotGeneration,
      createdAt: now,
    });
    replica.outbox.push({
      batchId: input.updateId,
      update: input.update.slice(),
      state: "queued",
      attemptCount: 0,
      lastErrorCode: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async appendRemoteUpdates(
    input: AppendRemoteReplicaUpdatesInput
  ): Promise<void> {
    const replica = this.ensure(input.identity, input.documentType);
    const knownSequences = new Set(
      replica.updates
        .map((item) => item.serverSequence)
        .filter((seq): seq is number => seq !== null)
    );
    for (const item of input.updates) {
      if (
        item.serverSequence !== null &&
        knownSequences.has(item.serverSequence)
      )
        continue;
      replica.updates.push({
        ...item,
        update: item.update.slice(),
        snapshotGeneration: input.snapshotGeneration,
        createdAt: Date.now(),
      });
      if (item.serverSequence !== null) knownSequences.add(item.serverSequence);
    }
    replica.lastServerSeq = Math.max(
      replica.lastServerSeq,
      input.lastServerSeq
    );
  }

  async setOutboxState(
    _identity: LocalReplicaIdentity,
    batchIds: string[],
    state: LocalReplicaOutboxState,
    lastErrorCode?: string | null
  ): Promise<void> {
    const ids = new Set(batchIds);
    for (const entry of this.loaded?.outbox ?? []) {
      if (!ids.has(entry.batchId)) continue;
      if (lastErrorCode !== undefined) entry.lastErrorCode = lastErrorCode;
      entry.attemptCount +=
        state === "inflight" && entry.state !== "inflight" ? 1 : 0;
      entry.updatedAt = Date.now();
      entry.state = state;
    }
  }

  async claimOutboxBatch(
    _identity: LocalReplicaIdentity,
    batchIds: string[]
  ): Promise<boolean> {
    const ids = new Set(batchIds);
    const entries = (this.loaded?.outbox ?? []).filter((entry) =>
      ids.has(entry.batchId)
    );
    if (
      entries.length !== batchIds.length ||
      entries.some((entry) => entry.state !== "queued")
    ) {
      return false;
    }
    for (const entry of entries) {
      entry.state = "inflight";
      entry.attemptCount += 1;
      entry.updatedAt = Date.now();
    }
    return true;
  }

  async loadOutbox(
    _identity: LocalReplicaIdentity
  ): Promise<LoadedLocalReplica["outbox"]> {
    return (this.loaded?.outbox ?? []).map((entry) => ({
      ...entry,
      update: entry.update.slice(),
    }));
  }

  async recordOutboxError(
    _identity: LocalReplicaIdentity,
    batchIds: string[],
    errorCode: string
  ): Promise<void> {
    const ids = new Set(batchIds);
    for (const entry of this.loaded?.outbox ?? []) {
      if (!ids.has(entry.batchId)) continue;
      entry.lastErrorCode = errorCode;
      entry.updatedAt = Date.now();
    }
  }

  async acknowledgeOutbox(
    _identity: LocalReplicaIdentity,
    batchIds: string[],
    serverSequence: number
  ): Promise<void> {
    if (!this.loaded) return;
    const ids = new Set(batchIds);
    const canonical = this.loaded.updates.find(
      (update) => update.updateId === batchIds[0]
    );
    if (canonical) canonical.serverSequence = serverSequence;
    this.loaded.outbox = this.loaded.outbox.filter(
      (entry) => !ids.has(entry.batchId)
    );
  }

  async replaceSnapshot(
    input: ReplaceLocalReplicaSnapshotInput
  ): Promise<boolean> {
    const replica = this.ensure(input.identity, input.documentType);
    if (replica.snapshotGeneration !== input.expectedGeneration) return false;
    replica.snapshot = input.snapshot.slice();
    replica.snapshotGeneration = input.nextGeneration;
    replica.lastServerSeq = input.lastServerSeq;
    replica.updates = [];
    return true;
  }

  async markIncomplete(): Promise<void> {
    if (this.loaded) this.loaded.completeness = "incomplete";
  }

  async markComplete(): Promise<void> {
    if (this.loaded) this.loaded.completeness = "complete";
  }

  async quarantine(): Promise<void> {
    if (this.loaded) this.loaded.completeness = "corrupt";
  }

  async resetForCleanHydration(): Promise<void> {
    if (!this.loaded) return;
    this.loaded.snapshot = null;
    this.loaded.snapshotGeneration = 0;
    this.loaded.lastServerSeq = 0;
    this.loaded.completeness = "corrupt";
    this.loaded.updates = [];
  }

  async discard(): Promise<void> {
    this.loaded = null;
  }

  async purgeByAccount(accountId: string): Promise<void> {
    if (this.loaded?.identity.accountId === accountId) this.loaded = null;
  }

  async purgeByOrg(accountId: string, orgId: string): Promise<void> {
    if (
      this.loaded?.identity.accountId === accountId &&
      this.loaded.identity.orgId === orgId
    ) {
      this.loaded = null;
    }
  }

  async getStorageUsage(): Promise<LocalReplicaStorageUsage> {
    if (!this.loaded) return { replicaCount: 0, encryptedBytes: 0, replicas: [] };
    const encryptedBytes =
      (this.loaded.snapshot?.byteLength ?? 0) +
      this.loaded.updates.reduce(
        (sum, item) => sum + item.update.byteLength,
        0
      ) +
      this.loaded.outbox.reduce((sum, item) => sum + item.update.byteLength, 0);
    return {
      replicaCount: 1,
      encryptedBytes,
      replicas: [{
        identity: this.loaded.identity,
        encryptedBytes,
        lastAccessedAt: Date.now(),
        clean: this.loaded.outbox.length === 0,
      }],
    };
  }

  async listPendingOutboxes(
    accountId?: string
  ): Promise<LocalReplicaPendingOutbox[]> {
    if (
      !this.loaded ||
      (accountId !== undefined &&
        this.loaded.identity.accountId !== accountId) ||
      this.loaded.outbox.length === 0
    ) {
      return [];
    }
    return [
      {
        identity: { ...this.loaded.identity },
        documentType: this.loaded.documentType,
        queuedCount: this.loaded.outbox.filter((entry) => entry.state === "queued").length,
        inflightCount: this.loaded.outbox.filter((entry) => entry.state === "inflight").length,
        rejectedCount: this.loaded.outbox.filter((entry) => entry.state === "rejected").length,
      },
    ];
  }

  installHydratedReplica(state: Uint8Array, lastServerSeq: number): void {
    const identity = {
      accountId: "account-user-a",
      orgId: "org-harness",
      documentId: "doc-harness",
    };
    this.loaded = {
      identity,
      documentType: "markdown",
      encodingVersion: 1,
      snapshot: state.slice(),
      snapshotGeneration: 0,
      lastServerSeq,
      completeness: "complete",
      updates: [],
      outbox: [],
    };
  }

  hasPendingOutbox(): boolean {
    return (this.loaded?.outbox.length ?? 0) > 0;
  }

  outboxStates(): LocalReplicaOutboxState[] {
    return (this.loaded?.outbox ?? []).map((entry) => entry.state);
  }

  outboxErrors(): Array<string | null> {
    return (this.loaded?.outbox ?? []).map((entry) => entry.lastErrorCode);
  }

  async acknowledgeOldestOutboxExternally(serverSequence: number): Promise<void> {
    const entry = this.loaded?.outbox[0];
    if (!entry) throw new Error("No durable outbox row to acknowledge");
    await this.acknowledgeOutbox(
      this.loaded!.identity,
      [entry.batchId],
      serverSequence
    );
  }

  oldestOutbox(): LoadedLocalReplica["outbox"][number] | null {
    const entry = this.loaded?.outbox[0];
    return entry ? { ...entry, update: entry.update.slice() } : null;
  }

  private ensure(
    identity: LocalReplicaIdentity,
    documentType: string
  ): LoadedLocalReplica {
    this.loaded ??= {
      identity,
      documentType,
      encodingVersion: 1,
      snapshot: null,
      snapshotGeneration: 0,
      lastServerSeq: 0,
      completeness: "complete",
      updates: [],
      outbox: [],
    };
    return this.loaded;
  }
}

interface StoredUpdate {
  sequence: number;
  encryptedUpdate: string;
  iv: string;
  senderId: string;
  createdAt: number;
  clientUpdateId?: string;
}

interface StoredSnapshot {
  encryptedState: string;
  iv: string;
  replacesUpTo: number;
  createdAt: number;
}

type SocketListener = (event: Event | MessageEvent | CloseEvent) => void;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_000
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class HarnessWebSocket {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: DocClientMessage[] = [];
  private readonly listeners = new Map<string, Set<SocketListener>>();

  constructor(
    private readonly server: HarnessDocumentServer,
    readonly userId: string
  ) {
    queueMicrotask(() => {
      if (this.server.online && this.readyState === WebSocket.CONNECTING) {
        this.readyState = WebSocket.OPEN;
        this.dispatch("open", new Event("open"));
      }
    });
  }

  addEventListener(type: string, listener: SocketListener): void {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: SocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.readyState !== WebSocket.OPEN) return;
    const message = JSON.parse(data) as DocClientMessage;
    this.sent.push(message);
    this.server.receive(this, message);
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.server.removeSocket(this);
    this.dispatch("close", new CloseEvent("close", { code: 1000 }));
  }

  closeForNetworkLoss(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.server.removeSocket(this);
    this.dispatch(
      "close",
      new CloseEvent("close", { code: 1006, reason: "network unavailable" })
    );
  }

  deliver(message: DocServerMessage): void {
    if (this.readyState !== WebSocket.OPEN) return;
    queueMicrotask(() => {
      if (this.readyState !== WebSocket.OPEN) return;
      this.dispatch(
        "message",
        new MessageEvent("message", { data: JSON.stringify(message) })
      );
    });
  }

  private dispatch(
    type: string,
    event: Event | MessageEvent | CloseEvent
  ): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/**
 * Small in-memory DocumentRoom used by the Slice 0 executable harness.
 *
 * It mirrors the hardened DocumentRoom contract: sequence pagination,
 * snapshots with `replacesUpTo`, explicit head/state fields, stable-ID
 * dedupe, and acknowledgements that can be dropped after insertion.
 */
export class HarnessDocumentServer {
  online = true;
  exposeExplicitState = true;
  pageSize = 100;
  dropNextUpdateAck = false;
  rejectNextLiveWith: string | null = null;
  rejectNextLiveClientUpdateId: string | null = null;
  rejectNextDrainWith: string | null = null;
  readonly syncRequests: Array<{ userId: string; sinceSeq: number }> = [];
  readonly syncResponses: Array<{
    userId: string;
    cursor: number;
    hasMore: boolean;
    updateCount: number;
    includedSnapshot: boolean;
  }> = [];
  readonly compactionAttempts: Array<{
    userId: string;
    replacesUpTo: number;
  }> = [];
  readonly updates: StoredUpdate[] = [];

  private readonly sockets = new Set<HarnessWebSocket>();
  private readonly serverDoc = new Y.Doc();
  private snapshot: StoredSnapshot | null = null;
  private nextSequence = 1;
  private readonly updateDedupe = new Map<string, StoredUpdate>();
  private nextDrainGate: { started: () => void; wait: Promise<void> } | null = null;

  delayNextDrain(): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextDrainGate = { started: markStarted, wait };
    return { started, release };
  }

  createWebSocket(userId: string): WebSocket {
    const socket = new HarnessWebSocket(this, userId);
    this.sockets.add(socket);
    return socket as unknown as WebSocket;
  }

  setOnline(online: boolean): void {
    this.online = online;
    if (!online) {
      for (const socket of [...this.sockets]) socket.closeForNetworkLoss();
    }
  }

  removeSocket(socket: HarnessWebSocket): void {
    this.sockets.delete(socket);
  }

  receive(socket: HarnessWebSocket, message: DocClientMessage): void {
    if (!this.online) return;
    switch (message.type) {
      case "docSyncRequest":
        this.handleSyncRequest(socket, message.sinceSeq);
        return;
      case "docUpdate":
        this.insertUpdate(socket, message);
        return;
      case "docCompact":
        this.acceptCompaction(socket, message);
        return;
      case "docAwareness":
      case "addKeyEnvelope":
      case "requestKeyEnvelope":
      case "docSetMetadata":
        return;
    }
  }

  seedChange(key: string, value: string, senderId = "seed-user"): number {
    let update: Uint8Array | null = null;
    const capture = (nextUpdate: Uint8Array) => {
      update = nextUpdate.slice();
    };
    this.serverDoc.on("update", capture);
    this.serverDoc.getMap<string>("content").set(key, value);
    this.serverDoc.off("update", capture);
    if (!update) throw new Error("Yjs did not produce an update for the seed");
    return this.appendStoredUpdate(update, senderId).sequence;
  }

  compactCurrentState(): void {
    const replacesUpTo = this.headSequence;
    this.snapshot = {
      encryptedState: bytesToBase64(Y.encodeStateAsUpdate(this.serverDoc)),
      iv: "",
      replacesUpTo,
      createdAt: Date.now(),
    };
    this.removeUpdatesThrough(replacesUpTo);
  }

  get headSequence(): number {
    return this.nextSequence - 1;
  }

  get snapshotReplacesUpTo(): number {
    return this.snapshot?.replacesUpTo ?? 0;
  }

  content(key: string): string | undefined {
    return this.serverDoc.getMap<string>("content").get(key);
  }

  async drainBatch(
    userId: string,
    batchId: string,
    update: Uint8Array
  ): Promise<
    | { status: "acknowledged"; sequence: number }
    | { status: "rejected"; errorCode: string }
  > {
    const gate = this.nextDrainGate;
    if (gate) {
      this.nextDrainGate = null;
      gate.started();
      await gate.wait;
    }
    if (this.rejectNextDrainWith) {
      const errorCode = this.rejectNextDrainWith;
      this.rejectNextDrainWith = null;
      return { status: "rejected", errorCode };
    }
    const dedupeKey = `${userId}:${batchId}`;
    const existing = this.updateDedupe.get(dedupeKey);
    if (existing)
      return { status: "acknowledged", sequence: existing.sequence };
    const stored = this.appendStoredUpdate(update, userId, batchId);
    this.updateDedupe.set(dedupeKey, stored);
    return { status: "acknowledged", sequence: stored.sequence };
  }

  destroy(): void {
    for (const socket of [...this.sockets]) socket.close();
    this.serverDoc.destroy();
  }

  private handleSyncRequest(socket: HarnessWebSocket, sinceSeq: number): void {
    this.syncRequests.push({ userId: socket.userId, sinceSeq });

    const includeSnapshot =
      !!this.snapshot && sinceSeq < this.snapshot.replacesUpTo;
    const floor = includeSnapshot ? this.snapshot!.replacesUpTo : sinceSeq;
    const available = this.updates.filter((update) => update.sequence > floor);
    const page = available.slice(0, this.pageSize);
    const hasMore = available.length > page.length;
    const cursor = page.at(-1)?.sequence ?? Math.max(floor, this.headSequence);

    this.syncResponses.push({
      userId: socket.userId,
      cursor,
      hasMore,
      updateCount: page.length,
      includedSnapshot: includeSnapshot,
    });
    const response: Extract<DocServerMessage, { type: "docSyncResponse" }> = {
      type: "docSyncResponse",
      updates: page.map(
        ({ clientUpdateId: _clientUpdateId, ...update }) => update
      ),
      snapshot: includeSnapshot ? this.snapshot! : undefined,
      hasMore,
      cursor,
    };
    if (this.exposeExplicitState) {
      response.serverHead = this.headSequence;
      response.serverHasState = this.headSequence > 0;
    }
    socket.deliver(response);
  }

  private insertUpdate(
    socket: HarnessWebSocket,
    message: Extract<DocClientMessage, { type: "docUpdate" }>
  ): void {
    if (this.rejectNextLiveWith) {
      const errorCode = this.rejectNextLiveWith;
      this.rejectNextLiveWith = null;
      socket.deliver({
        type: "error",
        code: errorCode,
        message: "temporary write barrier",
        clientUpdateId: this.rejectNextLiveClientUpdateId ?? message.clientUpdateId,
      });
      this.rejectNextLiveClientUpdateId = null;
      return;
    }
    const dedupeKey = `${socket.userId}:${message.clientUpdateId ?? ""}`;
    const existing = message.clientUpdateId
      ? this.updateDedupe.get(dedupeKey)
      : undefined;
    const stored =
      existing ??
      this.appendStoredUpdate(
        base64ToBytes(message.encryptedUpdate),
        socket.userId,
        message.clientUpdateId
      );
    if (!existing && message.clientUpdateId) {
      this.updateDedupe.set(dedupeKey, stored);
    }

    if (!existing) {
      for (const peer of this.sockets) {
        if (peer === socket) continue;
        peer.deliver({
          type: "docUpdateBroadcast",
          encryptedUpdate: stored.encryptedUpdate,
          iv: stored.iv,
          senderId: stored.senderId,
          sequence: stored.sequence,
        });
      }
    }

    if (this.dropNextUpdateAck) {
      this.dropNextUpdateAck = false;
      return;
    }
    socket.deliver({
      type: "docUpdateAck",
      clientUpdateId: message.clientUpdateId ?? "",
      sequence: stored.sequence,
    });
  }

  private appendStoredUpdate(
    update: Uint8Array,
    senderId: string,
    clientUpdateId?: string
  ): StoredUpdate {
    Y.applyUpdate(this.serverDoc, update, "wire");
    const stored: StoredUpdate = {
      sequence: this.nextSequence++,
      encryptedUpdate: bytesToBase64(update),
      iv: "",
      senderId,
      createdAt: Date.now(),
      clientUpdateId,
    };
    this.updates.push(stored);
    return stored;
  }

  private acceptCompaction(
    socket: HarnessWebSocket,
    message: Extract<DocClientMessage, { type: "docCompact" }>
  ): void {
    this.compactionAttempts.push({
      userId: socket.userId,
      replacesUpTo: message.replacesUpTo,
    });
    this.snapshot = {
      encryptedState: message.encryptedState,
      iv: message.iv,
      replacesUpTo: message.replacesUpTo,
      createdAt: Date.now(),
    };
    this.removeUpdatesThrough(message.replacesUpTo);
    socket.deliver({
      type: "docCompactAck",
      clientCompactId: message.clientCompactId,
      accepted: true,
      replacesUpTo: message.replacesUpTo,
    });
  }

  private removeUpdatesThrough(sequence: number): void {
    for (let index = this.updates.length - 1; index >= 0; index--) {
      if (this.updates[index].sequence <= sequence)
        this.updates.splice(index, 1);
    }
  }
}

export class HarnessClient {
  readonly statuses: DocumentSyncStatus[] = [];
  readonly firstSyncEmptyResults: boolean[] = [];
  readonly persisted: PersistedClientState = { pendingUpdateBase64: null };

  provider: DocumentSyncProvider | null = null;
  private outboxProviderAttached = true;
  private replica: LocalDocumentReplica | null = null;
  private readonly replicaStore = new HarnessReplicaStore();
  private readonly outboxDrainer = new OutboxDrainer({
    store: this.replicaStore,
    createTransport: async () => ({
      send: async (batch) =>
        this.server.drainBatch(this.userId, batch.batchId, batch.update),
    }),
    isLiveProviderAttached: () => this.outboxProviderAttached,
  });
  private detachedOutboxPending = false;

  constructor(
    readonly userId: string,
    private readonly server: HarnessDocumentServer
  ) {
    this.createColdProvider();
  }

  async connect(): Promise<void> {
    if (!this.provider) this.createColdProvider();
    await this.replica!.whenReady;
    await this.provider!.connect();
    await waitFor(
      () => this.provider?.isSynced() === true,
      `${this.userId} network readiness`
    );
  }

  disconnect(): void {
    this.provider?.disconnect();
  }

  edit(key: string, value: string): void {
    if (!this.provider)
      throw new Error("Cannot edit without an attached provider");
    this.provider.getYDoc().getMap<string>("content").set(key, value);
  }

  delayNextReplicaWrite(): { started: Promise<void>; release: () => void } {
    return this.replicaStore.delayNextLocalAppend();
  }

  markReplicaUnavailable(): void {
    if (!this.replica) throw new Error("A replica is required");
    const internals = this.replica as unknown as { state: string };
    internals.state = "unavailable";
  }

  content(key: string): string | undefined {
    return this.provider?.getYDoc().getMap<string>("content").get(key);
  }

  async waitForContent(key: string, value: string): Promise<void> {
    await waitFor(
      () => this.content(key) === value,
      `${this.userId} content ${key}=${value}`
    );
  }

  async waitForOutbox(outbox: HarnessOutboxState): Promise<void> {
    await waitFor(
      () => this.readiness().outbox === outbox,
      `${this.userId} outbox ${outbox}`
    );
  }

  drainOutboxOnce() {
    return this.outboxDrainer.drainOnce(`account-${this.userId}`);
  }

  persistedOutboxStates(): LocalReplicaOutboxState[] {
    return this.replicaStore.outboxStates();
  }

  persistedOutboxErrors(): Array<string | null> {
    return this.replicaStore.outboxErrors();
  }

  async acknowledgeOldestOutboxExternally(_serverSequence: number): Promise<void> {
    const entry = this.replicaStore.oldestOutbox();
    if (!entry) throw new Error("No durable outbox row to drain");
    const result = await this.server.drainBatch(
      this.userId,
      entry.batchId,
      entry.update
    );
    if (result.status !== "acknowledged") {
      throw new Error(`External drain rejected: ${result.errorCode}`);
    }
    await this.replicaStore.acknowledgeOldestOutboxExternally(result.sequence);
  }

  async restart(options: { connect: boolean }): Promise<void> {
    this.provider?.destroy();
    this.provider = null;
    const closingReplica = this.replica;
    this.replica = null;
    await closingReplica?.destroy();
    this.detachedOutboxPending = false;
    this.outboxProviderAttached = true;
    this.createColdProvider();
    await this.replica!.whenReady;
    if (options.connect) await this.connect();
  }

  closeEditor(options: { autoDrain?: boolean } = {}): void {
    this.provider?.destroy();
    this.provider = null;
    this.outboxProviderAttached = false;
    const closingReplica = this.replica;
    this.detachedOutboxPending =
      closingReplica?.hasPendingOutbox() ?? this.detachedOutboxPending;
    void closingReplica
      ?.destroy()
      .then(() => {
        this.detachedOutboxPending = this.replicaStore.hasPendingOutbox();
        return options.autoDrain === false
          ? undefined
          : this.outboxDrainer.drainOnce(`account-${this.userId}`);
      })
      .then(() => {
        this.detachedOutboxPending = this.replicaStore.hasPendingOutbox();
      });
    this.replica = null;
  }

  async attachProviderAfterDrainerHandoff(): Promise<void> {
    const identity = {
      accountId: `account-${this.userId}`,
      orgId: "org-harness",
      documentId: "doc-harness",
    };
    this.outboxProviderAttached = true;
    await this.outboxDrainer.yieldToLiveProvider(identity);
    this.createColdProvider();
    await this.replica!.whenReady;
  }

  readiness(): HarnessReadiness {
    const providerInternals = this.provider as unknown as {
      queuedPendingUpdate?: Uint8Array | null;
      inflightPendingUpdate?: Uint8Array | null;
      replayingClientUpdateId?: string | null;
    } | null;
    let outbox: HarnessOutboxState = "clean";
    if (providerInternals?.replayingClientUpdateId) outbox = "replaying";
    else if (
      providerInternals?.queuedPendingUpdate ||
      providerInternals?.inflightPendingUpdate ||
      this.replica?.hasPendingOutbox() ||
      this.detachedOutboxPending ||
      (!this.provider && this.persisted.pendingUpdateBase64) ||
      (!this.provider && this.replicaStore.hasPendingOutbox())
    ) {
      outbox = "pending";
    }

    return {
      localReady: this.provider !== null,
      networkReady: this.provider?.isSynced() ?? false,
      outbox,
    };
  }

  expectReadiness(expected: HarnessReadiness): void {
    expect(this.readiness()).toEqual(expected);
  }

  /**
   * Installs a complete local state and durable cursor at the current provider
   * seam. Slice 1/2 will replace this harness-only injection with real store
   * hydration; it lets Slice 0 execute reconnect-at-head behavior now.
   */
  installHydratedReplica(state: Uint8Array, lastServerSeq: number): void {
    if (!this.provider) throw new Error("A provider is required");
    Y.applyUpdate(this.provider.getYDoc(), state, "remote");
    const internals = this.provider as unknown as {
      lastSeq: number;
      queuedPendingUpdate: Uint8Array | null;
      inflightPendingUpdate: Uint8Array | null;
      replayingClientUpdateId: string | null;
    };
    internals.lastSeq = lastServerSeq;
    internals.queuedPendingUpdate = null;
    internals.inflightPendingUpdate = null;
    internals.replayingClientUpdateId = null;
    this.persisted.pendingUpdateBase64 = null;
    this.replicaStore.installHydratedReplica(state, lastServerSeq);
    const replicaInternals = this.replica as unknown as {
      lastServerSeq: number;
      outbox: Map<string, unknown>;
    };
    replicaInternals.lastServerSeq = lastServerSeq;
    replicaInternals.outbox.clear();
  }

  async attemptServerCompaction(lastSeq = 500): Promise<void> {
    if (!this.provider) throw new Error("A provider is required");
    const internals = this.provider as unknown as {
      lastSeq: number;
      lastSnapshotSeq: number;
      maybeCompact: () => Promise<void>;
    };
    internals.lastSeq = lastSeq;
    internals.lastSnapshotSeq = 0;
    await internals.maybeCompact();
  }

  clearTransientPendingState(): void {
    if (!this.provider) throw new Error("A provider is required");
    const internals = this.provider as unknown as {
      queuedPendingUpdate: Uint8Array | null;
      inflightPendingUpdate: Uint8Array | null;
      replayingClientUpdateId: string | null;
    };
    internals.queuedPendingUpdate = null;
    internals.inflightPendingUpdate = null;
    internals.replayingClientUpdateId = null;
  }

  destroy(): void {
    this.closeEditor();
  }

  private createColdProvider(): void {
    this.statuses.length = 0;
    this.replica = new LocalDocumentReplica({
      identity: {
        accountId: `account-${this.userId}`,
        orgId: "org-harness",
        documentId: "doc-harness",
      },
      documentType: "markdown",
      store: this.replicaStore,
    });
    this.provider = new DocumentSyncProvider({
      serverUrl: "ws://document-harness.test",
      getJwt: async () => "harness-token",
      orgId: "org-harness",
      documentId: "doc-harness",
      userId: this.userId,
      keyCustody: "server-managed",
      reviewGateEnabled: false,
      replica: this.replica,
      initialPendingUpdateBase64:
        this.persisted.pendingUpdateBase64 ?? undefined,
      createWebSocket: () => this.server.createWebSocket(this.userId),
      onPendingUpdateChange: (pendingUpdateBase64) => {
        this.persisted.pendingUpdateBase64 = pendingUpdateBase64;
      },
      onStatusChange: (status) => this.statuses.push(status),
      onFirstSyncComplete: (isEmpty) =>
        this.firstSyncEmptyResults.push(isEmpty),
    });
  }
}

export class TwoProviderDocumentSyncHarness {
  readonly server = new HarnessDocumentServer();
  readonly a = new HarnessClient("user-a", this.server);
  readonly b = new HarnessClient("user-b", this.server);

  async connectBoth(): Promise<void> {
    await Promise.all([this.a.connect(), this.b.connect()]);
  }

  loseNetwork(): void {
    // Explicit disconnect suppresses production reconnect timers; taking the
    // fake server offline then models the unavailable transport deterministically.
    this.a.disconnect();
    this.b.disconnect();
    this.server.setOnline(false);
  }

  restoreNetwork(): void {
    this.server.setOnline(true);
  }

  destroy(): void {
    this.a.destroy();
    this.b.destroy();
    this.server.destroy();
  }
}
