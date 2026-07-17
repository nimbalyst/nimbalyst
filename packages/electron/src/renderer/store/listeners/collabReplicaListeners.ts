import type { LocalReplicaIdentity } from '@nimbalyst/runtime/sync';

type SiblingUpdateListener = (update: Uint8Array) => void;

const listeners = new Map<string, Set<SiblingUpdateListener>>();

function identityKey(identity: LocalReplicaIdentity): string {
  return `${identity.accountId}\u0000${identity.orgId}\u0000${identity.documentId}`;
}

const REQUIRED_REPLICA_PRELOAD_METHODS = [
  'onReplicaLocalUpdate',
  'replicaLoad',
  'replicaAppendLocal',
  'replicaAppendRemote',
  'replicaSetOutboxState',
  'replicaClaimOutbox',
  'replicaLoadOutbox',
  'replicaAckOutbox',
  'replicaRecordOutboxError',
  'replicaReplaceSnapshot',
  'replicaMarkComplete',
  'replicaMarkIncomplete',
  'replicaResetForCleanHydration',
  'replicaQuarantine',
] as const;

/**
 * Renderer updates can arrive before a restarted desktop process has loaded the
 * matching preload. Keep the staged feature on the legacy path until the whole
 * replica IPC contract is present.
 */
export function hasCollabReplicaPreloadSupport(): boolean {
  const documentSync = window.electronAPI?.documentSync as unknown as
    | Record<string, unknown>
    | undefined;
  return REQUIRED_REPLICA_PRELOAD_METHODS.every(
    (method) => typeof documentSync?.[method] === 'function',
  );
}

/** Installs the single renderer IPC listener that fans durable updates into replicas. */
export function initCollabReplicaListeners(): () => void {
  const onReplicaLocalUpdate = window.electronAPI?.documentSync?.onReplicaLocalUpdate;
  if (typeof onReplicaLocalUpdate !== 'function') return () => {};

  return onReplicaLocalUpdate((payload) => {
    for (const listener of listeners.get(identityKey(payload.identity)) ?? []) {
      listener(payload.update.slice());
    }
  });
}

export function subscribeToCollabReplicaLocalUpdates(
  identity: LocalReplicaIdentity,
  listener: SiblingUpdateListener,
): () => void {
  const key = identityKey(identity);
  const identityListeners = listeners.get(key) ?? new Set<SiblingUpdateListener>();
  identityListeners.add(listener);
  listeners.set(key, identityListeners);
  return () => {
    identityListeners.delete(listener);
    if (identityListeners.size === 0) listeners.delete(key);
  };
}
