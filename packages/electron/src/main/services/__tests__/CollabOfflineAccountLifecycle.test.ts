import { describe, expect, it, vi } from "vitest";
import {
  purgeOfflineCollabAccount,
  purgeOfflineCollabAccounts,
} from "../CollabOfflineAccountLifecycle";

describe("offline collaboration account lifecycle", () => {
  it("purges asset bytes before replicas remove the shared device key", async () => {
    const order: string[] = [];
    const purgeAssets = vi.fn(async (accountId: string) => {
      order.push(`assets:${accountId}`);
    });
    const purgeReplicas = vi.fn(async (accountId: string) => {
      order.push(`replicas:${accountId}`);
    });

    await purgeOfflineCollabAccount("account-a", {
      hasReplicaData: async () => true,
      hasAssetData: async () => true,
      listPendingReplicaDocuments: async () => [],
      listPendingAssetUploads: async () => [],
      assertReplicaPurgeAllowed: async () => undefined,
      assertAssetPurgeAllowed: async () => undefined,
      purgeAssets,
      purgeReplicas,
    });

    expect(order).toEqual(["assets:account-a", "replicas:account-a"]);
  });

  it("does not purge any sign-out account until pending offline work is explicitly confirmed", async () => {
    const purgeAssets = vi.fn(async () => undefined);
    const purgeReplicas = vi.fn(async () => undefined);
    const deps = {
      hasReplicaData: vi.fn(async () => true),
      hasAssetData: vi.fn(async () => true),
      listPendingReplicaDocuments: vi.fn(async (accountId: string) =>
        accountId === "account-b"
          ? [{ identity: { accountId, orgId: "org", documentId: "doc" } }]
          : []
      ),
      listPendingAssetUploads: vi.fn(async () => []),
      assertReplicaPurgeAllowed: vi.fn(async () => undefined),
      assertAssetPurgeAllowed: vi.fn(async () => undefined),
      purgeAssets,
      purgeReplicas,
    };

    await expect(
      purgeOfflineCollabAccounts(["account-a", "account-b"], { force: false }, deps)
    ).resolves.toEqual({
      purged: false,
      pendingDocumentCount: 1,
    });
    expect(purgeAssets).not.toHaveBeenCalled();
    expect(purgeReplicas).not.toHaveBeenCalled();

    await expect(
      purgeOfflineCollabAccounts(["account-a", "account-b"], { force: true }, deps)
    ).resolves.toEqual({
      purged: true,
      pendingDocumentCount: 1,
    });
    expect(purgeAssets).toHaveBeenCalledTimes(2);
    expect(purgeReplicas).toHaveBeenCalledTimes(2);
    expect(purgeReplicas).toHaveBeenCalledWith("account-b", true);
  });
});
