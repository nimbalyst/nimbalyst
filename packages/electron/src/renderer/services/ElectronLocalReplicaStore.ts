import type {
  AppendLocalReplicaUpdateInput,
  AppendRemoteReplicaUpdatesInput,
  LoadedLocalReplica,
  LocalReplicaIdentity,
  LocalReplicaOutboxEntry,
  LocalReplicaOutboxState,
  LocalReplicaPendingOutbox,
  LocalReplicaStorageUsage,
  LocalReplicaStore,
  ReplaceLocalReplicaSnapshotInput,
} from "@nimbalyst/runtime/sync";
import { subscribeToCollabReplicaLocalUpdates } from "../store/listeners/collabReplicaListeners";

/** Renderer facade for the encrypted main-process replica store. */
export class ElectronLocalReplicaStore implements LocalReplicaStore {
  constructor(private readonly workspacePath: string) {}

  load(identity: LocalReplicaIdentity): Promise<LoadedLocalReplica | null> {
    return window.electronAPI.documentSync.replicaLoad(
      this.workspacePath,
      identity
    );
  }

  appendLocalUpdate(input: AppendLocalReplicaUpdateInput): Promise<void> {
    return window.electronAPI.documentSync.replicaAppendLocal(
      this.workspacePath,
      input
    );
  }

  appendRemoteUpdates(input: AppendRemoteReplicaUpdatesInput): Promise<void> {
    return window.electronAPI.documentSync.replicaAppendRemote(
      this.workspacePath,
      input
    );
  }

  setOutboxState(
    identity: LocalReplicaIdentity,
    batchIds: string[],
    state: LocalReplicaOutboxState,
    lastErrorCode?: string | null
  ): Promise<void> {
    return window.electronAPI.documentSync.replicaSetOutboxState(
      this.workspacePath,
      identity,
      batchIds,
      state,
      lastErrorCode
    );
  }

  claimOutboxBatch(
    identity: LocalReplicaIdentity,
    batchIds: string[]
  ): Promise<boolean> {
    return window.electronAPI.documentSync.replicaClaimOutbox(
      this.workspacePath,
      identity,
      batchIds
    );
  }

  loadOutbox(identity: LocalReplicaIdentity): Promise<LocalReplicaOutboxEntry[]> {
    return window.electronAPI.documentSync.replicaLoadOutbox(
      this.workspacePath,
      identity
    );
  }

  recordOutboxError(
    identity: LocalReplicaIdentity,
    batchIds: string[],
    errorCode: string
  ): Promise<void> {
    return window.electronAPI.documentSync.replicaRecordOutboxError(
      this.workspacePath,
      identity,
      batchIds,
      errorCode
    );
  }

  acknowledgeOutbox(
    identity: LocalReplicaIdentity,
    batchIds: string[],
    serverSequence: number
  ): Promise<void> {
    return window.electronAPI.documentSync.replicaAckOutbox(
      this.workspacePath,
      identity,
      batchIds,
      serverSequence
    );
  }

  replaceSnapshot(input: ReplaceLocalReplicaSnapshotInput): Promise<boolean> {
    return window.electronAPI.documentSync.replicaReplaceSnapshot(
      this.workspacePath,
      input
    );
  }

  markIncomplete(identity: LocalReplicaIdentity): Promise<void> {
    return window.electronAPI.documentSync.replicaMarkIncomplete(
      this.workspacePath,
      identity
    );
  }

  markComplete(identity: LocalReplicaIdentity): Promise<void> {
    return window.electronAPI.documentSync.replicaMarkComplete(
      this.workspacePath,
      identity
    );
  }

  quarantine(identity: LocalReplicaIdentity, reason: string): Promise<void> {
    return window.electronAPI.documentSync.replicaQuarantine(
      this.workspacePath,
      identity,
      reason
    );
  }

  resetForCleanHydration(identity: LocalReplicaIdentity): Promise<void> {
    return window.electronAPI.documentSync.replicaResetForCleanHydration(
      this.workspacePath,
      identity
    );
  }

  discard(identity: LocalReplicaIdentity): Promise<void> {
    return window.electronAPI.documentSync.replicaDiscard(
      this.workspacePath,
      identity
    );
  }

  purgeByAccount(accountId: string): Promise<void> {
    return window.electronAPI.documentSync.replicaPurgeAccount(
      this.workspacePath,
      accountId
    );
  }

  purgeByOrg(accountId: string, orgId: string): Promise<void> {
    return window.electronAPI.documentSync.replicaPurgeOrg(
      this.workspacePath,
      accountId,
      orgId
    );
  }

  getStorageUsage(accountId: string): Promise<LocalReplicaStorageUsage> {
    return window.electronAPI.documentSync.replicaStorageUsage(
      this.workspacePath,
      accountId
    );
  }

  listPendingOutboxes(
    accountId?: string
  ): Promise<LocalReplicaPendingOutbox[]> {
    return window.electronAPI.documentSync.replicaListPendingOutboxes(
      this.workspacePath,
      accountId
    );
  }

  subscribeToSiblingLocalUpdates(
    identity: LocalReplicaIdentity,
    listener: (update: Uint8Array) => void
  ): () => void {
    return subscribeToCollabReplicaLocalUpdates(identity, listener);
  }
}
