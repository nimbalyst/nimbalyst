export interface LocalReplicaIdentity {
  accountId: string;
  orgId: string;
  documentId: string;
}

export type LocalReplicaCompleteness = "complete" | "incomplete" | "corrupt";
export type LocalReplicaUpdateSource = "local" | "remote" | "server-snapshot";
export type LocalReplicaOutboxState = "queued" | "inflight" | "rejected";
export type LocalDocumentReplicaOutboxState =
  | "clean"
  | "pending"
  | "replaying"
  | "rejected";

export interface LocalReplicaUpdate {
  updateId: string;
  update: Uint8Array;
  source: LocalReplicaUpdateSource;
  serverSequence: number | null;
  snapshotGeneration: number;
  createdAt: number;
}

export interface LocalReplicaOutboxEntry {
  batchId: string;
  update: Uint8Array;
  state: LocalReplicaOutboxState;
  attemptCount: number;
  lastErrorCode: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface LocalReplicaPendingOutbox {
  identity: LocalReplicaIdentity;
  documentType: string;
  queuedCount: number;
  inflightCount: number;
  rejectedCount: number;
}

export interface LoadedLocalReplica {
  identity: LocalReplicaIdentity;
  documentType: string;
  encodingVersion: number;
  snapshot: Uint8Array | null;
  snapshotGeneration: number;
  lastServerSeq: number;
  completeness: LocalReplicaCompleteness;
  updates: LocalReplicaUpdate[];
  outbox: LocalReplicaOutboxEntry[];
}

export interface AppendLocalReplicaUpdateInput {
  identity: LocalReplicaIdentity;
  documentType: string;
  updateId: string;
  update: Uint8Array;
  snapshotGeneration: number;
}

export interface AppendRemoteReplicaUpdatesInput {
  identity: LocalReplicaIdentity;
  documentType: string;
  updates: Array<{
    updateId: string;
    update: Uint8Array;
    source: Exclude<LocalReplicaUpdateSource, "local">;
    /** Snapshots use null so they never collide with incremental sequences. */
    serverSequence: number | null;
  }>;
  snapshotGeneration: number;
  lastServerSeq: number;
}

export interface ReplaceLocalReplicaSnapshotInput {
  identity: LocalReplicaIdentity;
  documentType: string;
  snapshot: Uint8Array;
  expectedGeneration: number;
  nextGeneration: number;
  lastServerSeq: number;
  /** Tail rows represented by the snapshot basis; pending outbox rows stay pinned. */
  coveredUpdateIds?: string[];
}

export interface LocalReplicaStorageUsage {
  replicaCount: number;
  encryptedBytes: number;
  replicas: Array<{
    identity: LocalReplicaIdentity;
    encryptedBytes: number;
    lastAccessedAt: number;
    clean: boolean;
  }>;
}

/**
 * Platform-neutral durable storage boundary for a local collaborative replica.
 * Implementations own encryption and transactional persistence.
 */
export interface LocalReplicaStore {
  load(identity: LocalReplicaIdentity): Promise<LoadedLocalReplica | null>;
  appendLocalUpdate(input: AppendLocalReplicaUpdateInput): Promise<void>;
  appendRemoteUpdates(input: AppendRemoteReplicaUpdatesInput): Promise<void>;
  setOutboxState(
    identity: LocalReplicaIdentity,
    batchIds: string[],
    state: LocalReplicaOutboxState,
    lastErrorCode?: string | null
  ): Promise<void>;
  /** Atomically claims every supplied queued row for a single merged send. */
  claimOutboxBatch(
    identity: LocalReplicaIdentity,
    batchIds: string[]
  ): Promise<boolean>;
  /** Loads only a document's durable outbox; replica state is not loaded. */
  loadOutbox(identity: LocalReplicaIdentity): Promise<LocalReplicaOutboxEntry[]>;
  /** Records a retryable failure without changing the claimed batch state. */
  recordOutboxError(
    identity: LocalReplicaIdentity,
    batchIds: string[],
    errorCode: string
  ): Promise<void>;
  acknowledgeOutbox(
    identity: LocalReplicaIdentity,
    batchIds: string[],
    serverSequence: number
  ): Promise<void>;
  replaceSnapshot(input: ReplaceLocalReplicaSnapshotInput): Promise<boolean>;
  markIncomplete(identity: LocalReplicaIdentity): Promise<void>;
  markComplete(identity: LocalReplicaIdentity): Promise<void>;
  quarantine(identity: LocalReplicaIdentity, reason: string): Promise<void>;
  /** Clears quarantined snapshot/tail state while preserving the durable outbox. */
  resetForCleanHydration(identity: LocalReplicaIdentity): Promise<void>;
  /** Permanently deletes one local replica, including its update tail and outbox. */
  discard(identity: LocalReplicaIdentity): Promise<void>;
  purgeByAccount(accountId: string): Promise<void>;
  purgeByOrg(accountId: string, orgId: string): Promise<void>;
  getStorageUsage(accountId: string): Promise<LocalReplicaStorageUsage>;
  /** Enumerates metadata only; encrypted outbox payloads are not read/decrypted. */
  listPendingOutboxes(accountId?: string): Promise<LocalReplicaPendingOutbox[]>;
  /** Applies already-durable local updates broadcast by a sibling renderer. */
  subscribeToSiblingLocalUpdates?(
    identity: LocalReplicaIdentity,
    listener: (update: Uint8Array) => void
  ): () => void;
}
