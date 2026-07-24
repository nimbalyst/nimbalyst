import { getCollabAssetStore } from "./CollabAssetStore";
import { getCollabDocumentReplicaStore } from "./CollabDocumentReplicaStore";

/**
 * Account logout is an explicit privacy boundary. Delete cached attachments
 * before the replica store removes the shared safeStorage-wrapped device key.
 */
export interface CollabOfflineAccountPurgeDeps {
  hasReplicaData(accountId: string): Promise<boolean>;
  hasAssetData(accountId: string): Promise<boolean>;
  listPendingReplicaDocuments(accountId: string): Promise<Array<{
    identity: { accountId: string; orgId: string; documentId: string };
  }>>;
  listPendingAssetUploads(accountId: string): Promise<Array<{
    identity: { accountId: string; orgId: string; documentId: string };
  }>>;
  assertReplicaPurgeAllowed(accountId: string, force: boolean): Promise<void>;
  assertAssetPurgeAllowed(accountId: string, force: boolean): Promise<void>;
  purgeAssets(accountId: string, force: boolean): Promise<void>;
  purgeReplicas(accountId: string, force: boolean): Promise<void>;
}

const defaultDeps: CollabOfflineAccountPurgeDeps = {
  hasReplicaData: (accountId) =>
    getCollabDocumentReplicaStore().hasAccountData(accountId),
  hasAssetData: (accountId) => getCollabAssetStore().hasAccountData(accountId),
  listPendingReplicaDocuments: (accountId) =>
    getCollabDocumentReplicaStore().listPendingOutboxes(accountId),
  listPendingAssetUploads: (accountId) =>
    getCollabAssetStore().listUnsentUploads(accountId),
  assertReplicaPurgeAllowed: (accountId, force) =>
    getCollabDocumentReplicaStore().assertAccountPurgeAllowed(accountId, force),
  assertAssetPurgeAllowed: (accountId, force) =>
    getCollabAssetStore().assertAccountPurgeAllowed(accountId, force),
  purgeAssets: (accountId, force) =>
    getCollabAssetStore().purgeByAccount(accountId, force),
  purgeReplicas: (accountId, force) =>
    getCollabDocumentReplicaStore().purgeByAccount(accountId, force),
};

export interface CollabOfflineAccountPurgeResult {
  purged: boolean;
  pendingDocumentCount: number;
}

export async function purgeOfflineCollabAccounts(
  accountIds: string[],
  options: { force: boolean },
  deps: CollabOfflineAccountPurgeDeps = defaultDeps
): Promise<CollabOfflineAccountPurgeResult> {
  const accountsWithData: string[] = [];
  const pendingDocuments = new Set<string>();

  for (const accountId of [...new Set(accountIds)]) {
    const [hasReplicaData, hasAssetData] = await Promise.all([
      deps.hasReplicaData(accountId),
      deps.hasAssetData(accountId),
    ]);
    if (!hasReplicaData && !hasAssetData) continue;
    accountsWithData.push(accountId);
    const [replicaPending, assetPending] = await Promise.all([
      deps.listPendingReplicaDocuments(accountId),
      deps.listPendingAssetUploads(accountId),
    ]);
    for (const item of [...replicaPending, ...assetPending]) {
      const { identity } = item;
      pendingDocuments.add(
        `${identity.accountId}\u0000${identity.orgId}\u0000${identity.documentId}`
      );
    }
  }

  if (pendingDocuments.size > 0 && !options.force) {
    return { purged: false, pendingDocumentCount: pendingDocuments.size };
  }

  for (const accountId of accountsWithData) {
    await Promise.all([
      deps.assertReplicaPurgeAllowed(accountId, options.force),
      deps.assertAssetPurgeAllowed(accountId, options.force),
    ]);
  }
  for (const accountId of accountsWithData) {
    await deps.purgeAssets(accountId, true);
    await deps.purgeReplicas(accountId, true);
  }
  return { purged: true, pendingDocumentCount: pendingDocuments.size };
}

export async function purgeOfflineCollabAccount(
  accountId: string,
  deps: CollabOfflineAccountPurgeDeps = defaultDeps
): Promise<CollabOfflineAccountPurgeResult> {
  return purgeOfflineCollabAccounts([accountId], { force: true }, deps);
}
